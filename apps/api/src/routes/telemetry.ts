import type { FastifyInstance } from 'fastify';
import { clientErrorReport } from '@yuha/contracts';
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
}
