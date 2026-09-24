import type { FastifyInstance } from 'fastify';
import { AppError, IDEMPOTENCY_HEADER, idempotencyKeySchema } from '@yuha/contracts';
import type { AppContext } from '../context.js';
import { createLicenseCheckout } from '../services/market.js';

/**
 * Market routes: licensing a song for use by another user. The platform
 * sells its own service, so there is no creator revenue split.
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

}
