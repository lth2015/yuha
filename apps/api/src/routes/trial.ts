import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { claimGuestTrial, openGuestTrial } from '../services/guest-trial.js';

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

  /**
   * POST /v1/trial/claim — a guest who has just signed up keeps their song.
   * Called by the web app right after sign-in, with the guest session it kept.
   * An account only: a guest cannot claim into another guest.
   */
  app.post('/v1/trial/claim', { preHandler: app.requireAuth }, async (req) => {
    const body = z.object({ guestToken: z.string().min(10).max(2000) }).parse(req.body);
    return claimGuestTrial(ctx, { guestToken: body.guestToken, userId: req.user!.id });
  });
}
