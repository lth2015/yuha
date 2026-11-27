import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual, promisify } from 'node:util';
import {
  AppError, OFFICIAL_BGM_COVER_BYTES, OFFICIAL_BGM_MASTER_BYTES, officialBgmBatchTrack,
  officialBgmMetadata, officialBgmSourceKey, officialBgmStyleTags, type OfficialBgmBatchTrack,
} from '@yuha/contracts';
import { findOfficialBgmImport, insertOfficialBgm, withTx, writeAuditLog, type OfficialBgmRow } from '@yuha/db';
import type { AudioProcessor } from '@yuha/providers';
import { z } from 'zod';
import type { AppContext } from '../context.js';

export const officialBgmImportInput = officialBgmMetadata.extend({
  sourceKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  previewStartSeconds: z.number().min(0).max(24 * 3600).optional(),
  provenance: officialBgmBatchTrack.shape.provenance.optional(),
  inventory: officialBgmBatchTrack.shape.inventory,
});
export type OfficialBgmImportInput = z.input<typeof officialBgmImportInput>;

const runImageProbe = promisify(execFile);
const AUDIO_TIMEOUT_MS = 15_000;
const PREVIEW_RENDER_MS = 59_900; // headroom for MP3 padding

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function masterFormat(bytes: Buffer): 'mp3' | 'wav' {
  const tag = bytes.toString('ascii', 0, 4);
  if ((tag === 'RIFF' || tag === 'RF64') && bytes.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3';
  throw new AppError('VALIDATION_FAILED', 'expected an MP3 or PCM WAV master');
}

export async function inspectOfficialBgmSource(
  audio: AudioProcessor, bytes: Buffer, input: Pick<OfficialBgmImportInput, 'provenance' | 'inventory' | 'previewStartSeconds'>,
) {
  if (!bytes.length || bytes.length > OFFICIAL_BGM_MASTER_BYTES) {
    throw new AppError('VALIDATION_FAILED', 'master size must be between 1 byte and 96 MiB');
  }
  const format = masterFormat(bytes);
  const provenance = input.provenance;
  if (!provenance && format !== 'mp3') throw new AppError('VALIDATION_FAILED', 'legacy batches require MP3 masters');
  if (provenance && !provenance.masterFilename.toLowerCase().endsWith(`.${format}`)) {
    throw new AppError('VALIDATION_FAILED', 'master format does not match the file name');
  }
  const sha256 = hash(bytes);
  const inventory = input.inventory;
  if (inventory && (sha256 !== inventory.sha256 || (inventory.bytes !== undefined && inventory.bytes !== bytes.length))) {
    throw new AppError('VALIDATION_FAILED', 'master does not match the inventory SHA-256 or size');
  }
  const probe = await audio.probe(bytes, AUDIO_TIMEOUT_MS);
  const correctCodec = format === 'wav' ? probe?.codec?.startsWith('pcm_') : probe?.codec === 'mp3';
  if (!probe || !correctCodec || ![1, 2].includes(probe.channels ?? 0) || probe.durationMs < 60_000 ||
      probe.meanVolumeDb === null || probe.meanVolumeDb < -55) {
    throw new AppError('VALIDATION_FAILED', 'supply a decodable non-silent MP3 or PCM WAV at least 60 seconds long');
  }
  if (inventory?.durationSeconds !== undefined && Math.abs(probe.durationMs - inventory.durationSeconds * 1000) > 20) {
    throw new AppError('VALIDATION_FAILED', 'master duration differs from the inventory');
  }
  const maxStartMs = probe.durationMs - PREVIEW_RENDER_MS;
  const startMs = input.previewStartSeconds === undefined ? Math.floor(maxStartMs / 2) : Math.round(input.previewStartSeconds * 1000);
  if (startMs < 0 || startMs > maxStartMs) throw new AppError('VALIDATION_FAILED', 'the preview window runs past the master');
  return { durationMs: probe.durationMs, startMs, sha256, format };
}

export async function inspectOfficialBgmCover(name: string | undefined, bytes: Buffer | undefined) {
  if (!name && !bytes) return null;
  if (!name || !bytes || !bytes.length || bytes.length > OFFICIAL_BGM_COVER_BYTES) {
    throw new AppError('VALIDATION_FAILED', 'cover file is missing, empty or larger than 4 MiB');
  }
  const ext = name.split('.').at(-1)?.toLowerCase();
  let type: 'image/png' | 'image/jpeg' | 'image/webp' | undefined;
  if (ext === 'png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) type = 'image/png';
  if ((ext === 'jpg' || ext === 'jpeg') && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) type = 'image/jpeg';
  if (ext === 'webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') type = 'image/webp';
  if (!type) throw new AppError('VALIDATION_FAILED', 'cover must be a PNG, JPEG or WebP matching its file name');
  const folder = await mkdtemp(join(tmpdir(), 'official-bgm-cover-'));
  try {
    const path = join(folder, `cover.${ext}`);
    await writeFile(path, bytes);
    await runImageProbe('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-threads', '1', '-max_pixels', '16777216',
      '-i', path, '-frames:v', '1', '-f', 'null', '-'], { timeout: 8_000, killSignal: 'SIGKILL', maxBuffer: 32_768 });
  } catch {
    throw new AppError('VALIDATION_FAILED', 'cover could not be decoded');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  return { bytes, type, ext, sha256: hash(bytes) };
}

function reuse(rows: OfficialBgmRow[], fields: Pick<OfficialBgmRow,
  'source_key' | 'sha256' | 'title' | 'genre' | 'scenario' | 'mood' | 'preview_start_ms' | 'master_format' | 'provenance'>) {
  if (!rows.length) return undefined;
  const r = rows[0]!;
  if (rows.length === 1 && Object.entries(fields).every(([key, expected]) =>
    isDeepStrictEqual(r[key as keyof OfficialBgmRow], expected))) {
    return { status: 'existing' as const, id: r.id };
  }
  throw new AppError('CONFLICT', 'source key or audio is already present with different catalogue metadata');
}

export function importInputForBgmTrack(track: OfficialBgmBatchTrack): OfficialBgmImportInput {
  return { ...track, sourceKey: officialBgmSourceKey(track.provenance) };
}

/** Keep the source bytes. Only the public listening excerpt is encoded here. */
export async function importOfficialBgm(
  ctx: Pick<AppContext, 'audio' | 'storage'>, raw: OfficialBgmImportInput, bytes: Buffer,
  attachments: { cover?: Buffer; actorId?: string } = {},
) {
  const input = officialBgmImportInput.parse(raw);
  const cover = await inspectOfficialBgmCover(input.provenance?.coverFilename, attachments.cover);
  const { durationMs, startMs, sha256, format } = await inspectOfficialBgmSource(ctx.audio, bytes, input);
  const provenance = input.provenance ? { ...input.provenance, ...(cover ? { coverSha256: cover.sha256 } : {}) } : null;
  if (provenance?.coverFilename === undefined && provenance) delete provenance.coverFilename;
  const fields = {
    source_key: input.sourceKey, sha256, title: input.title, genre: input.genre, scenario: input.scenario, mood: input.mood,
    preview_start_ms: startMs, master_format: format,
    provenance,
  };
  const lookup = () => findOfficialBgmImport(input.sourceKey, sha256);
  const already = reuse(await lookup(), fields);
  if (already) return already;

  const preview = await ctx.audio.renderExport({ source: bytes, clipStartMs: startMs, clipDurationMs: PREVIEW_RENDER_MS,
    fadeOutMs: 900, format: 'mp3', mp3BitrateKbps: 128, timeoutMs: AUDIO_TIMEOUT_MS });
  const actual = await ctx.audio.probe(preview, AUDIO_TIMEOUT_MS);
  if (!actual || actual.codec !== 'mp3' || actual.durationMs < 1000 || actual.durationMs > 60_000) {
    throw new AppError('VALIDATION_FAILED', 'the encoded preview did not meet the 60-second playback limit');
  }

  const masterKey = `official-bgm/masters/${sha256}.${format}`;
  const id = randomUUID();
  const previewKey = `official-bgm/previews/${id}.mp3`;
  const coverKey = cover ? `official-bgm/covers/${id}.${cover.ext}` : null;
  try {
    await withTx(async (tx) => {
      // Claim both unique values before writing to private delivery storage.
      // Style tags start from the batch's own style words; the score starts in
      // 3.8–4.5 (insertOfficialBgm). An editor can change both.
      await insertOfficialBgm({ ...fields, id, master_key: masterKey, master_ms: durationMs, preview_key: previewKey,
        preview_ms: actual.durationMs, cover_key: coverKey, tags: officialBgmStyleTags(provenance?.style) }, tx);
      const writeDeadline = AbortSignal.timeout(20_000);
      const put = (key: string, body: Buffer, contentType: string) =>
        ctx.storage.put({ zone: 'delivery', key, body, contentType, abortSignal: writeDeadline });
      try {
        const writes = [put(masterKey, bytes, format === 'wav' ? 'audio/wav' : 'audio/mpeg'), put(previewKey, preview, 'audio/mpeg')];
        if (cover && coverKey) writes.push(put(coverKey, cover.bytes, cover.type));
        const failed = (await Promise.allSettled(writes)).find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        if (attachments.actorId) {
          await writeAuditLog({ actorId: attachments.actorId, actorRole: 'admin', subjectType: 'official_bgm', subjectId: id,
            action: 'official_bgm.import', reason: 'Imported from official BGM batch', before: null, after: { state: 'draft' } }, tx);
        }
      } catch (error) {
        const keys = coverKey ? [masterKey, previewKey, coverKey] : [masterKey, previewKey];
        const cleanupDeadline = AbortSignal.timeout(5_000);
        await Promise.allSettled(keys.map((key) => ctx.storage.remove('delivery', key, cleanupDeadline)));
        throw error;
      }
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error;
    const winner = reuse(await lookup(), fields);
    if (winner) return winner;
    throw error;
  }
  return { status: 'imported' as const, id };
}
