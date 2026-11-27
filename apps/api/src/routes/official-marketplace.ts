import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, BGM_GENRES, officialBgmAction, officialBgmCatalogEdit, officialBgmPublishAll, officialBgmSaleRightsDecision } from '@yuha/contracts';
import { listOfficialBgm } from '@yuha/db';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  canBrowseOfficialBgm, changeOfficialBgm, decideOfficialBgmSaleRights, editOfficialBgmCatalog, officialBgmAdminItem, officialBgmCover, officialBgmItem,
  officialBgmPreview, publishAllOfficialBgm,
} from '../services/official-marketplace.js';

import officialBgmUploadRoutes from './official-bgm-upload.js';

const idParam = z.object({ id: z.string().uuid() });
const query = z.object({
  genre: z.enum(BGM_GENRES).optional(),
  q: z.string().trim().max(120).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const PAGE_SIZE = 30;

export default async function officialMarketplaceRoutes(app: FastifyInstance, { ctx }: { ctx: AppContext }) {
  const admin = app.requireRole(['admin']);
  await app.register(officialBgmUploadRoutes, { ctx });
  const assertBrowsable = (req: FastifyRequest) => {
    if (!canBrowseOfficialBgm(ctx.config.OFFICIAL_BGM_MARKETPLACE, req.user?.role)) {
      throw new AppError('NOT_FOUND', 'BGM catalogue is unavailable');
    }
  };

  app.get('/v1/marketplace/bgm', { preHandler: app.optionalAuth }, async (req, reply) => {
    assertBrowsable(req);
    const p = query.parse(req.query);
    const rows = await listOfficialBgm({ genre: p.genre, search: p.q, offset: p.offset, limit: PAGE_SIZE + 1 });
    return reply.header('cache-control', 'no-store').send({
      items: rows.slice(0, PAGE_SIZE).map(officialBgmItem),
      nextOffset: rows.length > PAGE_SIZE ? p.offset + PAGE_SIZE : null,
    });
  });

  app.get('/v1/marketplace/bgm/:id/preview', { preHandler: app.optionalAuth }, async (req, reply) => {
    assertBrowsable(req);
    return reply.header('cache-control', 'no-store').send(await officialBgmPreview(ctx, idParam.parse(req.params).id, false));
  });

  app.get('/v1/admin/marketplace/bgm', { preHandler: admin }, async (req, reply) => {
    const p = query.parse(req.query);
    const rows = await listOfficialBgm({ admin: true, genre: p.genre, search: p.q, offset: p.offset, limit: PAGE_SIZE + 1 });
    return reply.header('cache-control', 'no-store').send({
      items: rows.slice(0, PAGE_SIZE).map(officialBgmAdminItem),
      nextOffset: rows.length > PAGE_SIZE ? p.offset + PAGE_SIZE : null,
    });
  });

  app.get('/v1/admin/marketplace/bgm/:id/preview', { preHandler: admin }, async (req, reply) =>
    reply.header('cache-control', 'no-store').send(await officialBgmPreview(ctx, idParam.parse(req.params).id, true)),
  );

  app.get('/v1/admin/marketplace/bgm/:id/cover', { preHandler: admin }, async (req, reply) =>
    reply.header('cache-control', 'no-store').send(await officialBgmCover(ctx, idParam.parse(req.params).id)),
  );

  app.post('/v1/admin/marketplace/bgm/:id/catalog', { preHandler: admin }, async (req, reply) =>
    reply.header('cache-control', 'no-store').send(
      await editOfficialBgmCatalog(idParam.parse(req.params).id, req.user!.id, officialBgmCatalogEdit.parse(req.body))),
  );

  app.post('/v1/admin/marketplace/bgm/:id/sale-rights', { preHandler: admin }, async (req, reply) =>
    reply.header('cache-control', 'no-store').send(
      await decideOfficialBgmSaleRights(idParam.parse(req.params).id, req.user!.id, officialBgmSaleRightsDecision.parse(req.body))),
  );

  app.post('/v1/admin/marketplace/bgm/publish-all', { preHandler: admin }, async (req, reply) =>
    reply.header('cache-control', 'no-store').send(
      await publishAllOfficialBgm(ctx, req.user!.id, officialBgmPublishAll.parse(req.body).reason)),
  );

  app.post('/v1/admin/marketplace/bgm/:id/state', { preHandler: admin }, async (req, reply) =>
    reply.header('cache-control', 'no-store').send(await changeOfficialBgm(ctx, idParam.parse(req.params).id, req.user!.id, officialBgmAction.parse(req.body))),
  );
}
