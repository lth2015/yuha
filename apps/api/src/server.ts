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
import fileRoutes from './routes/files.js';
import generationRoutes from './routes/generations.js';
import projectRoutes from './routes/projects.js';
import publicRoutes from './routes/public.js';
import rightsRoutes from './routes/rights.js';
import trackRoutes from './routes/tracks.js';

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
    },
    trustProxy: true,
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
  await app.register(trackRoutes, { ctx });
  await app.register(fileRoutes, { ctx });
  await app.register(billingRoutes, { ctx });
  await app.register(rightsRoutes, { ctx });
  await app.register(adminRoutes, { ctx });

  return app;
}
