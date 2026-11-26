import { LINE_CONFIDENT, type LyricSyncState } from '@yuha/contracts';
import { EstimatedAlignmentProvider } from '@yuha/providers';
import { getMasterAsset, getUser, latestLyricSync, requestLyricBackfill, type LyricSyncStatus, type StoredLyricTimings } from '@yuha/db';
import type { AppContext } from '../context.js';

/** Words someone sings: a sung song with a line that is not only a section tag. */
function sung(row: { vocal_mode: string; lyrics: string | null }): boolean {
  if (row.vocal_mode === 'instrumental' || !row.lyrics) return false;
  return row.lyrics.split('\n').some((l) => l.trim() && !/^\[[^\]]*\]$/.test(l.trim()));
}

/**
 * Where a song's lyric sync stands (trackView.lyricSync). A heard or
 * corrected timeline answers first; otherwise a job on its way says syncing;
 * otherwise there is no heard timeline and none coming.
 */
export function lyricSyncStateOf(
  row: { vocal_mode: string; lyrics: string | null; lyric_timings: StoredLyricTimings | null },
  job: LyricSyncStatus | null,
): LyricSyncState | null {
  if (!sung(row)) return null;
  const t = row.lyric_timings;
  if (t?.source === 'corrected') return 'synced';
  if (t?.source === 'aligned') {
    return t.lines.some((l) => typeof l.confidence === 'number' && l.confidence < LINE_CONFIDENT) ? 'partial' : 'synced';
  }
  if (job === 'queued' || job === 'running') return 'syncing';
  return 'unavailable';
}

export async function lyricSyncStateFor(row: {
  id: string;
  vocal_mode: string;
  lyrics: string | null;
  lyric_timings: StoredLyricTimings | null;
}): Promise<LyricSyncState | null> {
  if (!sung(row)) return null;
  const t = row.lyric_timings?.source;
  if (t === 'corrected' || t === 'aligned') return lyricSyncStateOf(row, null);
  return lyricSyncStateOf(row, (await latestLyricSync(row.id))?.status ?? null);
}

/**
 * The owner opened their song (GET /v1/tracks/:id, owner branch only — never
 * the library list, never a visitor on a shared link). An older song with no
 * heard timeline is queued for a backfill from YUHA's own master (L4b), and
 * the answer is its sync state as the page should show it now.
 */
export async function lyricSyncStateOnOpen(
  ctx: AppContext,
  row: { id: string; owner_id: string; vocal_mode: string; lyrics: string | null; lyric_timings: StoredLyricTimings | null },
): Promise<LyricSyncState | null> {
  const state = await lyricSyncStateFor(row);
  if (state !== 'unavailable' || !row.lyrics || !(await backfillFor(ctx, row.owner_id))) return state;
  const master = await getMasterAsset(row.id);
  if (!master) return state;
  const out = await requestLyricBackfill({
    trackId: row.id,
    masterSha: master.sha256,
    lyrics: row.lyrics,
    dailyQuota: ctx.config.LYRIC_BACKFILL_DAILY,
  }).catch(() => 'none' as const);
  return out === 'none' ? state : out;
}

async function backfillFor(ctx: AppContext, ownerId: string): Promise<boolean> {
  const mode = ctx.config.LYRIC_BACKFILL;
  if (mode === 'off') return false;
  // The estimator would only estimate again: backfill is for an aligner that listens.
  if (ctx.alignment.kind === new EstimatedAlignmentProvider().kind) return false;
  if (mode === 'all') return true;
  const role = (await getUser(ownerId).catch(() => undefined))?.role;
  return role === 'admin' || role === 'support';
}
