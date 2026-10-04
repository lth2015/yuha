import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuthAdapter } from './auth/index.js';
import type { AppContext } from './context.js';
import authPlugin from './plugins/auth.js';
import errorPlugin from './plugins/errors.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import billingRoutes from './routes/billing.js';
import exploreRoutes from './routes/explore.js';
import marketRoutes from './routes/market.js';
import fileRoutes from './routes/files.js';
import generationRoutes from './routes/generations.js';
import projectRoutes from './routes/projects.js';
import publicRoutes from './routes/public.js';
import rightsRoutes from './routes/rights.js';
import telemetryRoutes from './routes/telemetry.js';
import trackRoutes from './routes/tracks.js';

import { redactUrlSecrets } from './log-redaction.js';

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.config.LOG_LEVEL,
      // SEC-06: prompts, tokens, cookies and card-ish fields never reach the log.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["stripe-signature"]',
          'req.body.prompt',
          'body.prompt',
          '*.apiKey',
          '*.secret',
        ],
        censor: '[redacted]',
      },
      /*
       * `redact.paths` works on object paths, and the thing that leaked is
       * inside a string: the signed download url the local storage adapter
       * serves. Dropping `req.url` wholesale would redact a request log into
       * uselessness, so the query is cleaned and the route kept.
       */
      serializers: {
        req(request: { method: string; url: string; id?: unknown }) {
          return { method: request.method, url: redactUrlSecrets(request.url), id: request.id };
        },
      },
    },
    /*
     * One hop, not "trust anything that says so".
     *
     * `true` makes Fastify take the LEFTMOST X-Forwarded-For entry as
     * `req.ip`, and nginx uses `$proxy_add_x_forwarded_for`, which appends —
     * so a header the client invented survives in that position. Every per-IP
     * rate limit in this app keys on `req.ip`, including the one on
     * `POST /v1/rights-cases`, which is unauthenticated by design and whose own
     * comment calls rate limiting "the only gate". Filing a case suspends the
     * named track immediately (SEC-10), so a forged header turned 5 complaints
     * an hour into unlimited, and an unauthenticated caller could read 12 real
     * track ids from `GET /v1/explore` and take every one of them down.
     *
     * The value below names which peers may be believed: loopback and the
     * private ranges, which is where the nginx in front of this app sits and
     * nowhere a request from the internet can originate. `req.ip` then becomes
     * the rightmost address that is NOT one of those — the one nginx itself
     * observed — and a client-invented entry further left is ignored.
     *
     * Never back to `true`. If a second proxy is ever put in front, it has to
     * be added here rather than trusted by assertion.
     */
    trustProxy: 'loopback, linklocal, uniquelocal',
    bodyLimit: 1_000_000,
  });

  await app.register(errorPlugin);
  await app.register(cors, {
    origin: [ctx.config.PUBLIC_WEB_URL],
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key'],
  });
  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });

  /**
   * Stripe signature verification needs the exact bytes that were sent, so the
   * webhook route keeps its raw body instead of being parsed to an object
   * (PAY-04). Every other JSON route uses the normal parser.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      if (req.url.startsWith('/v1/webhooks/')) {
        done(null, body);
        return;
      }
      if (body.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  const adapter = createAuthAdapter(ctx.config);
  await app.register(authPlugin, { adapter });

  await app.register(publicRoutes, { ctx });
  await app.register(authRoutes, { ctx, adapter });
  await app.register(projectRoutes);
  await app.register(generationRoutes, { ctx });
  await app.register(exploreRoutes, { ctx });
  await app.register(marketRoutes, { ctx });
  await app.register(trackRoutes, { ctx });
  await app.register(fileRoutes, { ctx });
  await app.register(billingRoutes, { ctx });
  await app.register(rightsRoutes, { ctx });
  await app.register(telemetryRoutes, { ctx });
  await app.register(adminRoutes, { ctx });

  return app;
}
