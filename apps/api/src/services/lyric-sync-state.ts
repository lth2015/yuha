import { LINE_CONFIDENT, type LyricSyncState } from '@yuha/contracts';
import { latestLyricSync, type LyricSyncStatus, type StoredLyricTimings } from '@yuha/db';

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
