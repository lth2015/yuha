import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import {
  AppError,
  giftEventRequest,
  giftInvitationPatch,
  giftInvitationRequest,
  type PublicGiftView,
} from '@yuha/contracts';
import {
  getTrackForUser,
  insertGiftInvitation,
  listGiftInvitations,
  openGiftInvitation,
  queryOne,
  revokeGiftInvitation,
  trackEvent,
  updateGiftInvitation,
  type GiftInvitationRow,
} from '@yuha/db';
import { checkPrompt, checkTitle } from '@yuha/providers';
import type { AppContext } from '../context.js';

/**
 * Music Gift Invitation (docs/GIFT_INVITATION_PLAN.md, PRD V1.1).
 *
 * Owner routes make, list, change and revoke invitations for their own songs.
 * Public routes open one by its token, without an account: the words and the
 * song, never an id, a person or a storage path; audio as a short-lived signed
 * address issued only while the invitation stands. Every way a token can be
 * wrong — unknown, revoked, expired, song deleted — answers the same 404, so
 * the answer says nothing about which. The token never reaches a log line
 * (log-redaction.ts) or an analytics row.
 */

/** Same rules as a dedication (services/generation.ts screenDedication): names as titles, the letter as a description. */
function screen(fields: { recipientName?: string; senderName?: string; message?: string }) {
  const checks = [
    ...(fields.recipientName ? [{ field: 'recipientName', result: checkTitle(fields.recipientName) }] : []),
    ...(fields.senderName ? [{ field: 'senderName', result: checkTitle(fields.senderName) }] : []),
    ...(fields.message ? [{ field: 'message', result: checkPrompt(fields.message) }] : []),
  ];
  for (const { field, result } of checks) {
    if (!result.allowed) {
      throw new AppError('PROMPT_BLOCKED', `${field} rejected: ${result.reason}`, {
        reason: result.reason,
        hintKey: result.hintKey,
        appealable: result.appealable,
        field,
      });
    }
  }
}

const ownerView = (g: GiftInvitationRow) => ({
  id: g.id,
  recipientName: g.recipient_name ?? '',
  senderName: g.sender_name ?? '',
  message: g.message ?? '',
  theme: g.theme,
  status: g.status,
  createdAt: g.created_at.toISOString(),
  revokedAt: g.revoked_at ? g.revoked_at.toISOString() : null,
});

const notFound = () => new AppError('NOT_FOUND', 'this invitation is not available');

/** No caching anywhere and no index: the link is the only key. */
function privately(reply: FastifyReply) {
  reply.header('cache-control', 'private, no-store');
  reply.header('x-robots-tag', 'noindex, nofollow');
}

/** Same crawler test as page views (routes/telemetry.ts): a link preview is not a recipient. */
const CRAWLER = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|uptime/i;

export default async function giftRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;
  const giftUrl = (token: string) => new URL(`/gift/${token}`, ctx.config.PUBLIC_WEB_URL).toString();

  app.post(
    '/v1/tracks/:id/gifts',
    { preHandler: app.requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour', keyGenerator: (req) => req.user?.id ?? req.ip } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const track = await getTrackForUser(id, req.user!.id);
      if (!track || track.state !== 'deliverable') throw new AppError('NOT_FOUND', 'track not found');
      const parsed = giftInvitationRequest.safeParse(req.body);
      if (!parsed.success) throw new AppError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'invalid invitation');
      screen(parsed.data);
      const { row, token } = await insertGiftInvitation({ trackId: track.id, ownerId: req.user!.id, ...parsed.data });
      await trackEvent({
        name: 'gift_created',
        userRef: req.user!.id,
        props: { gift: row.id, theme: row.theme, has_message: Boolean(row.message) },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch(() => undefined);
      // The link, once: only its hash is kept.
      return reply.status(201).send({ ...ownerView(row), url: giftUrl(token) });
    },
  );

  app.get('/v1/tracks/:id/gifts', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const track = await getTrackForUser(id, req.user!.id);
    if (!track) throw new AppError('NOT_FOUND', 'track not found');
    return { items: (await listGiftInvitations(track.id, req.user!.id)).map(ownerView) };
  });

  app.patch('/v1/gifts/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = giftInvitationPatch.safeParse(req.body);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'invalid invitation');
    screen(parsed.data);
    const out = await updateGiftInvitation(id, req.user!.id, parsed.data);
    if (out === 'not_found') throw new AppError('NOT_FOUND', 'invitation not found');
    if (out === 'revoked') throw new AppError('CONFLICT', 'a revoked invitation cannot be changed');
    return { updated: true };
  });

  app.post('/v1/gifts/:id/revoke', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    if (!(await revokeGiftInvitation(id, req.user!.id))) throw new AppError('NOT_FOUND', 'invitation not found');
    return { revoked: true };
  });

  // ---- public: opened by its token, without an account ------------------

  app.get('/v1/gift/:token', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    privately(reply);
    const { token } = req.params as { token: string };
    const g = await openGiftInvitation(token);
    if (!g) throw notFound();
    const styles = typeof g.styles === 'string' ? (JSON.parse(g.styles) as string[]) : (g.styles ?? []);
    const view: PublicGiftView = {
      recipientName: g.recipient_name ?? '',
      senderName: g.sender_name ?? '',
      message: g.message ?? '',
      theme: g.theme,
      song: {
        title: g.title,
        durationSeconds: Number(g.duration_ms) / 1000,
        coverSeed: g.cover_seed,
        styles,
        vocalMode: g.vocal_mode,
        lyrics: g.vocal_mode === 'instrumental' ? null : g.lyrics,
      },
    };
    return view;
  });

  app.get('/v1/gift/:token/audio', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    privately(reply);
    const { token } = req.params as { token: string };
    const g = await openGiftInvitation(token);
    if (!g) throw notFound();
    const master = await queryOne<{ storage_key: string }>(
      `SELECT storage_key FROM asset_versions WHERE track_id = ? AND kind = 'master' LIMIT 1`,
      [g.track_id],
    );
    if (!master) throw notFound();
    // A short-lived address, re-asked for by the page when it lapses; never a permanent link to the master.
    const signed = await ctx.storage.signedUrl({ zone: 'delivery', key: master.storage_key, ttlSeconds: ctx.config.DOWNLOAD_URL_TTL_SECONDS });
    return { url: signed.url, expiresAt: new Date(Date.now() + ctx.config.DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString() };
  });

  app.post('/v1/gift/:token/events', { config: { rateLimit: { max: 60, timeWindow: '5 minutes' } } }, async (req, reply) => {
    privately(reply);
    const parsed = giftEventRequest.safeParse(req.body);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'unknown event');
    const { token } = req.params as { token: string };
    const g = await openGiftInvitation(token);
    // A preview crawler, or a link that does not open: accepted and not counted.
    if (!g || CRAWLER.test(String(req.headers['user-agent'] ?? ''))) return reply.status(202).send({ recorded: false });
    const visitor = createHash('sha256').update(`gift-visitor:${parsed.data.visitor}`).digest('hex').slice(0, 32);
    const name = `gift_${parsed.data.name}`;
    // Once per visitor, invitation and event a day (JST): a refresh is not a second visit.
    const seen = await queryOne(
      `SELECT id FROM analytics_events
        WHERE name = ? AND JSON_UNQUOTE(JSON_EXTRACT(props, '$.gift')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(props, '$.visitor')) = ?
          AND occurred_at >= (TIMESTAMP(DATE(UTC_TIMESTAMP(3) + INTERVAL 9 HOUR)) - INTERVAL 9 HOUR)
        LIMIT 1`,
      [name, g.id, visitor],
    );
    if (!seen) {
      await trackEvent({
        name,
        userRef: null,
        props: { gift: g.id, visitor },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch(() => undefined);
    }
    return reply.status(202).send({ recorded: !seen });
  });
}
