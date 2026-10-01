import { forgetAsset, listExpiredTrackAssets } from '@yuha/db';
import type { AppContext } from '../context.js';

export interface RetentionSweepResult {
  removed: number;
  failed: number;
}

/**
 * Remove the audio of songs their owners deleted more than the retention
 * window ago.
 *
 * A soft delete takes the song out of the library and leaves the file, which
 * is what makes "I deleted the wrong one" recoverable. Nothing ever came back
 * for those files: every song anyone has ever deleted is still stored, and the
 * retention promise had no expiry behind it. `TRACK_RETENTION_DAYS` is that
 * expiry — 90 days, a product decision rather than a number inherited from
 * somewhere — and 0 turns the sweep off for an operator who wants to keep
 * everything.
 *
 * The object goes before the row that names it. The other order drops the key
 * on a half-finished run and leaves a file nobody can find again, which is the
 * one failure a second run cannot repair. A key that cannot be removed is
 * counted and left; its row stays, so the next sweep tries it again rather
 * than the file becoming invisible and permanent.
 *
 * `limit` keeps one pass bounded. The sweep runs on a loop, so a backlog
 * drains over several passes instead of one pass holding the worker for as
 * long as the backlog is deep.
 */
export async function sweepExpiredTrackAudio(
  ctx: AppContext,
  opts: { limit?: number; log?: { error: (obj: unknown, msg: string) => void } } = {},
): Promise<RetentionSweepResult> {
  const days = ctx.config.TRACK_RETENTION_DAYS;
  if (days <= 0) return { removed: 0, failed: 0 };

  const assets = await listExpiredTrackAssets({ olderThanDays: days, limit: opts.limit ?? 200 });
  const result: RetentionSweepResult = { removed: 0, failed: 0 };

  for (const asset of assets) {
    try {
      await ctx.storage.remove('delivery', asset.storage_key);
    } catch (err) {
      result.failed += 1;
      opts.log?.error({ err, key: asset.storage_key }, 'retention sweep could not remove an object');
      continue;
    }
    await forgetAsset(asset.asset_id);
    result.removed += 1;
  }

  return result;
}
