import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientErrorReport, previewReport } from '@yuha/contracts';
import { trackEvent } from '@yuha/db';
import type { AppContext } from '../context.js';

/**
 * Where browser crashes go.
 *
 * The error boundary added in the craft round is an improvement and a
 * regression at the same time: before it, a render throw produced a blank page
 * and a user who complained, which is how `/pricing` was eventually found to
 * have been broken for eight days. After it, the same throw produces a calm
 * panel and — with nothing recording it — silence. Graceful failure is silent
 * failure unless something writes it down.
 *
 * Unauthenticated on purpose: a crash on the sign-in screen is exactly the one
 * worth hearing about, and requiring a session would lose it. Rate limiting is
 * the only gate, as with rights cases.
 *
 * Self-hosted rather than shipped to a third-party collector. Sending user
 * data to an outside service is a decision about this product's users, and the
 * existing `analytics_events` table already carries the §11.1 contract these
 * rows must obey.
 */
const visitReport = z.object({
  visitorId: z.string().uuid(),
  path: z.string().min(1).max(500).startsWith('/'),
  refHost: z
    .string()
    .max(253)
    .regex(/^[a-z0-9.-]+$/i)
    .optional(),
});

/**
 * The page, not the thing on it. Query string and fragment go (either can
 * carry a token), and any segment that looks like an identifier becomes
 * `:id`: a song's id is, for a song shared by link, the key that opens it,
 * and an analytics row is no place to keep keys. What the dashboard needs is
 * "the song page", which this still says.
 */
function visitPath(raw: string): string {
  const bare = raw.split('?')[0]!.split('#')[0]!;
  return bare
    .split('/')
    .map((seg) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^[A-Za-z0-9_-]{16,}$/.test(seg) ? ':id' : seg))
    .join('/')
    .slice(0, 200);
}

export default async function telemetryRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  app.post(
    '/v1/client-errors',
    {
      config: {
        // A crash loop can re-render and re-report faster than a human ever
        // would. The client dedupes and caps per page load; this is the floor
        // under that, per IP.
        rateLimit: { max: 30, timeWindow: '5 minutes' },
      },
    },
    async (req, reply) => {
      const body = clientErrorReport.parse(req.body);

      await trackEvent({
        name: 'client_error',
        // No user ref. This endpoint takes no session, and a crash groups by
        // message and route rather than by who hit it.
        userRef: null,
        props: {
          message: body.message,
          route: body.route,
          component: body.component,
          lang: body.lang,
        },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch((err) => {
        // Not `.catch(() => undefined)`. A failed write must not turn a crash
        // report into a 500 — but swallowing it without a trace is how the
        // licence button stayed dead for eight days. The browser gets its 202
        // either way; the operator gets a line either way too.
        req.log.error({ err }, 'could not record a client error report');
      });

      // 202 and an empty body: the browser is mid-crash and has nothing useful
      // to do with a response. Recording must never become a second failure.
      return reply.status(202).send();
    },
  );

  /**
   * POST /v1/previews — ten seconds of a song were actually heard.
   *
   * `reporting.ts` has queried `analytics_events` for `preview_10s` since the
   * activation metric was written, and `player.tsx` has detected the moment
   * for just as long. Nothing ever joined the two, so day-one activation has
   * been reporting as not computable while the data to compute it went
   * nowhere. This is the join.
   *
   * `optionalAuth`, not `requireAuth`: the showcase on the landing page plays
   * to people with no account, and a visitor who listens to a whole song is
   * worth counting even though the activation query — which asks what a
   * *registered* user did in their first 24 hours — will not count them. A
   * null `user_ref` is the honest record of "somebody, we do not know who".
   */
  app.post(
    '/v1/previews',
    {
      preHandler: app.optionalAuth,
      config: {
        // One per song per page load on the client. This is the floor under a
        // client that has lost its mind, per IP, and is generous enough that a
        // person listening through a playlist never meets it.
        rateLimit: { max: 120, timeWindow: '5 minutes' },
      },
    },
    async (req, reply) => {
      const body = previewReport.parse(req.body);

      await trackEvent({
        name: 'preview_10s',
        userRef: req.user?.id ?? null,
        props: { track_id: body.trackId },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch((err) => {
        req.log.error({ err }, 'could not record a preview_10s event');
      });

      return reply.status(202).send();
    },
  );

  /**
   * POST /v1/visits — a page was shown. The dashboard's visit numbers.
   *
   * Self-hosted and anonymous on purpose. The browser sends a random visitor
   * id it made up and keeps in localStorage — not the account id, not an IP,
   * not a fingerprint — plus the path (without query string, which can carry
   * tokens) and, when it came from another site, only that site's host.
   * Nothing leaves this server: no third-party collector is involved.
   *
   * Staff browsing is marked internal, along with all demo traffic, so the
   * people running the service do not inflate its numbers. A visitor id that
   * is not a UUID is refused rather than stored: the column is a pseudonymous
   * reference, and a free-text field there would become a place to put an
   * email address.
   */
  app.post(
    '/v1/visits',
    {
      preHandler: app.optionalAuth,
      config: {
        // One per route change on the client. Generous enough for someone
        // clicking around quickly; a floor under a client that loops.
        rateLimit: { max: 120, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const body = visitReport.parse(req.body);
      const staff = req.user?.role === 'admin' || req.user?.role === 'support';
      await trackEvent({
        name: 'page_view',
        userRef: body.visitorId,
        props: {
          path: visitPath(body.path),
          signed_in: Boolean(req.user),
          ...(body.refHost ? { ref_host: body.refHost } : {}),
        },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo || staff,
      }).catch((err) => {
        req.log.error({ err }, 'could not record a page_view event');
      });
      return reply.status(202).send();
    },
  );
}
