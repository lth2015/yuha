import type { FastifyInstance } from 'fastify';
import { AppError } from '@yuha/contracts';
import { LocalStorageAdapter } from '@yuha/providers';
import type { AppContext } from '../context.js';

/**
 * Signed-URL endpoint for the local storage adapter.
 *
 * With S3 the browser fetches a presigned URL directly and this route is never
 * registered. Locally it plays the same role: the signature covers the zone,
 * key and expiry, and is verified in constant time before any bytes are read.
 * The quarantine zone is not reachable through it at all.
 */
export default async function fileRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;
  if (ctx.config.adapters.storage !== 'local') return;

  const secret = ctx.config.STORAGE_SIGNING_SECRET!;

  app.get('/v1/files', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const zone = q['zone'];
    const key = q['key'];
    const expires = Number.parseInt(q['expires'] ?? '', 10);
    const sig = q['sig'];

    if (!zone || !key || !sig || !Number.isFinite(expires)) {
      throw new AppError('VALIDATION_FAILED', 'zone, key, expires and sig are required');
    }
    // Raw provider output is never downloadable, whatever the signature says.
    if (zone !== 'delivery') throw new AppError('FORBIDDEN', 'this zone is not downloadable');

    if (!LocalStorageAdapter.verify({ secret, zone, key, expires, sig })) {
      throw new AppError('FORBIDDEN', 'the download link is invalid or has expired');
    }

    let body: Buffer;
    try {
      body = await ctx.storage.get('delivery', key);
    } catch {
      throw new AppError('NOT_FOUND', 'file not found');
    }

    const filename = q['filename'];
    return reply
      .header('content-type', key.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg')
      .header('cache-control', 'private, max-age=60')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-disposition',
        filename ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` : 'inline',
      )
      .send(body);
  });
}
