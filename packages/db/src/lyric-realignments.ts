import type { PoolConnection } from 'mysql2/promise';
import type { LyricTimings } from '@yuha/contracts';
import { execute, newId, query, queryOne } from './pool.js';

/**
 * Lyric re-alignment runs (migration 0025, docs/LYRIC_ALIGNMENT.md).
 *
 * The aligner improves; songs made before it keep the timing they were given.
 * A run walks every sung song in id order and asks the aligner again. The
 * aligner's answer is slow (it is a GPU job on a shared box), so it is fetched
 * outside any transaction, and what it decides is written in one: the song's
 * new timing and the run's cursor past it, together.
 */
export interface LyricRealignmentRow {
  id: string;
  idempotency_key: string;
  actor_id: string;
  reason: string;
  status: 'running' | 'done';
  cursor_track_id: string | null;
  tracks_seen: number;
  tracks_realigned: number;
  tracks_kept: number;
  created_at: Date;
  finished_at: Date | null;
}

/** A song a run can re-align, with what the aligner needs to find its audio. */
export interface RealignCandidate {
  id: string;
  lyrics: string;
  duration_ms: number;
  /** The music service's id for the render; null when no attempt recorded one. */
  provider_request_id: string | null;
}

/*
 * Which songs: sung, with lyrics, not deleted, and not corrected by a person.
 * A correction is somebody who sat and listened; a model's second opinion
 * does not outrank it (contracts markCorrected).
 */
const CANDIDATE_WHERE = `
      t.deleted_at IS NULL
  AND t.vocal_mode = 'with_vocals'
  AND t.lyrics IS NOT NULL AND TRIM(t.lyrics) <> ''
  AND (t.lyric_timings IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(t.lyric_timings, '$.source')) <> 'corrected')`;

export async function getLyricRealignment(id: string, tx?: PoolConnection): Promise<LyricRealignmentRow | null> {
  return (await queryOne<LyricRealignmentRow>(`SELECT * FROM lyric_realignments WHERE id = ?`, [id], tx)) ?? null;
}

export async function listLyricRealignments(limit = 10): Promise<LyricRealignmentRow[]> {
  return query<LyricRealignmentRow>(`SELECT * FROM lyric_realignments ORDER BY created_at DESC, id DESC LIMIT ?`, [limit]);
}

/** How many songs a run started now would visit, and how many it leaves alone because a person corrected them. */
export async function previewLyricRealignment(): Promise<{ songs: number; corrected: number }> {
  const row = await queryOne<{ songs: number; corrected: number }>(
    `SELECT
       SUM(CASE WHEN ${CANDIDATE_WHERE} THEN 1 ELSE 0 END) AS songs,
       SUM(CASE WHEN t.deleted_at IS NULL AND t.vocal_mode = 'with_vocals'
                 AND JSON_UNQUOTE(JSON_EXTRACT(t.lyric_timings, '$.source')) = 'corrected' THEN 1 ELSE 0 END) AS corrected
     FROM tracks t`,
  );
  return { songs: Number(row?.songs ?? 0), corrected: Number(row?.corrected ?? 0) };
}

/**
 * Starts a run, or returns the one this key already started. Refuses (the
 * blocking row) while another run is unfinished: two runs walking the same
 * songs would only spend the GPU twice.
 */
export async function createLyricRealignment(
  params: { idempotencyKey: string; actorId: string; reason: string },
  tx: PoolConnection,
): Promise<{ run: LyricRealignmentRow; created: boolean } | { blockedBy: LyricRealignmentRow }> {
  // Same serialisation as credit resets: a locking read over the (small)
  // table makes a concurrent start wait for this one, then see it.
  await query(`SELECT id FROM lyric_realignments FOR UPDATE`, [], tx);
  const same = await queryOne<LyricRealignmentRow>(`SELECT * FROM lyric_realignments WHERE idempotency_key = ?`, [params.idempotencyKey], tx);
  if (same) return { run: same, created: false };
  const running = await queryOne<LyricRealignmentRow>(`SELECT * FROM lyric_realignments WHERE status = 'running' LIMIT 1`, [], tx);
  if (running) return { blockedBy: running };
  const id = newId();
  await execute(
    `INSERT INTO lyric_realignments (id, idempotency_key, actor_id, reason) VALUES (?, ?, ?, ?)`,
    [id, params.idempotencyKey, params.actorId, params.reason],
    tx,
  );
  return { run: (await getLyricRealignment(id, tx))!, created: true };
}

/** The next songs a run reaches, after its cursor, in id order. */
export async function realignCandidatesAfter(cursor: string | null, limit: number): Promise<RealignCandidate[]> {
  const rows = await query<RealignCandidate>(
    `SELECT t.id, t.lyrics, t.duration_ms,
            (SELECT a.provider_request_id FROM generation_attempts a
              WHERE a.job_id = t.job_id AND a.status = 'succeeded' AND a.provider_request_id IS NOT NULL
              ORDER BY a.attempt_no DESC LIMIT 1) AS provider_request_id
       FROM tracks t
      WHERE ${CANDIDATE_WHERE} AND t.id > ?
      ORDER BY t.id LIMIT ?`,
    [cursor ?? '', limit],
  );
  return rows.map((r) => ({ ...r, duration_ms: Number(r.duration_ms) }));
}

/**
 * Records one song's outcome and moves the cursor past it, in one
 * transaction. `timings` is written only when the aligner heard the song
 * (`aligned`); anything else keeps what the song had. Returns whether the
 * song was rewritten; false too when another runner already passed it.
 */
export async function finishRealignedTrack(
  run: { id: string },
  trackId: string,
  timings: LyricTimings | null,
  tx: PoolConnection,
): Promise<boolean> {
  const row = await queryOne<{ status: string; cursor_track_id: string | null }>(
    `SELECT status, cursor_track_id FROM lyric_realignments WHERE id = ? FOR UPDATE`,
    [run.id],
    tx,
  );
  // A second runner of the same run (another pod, "continue" pressed twice)
  // finds the cursor already past this song and does nothing.
  if (!row || row.status !== 'running' || (row.cursor_track_id !== null && row.cursor_track_id >= trackId)) return false;

  let rewritten = false;
  if (timings && timings.source === 'aligned') {
    // Re-read inside the lock: the owner may have saved a correction while
    // the aligner was busy, and theirs wins.
    const current = await queryOne<{ source: string | null }>(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(lyric_timings, '$.source')) AS source FROM tracks WHERE id = ? FOR UPDATE`,
      [trackId],
      tx,
    );
    if (current && current.source !== 'corrected') {
      await execute(
        `UPDATE tracks SET lyric_timings = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
        [JSON.stringify(timings), trackId],
        tx,
      );
      rewritten = true;
    }
  }
  await execute(
    `UPDATE lyric_realignments
        SET cursor_track_id = ?, tracks_seen = tracks_seen + 1,
            tracks_realigned = tracks_realigned + ?, tracks_kept = tracks_kept + ?
      WHERE id = ?`,
    [trackId, rewritten ? 1 : 0, rewritten ? 0 : 1, run.id],
    tx,
  );
  return rewritten;
}

/** Marks a run done. False when it already was (a second runner got there first). */
export async function finishLyricRealignment(id: string, tx: PoolConnection): Promise<boolean> {
  const row = await queryOne<{ status: string }>(`SELECT status FROM lyric_realignments WHERE id = ? FOR UPDATE`, [id], tx);
  if (!row || row.status !== 'running') return false;
  await execute(`UPDATE lyric_realignments SET status = 'done', finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [id], tx);
  return true;
}
