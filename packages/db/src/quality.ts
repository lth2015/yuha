import { query } from './pool.js';

/**
 * What "a generation succeeded" means, measured four ways
 * (docs/GENERATION_QUALITY_SPEC.md).
 *
 * The console had one figure, delivered ÷ finished, so a song half as long
 * as asked for, with its lyrics on an estimated timeline, deleted by its
 * owner a minute later, counted as a success. These separate the provider
 * answering from the song being whole from the person keeping it.
 */
export interface QualityMetric {
  numerator: number;
  denominator: number;
  /** Up to five job ids that missed, newest first. */
  misses: string[];
}

export interface QualityReport {
  /** Delivered ÷ (delivered + failed + refused). A person's cancellation is not a generation outcome. */
  completion: QualityMetric;
  /** Delivered with a master file of non-zero size and length ÷ delivered. */
  playable: QualityMetric;
  /** Both of the next two (instrumentals need only the first) ÷ delivered. */
  complete: QualityMetric;
  /** Master at least 90% of the asked length ÷ delivered. */
  length: QualityMetric;
  /** Sung songs whose timeline is aligned or corrected ÷ sung songs delivered. */
  lyricsAligned: QualityMetric;
  /** Delivered at least 24 h ago and still kept, with no problem report ÷ those delivered at least 24 h ago. */
  approval: QualityMetric;
  /**
   * Why the sung songs that missed `lyricsAligned` missed it, by the first
   * word of the aligner's reason (the rest — a coverage figure, a status
   * body — differs per song). `deleted`: the song was deleted (its words go
   * with it). `no_lyrics`: sung with no words to align — the text model wrote
   * none, or they failed screening, and the song was sung wordless.
   * `no_timing`: there were words, and nothing could be stored at all.
   * Past the eighth reason the rest are summed as `other`, so the counts
   * always add up to the misses.
   * `not_recorded`: an estimate with no reason, which is a song made before
   * reasons were kept, or the estimator being the only aligner configured.
   */
  lyricsFallback: Array<{ reason: string; n: number }>;
}

/** How long a song must have existed before keeping it says anything. */
const SETTLE_HOURS = 24;
const LENGTH_FLOOR = 0.9;

interface Row {
  id: string;
  state: string;
  input: unknown;
  finished_at: Date;
  track_id: string | null;
  deleted_at: Date | null;
  timing: string | null;
  fallback: string | null;
  has_lyrics: number;
  byte_size: number | null;
  duration_ms: number | null;
  reports: number;
}

function metric(): QualityMetric {
  return { numerator: 0, denominator: 0, misses: [] };
}

function count(m: QualityMetric, ok: boolean, id: string): void {
  m.denominator += 1;
  if (ok) m.numerator += 1;
  else if (m.misses.length < 5) m.misses.push(id);
}

/**
 * The report over jobs that ended in the last `hours`. With `buildSha`, only
 * jobs that build created; `null` is "all", whatever made them. Approval looks
 * at songs delivered between `hours + 24` and 24 hours ago, the same span
 * shifted back by the time it takes for keeping a song to mean something.
 */
export async function qualityReport(params: { hours: number; buildSha?: string | null }): Promise<QualityReport> {
  const build = params.buildSha ? `AND j.build_sha = ?` : '';
  const rows = await query<Row>(
    `SELECT j.id, j.state, j.input, j.finished_at, t.id AS track_id, t.deleted_at,
            JSON_UNQUOTE(JSON_EXTRACT(t.lyric_timings, '$.source')) AS timing,
            JSON_UNQUOTE(JSON_EXTRACT(t.lyric_timings, '$.fallbackReason')) AS fallback,
            (t.lyrics IS NOT NULL AND t.lyrics <> '') AS has_lyrics,
            a.byte_size, a.duration_ms,
            (SELECT COUNT(*) FROM issue_reports r WHERE r.track_id = t.id) AS reports
       FROM generation_jobs j
       LEFT JOIN tracks t ON t.id = j.track_id
       LEFT JOIN (SELECT track_id, MAX(byte_size) AS byte_size, MAX(duration_ms) AS duration_ms
                    FROM asset_versions WHERE kind = 'master' GROUP BY track_id) a ON a.track_id = t.id
      WHERE j.state IN ('DELIVERED','FAILED','REJECTED')
        AND j.finished_at >= UTC_TIMESTAMP(3) - INTERVAL ? HOUR
        ${build}
      ORDER BY j.finished_at DESC
      LIMIT 20000`,
    params.buildSha ? [params.hours + SETTLE_HOURS, params.buildSha] : [params.hours + SETTLE_HOURS],
  );

  const now = Date.now();
  const windowStart = now - params.hours * 3_600_000;
  const settled = now - SETTLE_HOURS * 3_600_000;
  const report: QualityReport = {
    completion: metric(),
    playable: metric(),
    complete: metric(),
    length: metric(),
    lyricsAligned: metric(),
    approval: metric(),
    lyricsFallback: [],
  };
  const reasons = new Map<string, number>();

  for (const r of rows) {
    const finished = r.finished_at.getTime();
    const delivered = r.state === 'DELIVERED';
    const input = (typeof r.input === 'string' ? JSON.parse(r.input) : r.input) as {
      durationSeconds?: number;
      instrumental?: boolean;
    };

    // Approval runs on its own, shifted window.
    if (delivered && finished <= settled && finished >= windowStart - SETTLE_HOURS * 3_600_000) {
      count(report.approval, !!r.track_id && !r.deleted_at && Number(r.reports) === 0, r.id);
    }
    if (finished < windowStart) continue;

    count(report.completion, delivered, r.id);
    if (!delivered) continue;

    const playable = Number(r.byte_size ?? 0) > 0 && Number(r.duration_ms ?? 0) > 0;
    count(report.playable, playable, r.id);

    const asked = (input.durationSeconds ?? 0) * 1000;
    const longEnough = playable && (asked === 0 || Number(r.duration_ms) >= asked * LENGTH_FLOOR);
    count(report.length, longEnough, r.id);

    const sung = input.instrumental === false;
    const aligned = r.timing === 'aligned' || r.timing === 'corrected';
    if (sung) count(report.lyricsAligned, aligned, r.id);
    if (sung && !aligned) {
      // A recorded reason first; then a song whose words went with its
      // deletion (an account deleted, an unclaimed trial expired).
      const why = r.fallback
        ? r.fallback.split(/[\s:=]/)[0]!
        : !r.track_id || r.deleted_at
          ? 'deleted'
          : !Number(r.has_lyrics)
            ? 'no_lyrics'
            : r.timing == null
              ? 'no_timing'
              : 'not_recorded';
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
    }

    count(report.complete, longEnough && (!sung || aligned), r.id);
  }
  const ranked = [...reasons].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
  report.lyricsFallback = ranked.slice(0, 8);
  const rest = ranked.slice(8).reduce((sum, r) => sum + r.n, 0);
  if (rest) report.lyricsFallback.push({ reason: 'other', n: rest });
  return report;
}
