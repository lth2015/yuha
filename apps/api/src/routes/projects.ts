import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, Scene } from '@yuha/contracts';
import {
  deleteProject,
  getProjectForUser,
  insertProject,
  listProjects,
  listTracks,
  renameProject,
} from '@yuha/db';

export default async function projectRoutes(app: FastifyInstance) {
  app.get('/v1/projects', { preHandler: app.requireAuth }, async (req) => {
    const rows = await listProjects(req.user!.id);
    return {
      items: rows.map((p) => ({
        projectId: p.id,
        title: p.title,
        scene: p.scene,
        trackCount: p.track_count,
        createdAt: p.created_at.toISOString(),
        updatedAt: p.updated_at.toISOString(),
      })),
    };
  });

  app.post('/v1/projects', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = z.object({ title: z.string().min(1).max(80), scene: Scene }).parse(req.body);
    const project = await insertProject({ ownerId: req.user!.id, title: body.title, scene: body.scene });
    return reply.status(201).send({ projectId: project.id, title: project.title, scene: project.scene });
  });

  app.get('/v1/projects/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const project = await getProjectForUser(id, req.user!.id);
    if (!project) throw new AppError('NOT_FOUND', 'project not found');
    const tracks = await listTracks({ userId: req.user!.id, projectId: id, limit: 50 });
    return {
      projectId: project.id,
      title: project.title,
      scene: project.scene,
      createdAt: project.created_at.toISOString(),
      tracks: tracks.map((t) => ({
        trackId: t.id,
        title: t.title,
        state: t.state,
        mood: t.mood,
        durationSeconds: t.duration_ms / 1000,
        createdAt: t.created_at.toISOString(),
      })),
    };
  });

  /** UI-05: renaming is a local label change and never re-invokes the music model. */
  app.patch('/v1/projects/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ title: z.string().min(1).max(80) }).parse(req.body);
    const updated = await renameProject({ projectId: id, userId: req.user!.id, title: body.title });
    if (!updated) throw new AppError('NOT_FOUND', 'project not found');
    return { projectId: updated.id, title: updated.title };
  });

  app.delete('/v1/projects/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteProject({ projectId: id, userId: req.user!.id });
    if (!ok) throw new AppError('NOT_FOUND', 'project not found');
    return reply.status(204).send();
  });
}
