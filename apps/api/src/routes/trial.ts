import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listTracks } from '@yuha/db';
import { AppError } from '@yuha/contracts';
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
   * GET /v1/trial/song — which song is this guest's trial, if it is made.
   *
   * A guest who left while it was being made, and whose browser therefore
   * never saw it finish, had no way back to it: `/v1/jobs` lists open jobs
   * only, and a guest has no library (Codex UX audit, UX-01). This answers
   * that one question and nothing else; the list stays closed to guests.
   */
  app.get('/v1/trial/song', { preHandler: app.requireAuth, config: { guestAllowed: true } }, async (req) => {
    if (req.user!.role !== 'guest') throw new AppError('FORBIDDEN', 'only a trial has a trial song');
    const [song] = await listTracks({ userId: req.user!.id, limit: 1 });
    return { trackId: song?.id ?? null };
  });

  /**
   * POST /v1/trial/claim — the account signed in now takes the song made on
   * this browser before it signed in. Only when the person says so
   * (components/TrialClaimAsk.tsx), and only once the account has confirmed
   * its own age and terms: the guest's confirmation was the guest's.
   * An account only: a guest cannot claim into another guest.
   */
  app.post('/v1/trial/claim', { preHandler: app.requireAgeConfirmed }, async (req) => {
    const body = z.object({ guestToken: z.string().min(10).max(2000) }).parse(req.body);
    return claimGuestTrial(ctx, { guestToken: body.guestToken, userId: req.user!.id });
  });
}
