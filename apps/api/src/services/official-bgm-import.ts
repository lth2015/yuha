import { createHash, randomUUID } from 'node:crypto';
import { AppError, officialBgmMetadata } from '@yuha/contracts';
import { findOfficialBgmImport, insertOfficialBgm, withTx, type OfficialBgmRow } from '@yuha/db';
import type { AudioProcessor } from '@yuha/providers';
import { z } from 'zod';
import type { AppContext } from '../context.js';

export const OFFICIAL_BGM_MAX_BYTES = 32 * 1024 * 1024;
export const officialBgmImportInput = officialBgmMetadata.extend({
  sourceKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  previewStartSeconds: z.number().min(0).max(24 * 3600).optional(),
});
export type OfficialBgmImportInput = z.input<typeof officialBgmImportInput>;

// MP3 frames and encoder delay can add up to several dozen ms. Probe the
// actual result before recording it, even with headroom under 60 seconds.
const PREVIEW_RENDER_MS = 59_900;

export async function inspectOfficialBgmSource(audio: AudioProcessor, bytes: Buffer, startSeconds?: number) {
  if (!bytes.length || bytes.length > OFFICIAL_BGM_MAX_BYTES) throw new AppError('VALIDATION_FAILED', 'MP3 size must be between 1 byte and 32 MiB');
  const probe = await audio.probe(bytes);
  if (!probe || probe.codec !== 'mp3' || ![1, 2].includes(probe.channels ?? 0) || probe.durationMs < 60_000 ||
      probe.meanVolumeDb === null || probe.meanVolumeDb < -55) {
    throw new AppError('VALIDATION_FAILED', 'supply a decodable non-silent MP3 at least 60 seconds long');
  }
  const maxStartMs = probe.durationMs - PREVIEW_RENDER_MS;
  const startMs = startSeconds === undefined ? Math.floor(maxStartMs / 2) : Math.round(startSeconds * 1000);
  if (startMs < 0 || startMs > maxStartMs) throw new AppError('VALIDATION_FAILED', 'the preview window runs past the master');
  return { durationMs: probe.durationMs, startMs, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function reuse(rows: OfficialBgmRow[], input: OfficialBgmImportInput, sha256: string, startMs: number) {
  if (!rows.length) return undefined;
  const r = rows[0]!;
  if (rows.length === 1 && r.source_key === input.sourceKey && r.sha256 === sha256 && r.title === input.title &&
      r.genre === input.genre && r.scenario === input.scenario && r.mood === input.mood && r.preview_start_ms === startMs) {
    return { status: 'existing' as const, id: r.id };
  }
  throw new AppError('CONFLICT', 'source key or audio is already present with different catalogue metadata');
}

/** Import a vetted local file. No generation jobs, billing or user-track rows are created. */
export async function importOfficialBgm(ctx: Pick<AppContext, 'audio' | 'storage'>, raw: OfficialBgmImportInput, bytes: Buffer) {
  const input = officialBgmImportInput.parse(raw);
  const { durationMs, startMs, sha256 } = await inspectOfficialBgmSource(ctx.audio, bytes, input.previewStartSeconds);
  const already = reuse(await findOfficialBgmImport(input.sourceKey, sha256), input, sha256, startMs);
  if (already) return already;

  const preview = await ctx.audio.renderExport({ source: bytes, clipStartMs: startMs, clipDurationMs: PREVIEW_RENDER_MS,
    fadeOutMs: 900, format: 'mp3', mp3BitrateKbps: 128 });
  const actual = await ctx.audio.probe(preview);
  if (!actual || actual.codec !== 'mp3' || actual.durationMs < 1000 || actual.durationMs > 60_000) {
    throw new AppError('VALIDATION_FAILED', 'the encoded preview did not meet the 60-second playback limit');
  }

  // Verified media belongs in the private delivery bucket. Quarantine has a
  // provider-output expiry policy. Only preview keys are signed by the feature.
  const masterKey = `official-bgm/masters/${sha256}.mp3`;
  const id = randomUUID();
  const previewKey = `official-bgm/previews/${id}.mp3`;
  try {
    await withTx(async (tx) => {
      // Reserve both unique keys before writing. A concurrent duplicate can
      // never overwrite the winner's audio. A failed write rolls back the row,
      // so rerunning the same input can safely rewrite partial output.
      await insertOfficialBgm({ id, source_key: input.sourceKey, sha256, title: input.title,
        genre: input.genre, scenario: input.scenario, mood: input.mood, master_key: masterKey,
        master_ms: durationMs, preview_key: previewKey, preview_start_ms: startMs, preview_ms: actual.durationMs }, tx);
      try {
        await ctx.storage.put({ zone: 'delivery', key: masterKey, body: bytes, contentType: 'audio/mpeg' });
        await ctx.storage.put({ zone: 'delivery', key: previewKey, body: preview, contentType: 'audio/mpeg' });
      } catch (error) {
        await Promise.allSettled([ctx.storage.remove('delivery', masterKey), ctx.storage.remove('delivery', previewKey)]);
        throw error;
      }
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error;
    const winner = reuse(await findOfficialBgmImport(input.sourceKey, sha256), input, sha256, startMs);
    if (winner) return winner;
    throw error;
  }
  return { status: 'imported' as const, id };
}
