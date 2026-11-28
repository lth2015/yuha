import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { applyLyricProposal, readLyricProposal, requestLyricProposal, resumeLyricProposals } from '../services/lyric-proposal.js';

/**
 * "Align it again" for one song (services/lyric-proposal.ts).
 *
 * POST asks; the aligner answers in the background, one song at a time, and
 * GET reads the answer. The owner can apply the server's stored result by ID.
 */
export default async function lyricProposalRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;
  const idParam = z.object({ id: z.string().uuid() });
  // Requests a stopped process left queued are picked up when this one starts.
  app.addHook('onReady', async () => {
    void resumeLyricProposals(ctx, (msg, err) => app.log.warn({ err }, msg));
  });

  app.post('/v1/tracks/:id/lyric-proposal', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const view = await requestLyricProposal(ctx, id, req.user!.id, (msg, err) => req.log.warn({ err, trackId: id }, msg));
    return reply.code(202).send(view);
  });

  app.get('/v1/tracks/:id/lyric-proposal', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const view = await readLyricProposal(ctx, id, req.user!.id, (msg, err) => req.log.warn({ err, trackId: id }, msg));
    return reply.header('cache-control', 'no-store').send(view ?? { status: 'none' });
  });

  app.post('/v1/tracks/:id/lyric-proposal/:proposalId/apply', { preHandler: app.requireAuth }, async (req) => {
    const { id, proposalId } = idParam.extend({ proposalId: z.string().uuid() }).parse(req.params);
    return applyLyricProposal(id, req.user!.id, proposalId);
  });
}
