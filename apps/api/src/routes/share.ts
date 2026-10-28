import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError, type Dedication } from '@yuha/contracts';
import { getMasterAsset, getShareCard, getTrack, upsertShareCard, type TrackRow } from '@yuha/db';
import { VideoBusyError, isJpeg, renderShareVideo } from '../services/share-video.js';
import type { AppContext } from '../context.js';

/**
 * Sharing a song so the post looks like the song (docs/GIFT_AND_SHARE_SPEC.md).
 *
 * The web app is static files behind a CDN with no route to this API, and the
 * crawlers that build link previews (X, Facebook, LINE, Slack…) do not run
 * JavaScript, so every song shared from yuha.studio previewed as the same
 * generic line with no picture. The share link is therefore this API's
 * `/v1/share/songs/:id`:
 *
 *  - a preview crawler gets a small page whose meta tags are the song: its
 *    title (or who it was written for), and the card image the owner's browser
 *    drew and uploaded;
 *  - a person gets a 302 to the song's page.
 *
 * Only a public, playable song is described. Anything else — private, deleted,
 * suspended, unknown — gets the site's own preview and the same redirect, so a
 * shared link to a private song never leaks its title.
 */

/**
 * Link-preview fetchers, by the names they announce. A person's browser is
 * none of these — and an in-app browser must not match either: LINE's adds
 * `Line/13.x` to an ordinary Safari string, Pinterest's adds `Pinterest`, so
 * neither name appears here. LINE's previews are fetched as
 * `facebookexternalhit`, Pinterest's as `Pinterestbot`.
 */
const PREVIEW_BOTS = /(twitterbot|facebookexternalhit|facebot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp\/|skypeuripreview|pinterestbot|redditbot|applebot|googlebot|bingbot|embedly|mastodon|bluesky|iframely)/i;

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;
const CARD_MAX_BYTES = 1_500_000;

const OCCASION_TITLE: Record<Dedication['lang'], (to: string) => string> = {
  zh: (to) => `写给${to}的一首歌`,
  ja: (to) => `${to}に贈る歌`,
  en: (to) => `A song for ${to}`,
};

const OCCASION_LINE: Record<Dedication['lang'], Partial<Record<Dedication['occasion'], string>>> = {
  zh: { birthday: '生日快乐', thanks: '谢谢你', sorry: '对不起', love: '喜欢你', miss: '想你了', farewell: '一路顺风', cheer: '加油' },
  ja: { birthday: 'お誕生日おめでとう', thanks: 'ありがとう', sorry: 'ごめんね', love: '好きです', miss: '会いたいな', farewell: 'またね', cheer: 'がんばれ' },
  en: { birthday: 'Happy birthday', thanks: 'Thank you', sorry: 'I’m sorry', love: 'I love you', miss: 'Missing you', farewell: 'Goodbye, for now', cheer: 'You’ve got this' },
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A public, playable, undeleted song — the only kind a share link describes. */
function shareable(row: TrackRow | undefined | null): row is TrackRow {
  return !!row && !row.deleted_at && row.visibility === 'public' && row.state === 'deliverable';
}

/** Width and height from a PNG's IHDR chunk; null when the bytes are not a PNG. */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature) || buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export default async function shareRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;
  const webOrigin = new URL(ctx.config.PUBLIC_WEB_URL).origin;
  const apiBase = new URL(ctx.config.PUBLIC_API_URL);

  /*
   * Where a person is sent. Built with URL and its origin checked, never by
   * concatenation (CLAUDE.md): the id is a validated uuid, but the check is
   * what makes that not matter.
   */
  const songPage = (id: string) => {
    const url = new URL(`/song/${encodeURIComponent(id)}`, webOrigin);
    if (url.origin !== webOrigin) throw new Error('song page escaped the web origin');
    return url.toString();
  };
  const shareUrl = (id: string) => new URL(`/v1/share/songs/${encodeURIComponent(id)}`, apiBase).toString();
  const fallbackImage = new URL('/brand/og-card.png', webOrigin).toString();

  const idParam = z.object({ id: z.string().uuid() });

  /**
   * PUT /v1/tracks/:id/share-card — the owner's browser uploads the preview
   * image it drew (1200×630 PNG). Replaces the previous one.
   */
  app.put(
    '/v1/tracks/:id/share-card',
    { preHandler: app.requireAuth, bodyLimit: 2_200_000 },
    async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z.object({ png: z.string().min(1).max(2_100_000) }).parse(req.body);
      const track = await getTrack(id);
      if (!track || track.deleted_at || track.owner_id !== req.user!.id) throw new AppError('NOT_FOUND', 'no such song');

      const bytes = Buffer.from(body.png, 'base64');
      const size = pngSize(bytes);
      if (!size) throw new AppError('VALIDATION_FAILED', 'the card must be a PNG');
      if (size.width !== CARD_WIDTH || size.height !== CARD_HEIGHT) {
        throw new AppError('VALIDATION_FAILED', `the card must be ${CARD_WIDTH}×${CARD_HEIGHT}`);
      }
      if (bytes.length > CARD_MAX_BYTES) throw new AppError('VALIDATION_FAILED', 'the card is too large');

      const key = `share-cards/${track.owner_id}/${track.id}.png`;
      const put = await ctx.storage.put({ zone: 'delivery', key, body: bytes, contentType: 'image/png' });
      await upsertShareCard({ trackId: track.id, ownerId: track.owner_id, storageKey: key, byteSize: put.byteSize, sha256: put.sha256 });
      return { ok: true, shareUrl: shareUrl(track.id) };
    },
  );

  /**
   * POST /v1/tracks/:id/share-video — the owner's frames on the song's audio,
   * returned as an MP4 to share as a file. Nothing is stored.
   */
  app.post(
    '/v1/tracks/:id/share-video',
    { preHandler: app.requireAuth, bodyLimit: 12_000_000 },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          start: z.number().min(0),
          duration: z.number().min(3).max(30),
          frames: z
            .array(z.object({ at: z.number().min(0), jpeg: z.string().min(4).max(950_000) }))
            .min(1)
            .max(24),
        })
        .parse(req.body);
      const track = await getTrack(id);
      if (!track || track.deleted_at || track.owner_id !== req.user!.id) throw new AppError('NOT_FOUND', 'no such song');
      if (track.state !== 'deliverable') throw new AppError('TRACK_NOT_DELIVERABLE', 'the song is not playable');
      if (body.start + body.duration > track.duration_ms / 1000 + 0.5) {
        throw new AppError('VALIDATION_FAILED', 'the clip runs past the end of the song');
      }
      const frames = body.frames.map((f) => ({ at: Math.min(f.at, body.duration), jpeg: Buffer.from(f.jpeg, 'base64') }));
      if (frames.some((f) => !isJpeg(f.jpeg))) throw new AppError('VALIDATION_FAILED', 'frames must be JPEG');
      // The first frame is on screen from the first moment, whatever it claimed.
      frames.sort((a, b) => a.at - b.at)[0]!.at = 0;

      const master = await getMasterAsset(track.id);
      if (!master) throw new AppError('TRACK_NOT_DELIVERABLE', 'the song has no audio');
      const audio = await ctx.storage.get('delivery', master.storage_key);
      try {
        const mp4 = await renderShareVideo({ audio, start: body.start, duration: body.duration, frames });
        return reply.header('content-type', 'video/mp4').header('cache-control', 'no-store').send(mp4);
      } catch (err) {
        if (err instanceof VideoBusyError) {
          throw new AppError('RATE_LIMITED', 'another video is being made; try again in a moment', { retryAfterSeconds: 15 });
        }
        throw err;
      }
    },
  );

  /** GET /v1/share/songs/:id — the link people post. */
  app.get('/v1/share/songs/:id', async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return reply.redirect(webOrigin, 302);
    const { id } = parsed.data;
    const ua = String(req.headers['user-agent'] ?? '');
    // The answer depends on who asks, so nothing between here and them may
    // keep it: a CDN that cached a crawler's page would hand it to people.
    reply.header('cache-control', 'private, no-store').header('vary', 'User-Agent');
    if (!PREVIEW_BOTS.test(ua)) return reply.redirect(songPage(id), 302);

    const row = await getTrack(id);
    return sendPreview(reply, id, shareable(row) ? row : null);
  });

  /** GET /v1/share/songs/:id/card.png — the preview image, while the song is public. */
  app.get('/v1/share/songs/:id/card.png', async (req, reply) => {
    const parsed = idParam.safeParse(req.params);
    const row = parsed.success ? await getTrack(parsed.data.id) : null;
    const card = shareable(row) ? await getShareCard(row.id) : null;
    if (!card) return reply.redirect(fallbackImage, 302);
    const bytes = await ctx.storage.get('delivery', card.storage_key);
    return reply
      .header('content-type', 'image/png')
      // Not kept by any cache: unpublishing has to take the card down with
      // the song, and a shared cache would go on serving the name on it.
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(bytes);
  });

  async function sendPreview(reply: FastifyReply, id: string, row: TrackRow | null) {
    let title = 'YUHA — 让心动，有回声。';
    let description = '描述一种心情，创作一段属于此刻的音乐。';
    let image = fallbackImage;
    if (row) {
      const d = row.dedication;
      title = d ? `${OCCASION_TITLE[d.lang](d.to)}《${row.title}》` : `《${row.title}》 — YUHA`;
      const line = d ? OCCASION_LINE[d.lang][d.occasion] : undefined;
      description = d ? [line, d.note].filter(Boolean).join(' · ') || title : (row.styles ?? []).join(' / ') || description;
      const card = await getShareCard(row.id);
      if (card) {
        const v = createHash('sha256').update(card.sha256).digest('hex').slice(0, 10);
        image = `${new URL(`/v1/share/songs/${encodeURIComponent(row.id)}/card.png`, apiBase).toString()}?v=${v}`;
      }
    }
    const here = shareUrl(id);
    const target = songPage(id);
    const meta = [
      ['og:type', 'music.song'],
      ['og:site_name', 'YUHA'],
      ['og:title', title],
      ['og:description', description],
      ['og:image', image],
      ['og:image:width', String(CARD_WIDTH)],
      ['og:image:height', String(CARD_HEIGHT)],
      // The share link itself, not the song page: Facebook re-scrapes og:url,
      // and the song page is the static app whose meta is the generic line.
      ['og:url', here],
    ]
      .map(([p, c]) => `<meta property="${p}" content="${escapeHtml(c!)}">`)
      .concat([
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:title" content="${escapeHtml(title)}">`,
        `<meta name="twitter:description" content="${escapeHtml(description)}">`,
        `<meta name="twitter:image" content="${escapeHtml(image)}">`,
      ])
      .join('\n');
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex">
${meta}
</head><body><a href="${escapeHtml(target)}">${escapeHtml(title)}</a></body></html>`;
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('x-robots-tag', 'noindex')
      .send(html);
  }
}
