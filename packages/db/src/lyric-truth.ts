import { query } from './pool.js';

/**
 * Ground truth for the lyric sync benchmark (docs/quality/LYRIC_BENCH.md):
 * line starts a person set by hand on their own song, in the scorer's
 * annotation format, with the DGX job the song's audio is kept under.
 *
 * Staff songs only. A customer's song is their own private work, and testing
 * aligners on it is not what they made it for; the query cannot return one.
 * Only `corrected` timelines: an aligned or estimated one is a route to score,
 * not the answer. Read-only, so it can be pointed at production.
 */
export interface LyricTruthSong {
  songId: string;
  /** The DGX job id; its audio is data/audio/<id>.mp3 there for RETENTION_DAYS. */
  providerRequestId: string | null;
  language: 'zh' | 'ja' | 'en';
  lyrics: string;
  annotation: { songId: string; language: string; lines: Array<{ idx: number; sung: boolean; start: number | null }> };
}

function languageOf(lyrics: string): LyricTruthSong['language'] {
  if (/[぀-ヿ]/.test(lyrics)) return 'ja';
  if (/[一-鿿]/.test(lyrics)) return 'zh';
  return 'en';
}

export async function lyricTruth(): Promise<LyricTruthSong[]> {
  const rows = await query<{ id: string; lyrics: string | null; lyric_timings: unknown; provider_request_id: string | null }>(
    `SELECT t.id, t.lyrics, t.lyric_timings,
            (SELECT a.provider_request_id FROM generation_attempts a
              WHERE a.job_id = t.job_id AND a.status = 'succeeded' AND a.provider_request_id IS NOT NULL
              ORDER BY a.attempt_no DESC LIMIT 1) AS provider_request_id
       FROM tracks t JOIN users u ON u.id = t.owner_id
      WHERE u.role IN ('admin', 'support')
        AND t.deleted_at IS NULL
        AND t.vocal_mode = 'with_vocals'
        AND JSON_UNQUOTE(JSON_EXTRACT(t.lyric_timings, '$.source')) = 'corrected'
      ORDER BY t.created_at, t.id`,
    [],
  );
  const out: LyricTruthSong[] = [];
  for (const r of rows) {
    const t = (typeof r.lyric_timings === 'string' ? JSON.parse(r.lyric_timings) : r.lyric_timings) as {
      lines?: Array<{ start?: unknown }>;
    } | null;
    if (!r.lyrics || !t?.lines?.length) continue;
    const language = languageOf(r.lyrics);
    out.push({
      songId: r.id,
      providerRequestId: r.provider_request_id,
      language,
      lyrics: r.lyrics,
      annotation: {
        songId: r.id,
        language,
        // A corrected timeline says when each line starts; it cannot say a line was never sung.
        lines: t.lines.map((l, idx) => ({ idx, sung: true, start: typeof l.start === 'number' ? l.start : null })),
      },
    });
  }
  return out;
}
