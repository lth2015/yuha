import type { FastifyInstance } from 'fastify';
import { AppError, IDEMPOTENCY_HEADER, idempotencyKeySchema } from '@loopscene/contracts';
import type { AppContext } from '../context.js';
import { createLicenseCheckout, creatorEarnings } from '../services/market.js';

/**
 * Market routes: licensing songs between users and the creator earnings view.
 */
export default async function marketRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  app.post(
    '/v1/market/tracks/:id/license',
    { preHandler: app.requireAgeConfirmed },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rawKey = req.headers[IDEMPOTENCY_HEADER];
      const parsedKey = idempotencyKeySchema.safeParse(Array.isArray(rawKey) ? rawKey[0] : rawKey);
      if (!parsedKey.success) {
        throw new AppError('VALIDATION_FAILED', `a valid ${IDEMPOTENCY_HEADER} header is required`);
      }
      const result = await createLicenseCheckout(ctx, {
        userId: req.user!.id,
        trackId: id,
        idempotencyKey: parsedKey.data,
      });
      return reply.status(202).send(result);
    },
  );

  /** The signed-in creator's own earnings — nobody else's (SEC-01). */
  app.get('/v1/market/earnings', { preHandler: app.requireAuth }, async (req) => {
    const summary = await creatorEarnings(req.user!.id);
    return {
      currency: 'usd',
      creatorShareRate: ctx.config.MARKET_CREATOR_SHARE,
      ...summary,
    };
  });
}
