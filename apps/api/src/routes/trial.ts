import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { openGuestTrial } from '../services/guest-trial.js';

/**
 * POST /v1/trial/start — a session for one song without an account
 * (docs/GROWTH_SPEC.md, part three). The same two affirmations an account
 * gives before its first song; the limits are in services/guest-trial.ts.
 */
const startBody = z.object({
  /** The random id this browser made and keeps; hashed before it is stored. */
  deviceId: z.string().uuid(),
  ageConfirmed: z.literal(true),
  termsAccepted: z.literal(true),
});

export default async function trialRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;
  app.post(
    '/v1/trial/start',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = startBody.parse(req.body);
      const opened = await openGuestTrial(ctx, { deviceId: body.deviceId, ip: req.ip });
      return reply.status(201).send({ token: opened.token, expiresAt: opened.expiresAt.toISOString(), userId: opened.userId });
    },
  );
}
