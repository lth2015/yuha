import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@yuha/contracts';
import { getTrack, listSceneMvsForTrack } from '@yuha/db';
import type { AppContext } from '../context.js';
import { removeSceneMv } from '../services/scene-mv-cleanup.js';
import {
  SCENE_MV_STYLES,
  assertSceneMvAllowed,
  cancelOwnSceneMv,
  downloadSceneMv,
  draftSceneMv,
  editSceneMvShots,
  startSceneMv,
  viewSceneMv,
} from '../services/scene-mv.js';

/**
 * The AI scene MV, for the song's owner (docs/agents/CODEX_SCENE_MV_UI.md has
 * the contract the page is built against). Not the owner reads as 404, and
 * the feature being off as 503 SERVICE_DISABLED, for every route.
 */
export default async function sceneMvRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;
  const idParam = z.object({ id: z.string().uuid() });
  const draftBody = z.object({
    clipStart: z.number().min(0),
    clipEnd: z.number().positive(),
    style: z.enum(SCENE_MV_STYLES),
    description: z.string().max(300).nullable().optional(),
  });
  const shotsBody = z.object({ shots: z.array(z.string().trim().min(1).max(300)).min(1).max(4) });
  const guard = async (req: { user?: { role?: string } | null }) => assertSceneMvAllowed(ctx, req.user?.role);

  app.post('/v1/tracks/:id/scene-mvs', { preHandler: app.requireAuth }, async (req, reply) => {
    await guard(req);
    const { id } = idParam.parse(req.params);
    return reply.code(201).send(await draftSceneMv(ctx, req.user!.id, id, draftBody.parse(req.body)));
  });

  app.get('/v1/tracks/:id/scene-mvs', { preHandler: app.requireAuth }, async (req, reply) => {
    await guard(req);
    const { id } = idParam.parse(req.params);
    const track = await getTrack(id);
    if (!track || track.deleted_at || track.owner_id !== req.user!.id) throw new AppError('NOT_FOUND', 'no such song');
    const items = [];
    for (const row of await listSceneMvsForTrack(id)) {
      const v = await viewSceneMv(row.id, req.user!.id);
      if (v) items.push(v);
    }
    return reply.header('cache-control', 'no-store').send({ items });
  });

  app.get('/v1/scene-mvs/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    await guard(req);
    const { id } = idParam.parse(req.params);
    const v = await viewSceneMv(id, req.user!.id);
    if (!v) throw new AppError('NOT_FOUND', 'no such scene MV');
    return reply.header('cache-control', 'no-store').send(v);
  });

  app.patch('/v1/scene-mvs/:id', { preHandler: app.requireAuth }, async (req) => {
    await guard(req);
    const { id } = idParam.parse(req.params);
    return editSceneMvShots(id, req.user!.id, shotsBody.parse(req.body).shots);
  });

  app.post('/v1/scene-mvs/:id/start', { preHandler: app.requireAuth }, async (req, reply) => {
    await guard(req);
    const { id } = idParam.parse(req.params);
    return reply.code(202).send(await startSceneMv(ctx, id, req.user!.id));
  });

  app.post('/v1/scene-mvs/:id/cancel', { preHandler: app.requireAuth }, async (req) => {
    await guard(req);
    const { id } = idParam.parse(req.params);
    return cancelOwnSceneMv(ctx, id, req.user!.id);
  });

  app.get('/v1/scene-mvs/:id/download', { preHandler: app.requireAuth }, async (req, reply) => {
    await guard(req);
    const { id } = idParam.parse(req.params);
    return reply.header('cache-control', 'no-store').send(await downloadSceneMv(ctx, id, req.user!.id));
  });

  app.delete('/v1/scene-mvs/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    await guard(req);
    const { id } = idParam.parse(req.params);
    if (!(await viewSceneMv(id, req.user!.id))) throw new AppError('NOT_FOUND', 'no such scene MV');
    await removeSceneMv(ctx.storage, id, req.log, ctx.video);
    return reply.code(204).send();
  });
}
