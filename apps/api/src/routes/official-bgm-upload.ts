import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, OFFICIAL_BGM_COVER_BYTES, OFFICIAL_BGM_MASTER_BYTES, officialBgmUploadFields } from '@yuha/contracts';
import type { AppContext } from '../context.js';
import { importInputForBgmTrack, importOfficialBgm } from '../services/official-bgm-import.js';

const multipart = /^multipart\/form-data\b/i;
const maxFields = 64 * 1024;
const maxUpload = OFFICIAL_BGM_MASTER_BYTES + OFFICIAL_BGM_COVER_BYTES + maxFields * 2;

/** Content parsing is encapsulated here so other marketplace routes stay JSON-only. */
export default async function officialBgmUploadRoutes(app: FastifyInstance, { ctx }: { ctx: AppContext }) {
  const admin = app.requireRole(['admin']);
  let uploadActive = false;
  const slots = new WeakMap<FastifyRequest, { processing: boolean; release: () => void }>();

  app.addContentTypeParser(multipart, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.post('/v1/admin/marketplace/bgm/import', {
    bodyLimit: maxUpload,
    async onRequest(req, reply) {
      await admin(req, reply);
      if (req.raw.aborted || req.raw.destroyed || reply.raw.destroyed) {
        reply.hijack();
        return;
      }
      if (uploadActive) throw new AppError('CONFLICT', 'another BGM upload is processing; try again when it finishes');
      uploadActive = true;
      const slot = {
        processing: false,
        release() {
          clearTimeout(deadline);
          if (slots.delete(req)) uploadActive = false;
        },
      };
      const deadline = setTimeout(() => {
        if (!slot.processing) {
          req.raw.destroy();
          slot.release();
        }
      }, 180_000);
      deadline.unref();
      slots.set(req, slot);
      const releaseBeforeHandler = () => { if (!slot.processing) slot.release(); };
      reply.raw.once('close', releaseBeforeHandler);
      reply.raw.once('finish', releaseBeforeHandler);
    },
  }, async (req, reply) => {
    const slot = slots.get(req)!;
    slot.processing = true;
    try {
      const type = req.headers['content-type'] ?? '';
      if (!Buffer.isBuffer(req.body) || !multipart.test(type)) {
        throw new AppError('VALIDATION_FAILED', 'expected a multipart BGM upload');
      }
      const bytes = new Uint8Array(req.body.buffer as ArrayBuffer, req.body.byteOffset, req.body.length);
      const form = await new Response(bytes, { headers: { 'content-type': type } }).formData().catch(() => null);
      const fields = form?.get('fields');
      const master = form?.get('master');
      const cover = form?.get('cover');
      if (!form || typeof fields !== 'string' || fields.length > maxFields ||
          !(master instanceof File) || master.size > OFFICIAL_BGM_MASTER_BYTES ||
          (cover !== null && (!(cover instanceof File) || cover.size > OFFICIAL_BGM_COVER_BYTES)) ||
          [...form.keys()].some((key) => !['fields', 'master', 'cover'].includes(key) || form.getAll(key).length !== 1)) {
        throw new AppError('VALIDATION_FAILED', 'upload one master, its catalogue record and an optional cover');
      }
      let decoded: unknown;
      try { decoded = JSON.parse(fields); } catch { throw new AppError('VALIDATION_FAILED', 'invalid catalogue record'); }
      const { track } = officialBgmUploadFields.parse(decoded);
      if (Boolean(cover) !== Boolean(track.provenance.coverFilename)) {
        throw new AppError('VALIDATION_FAILED', 'the cover does not match the manifest');
      }
      const result = await importOfficialBgm(ctx, importInputForBgmTrack(track), Buffer.from(await master.arrayBuffer()), {
        ...(cover ? { cover: Buffer.from(await cover.arrayBuffer()) } : {}), actorId: req.user!.id,
      });
      return reply.header('cache-control', 'no-store').code(result.status === 'imported' ? 201 : 200).send(result);
    } finally {
      slot.release();
    }
  });
}
