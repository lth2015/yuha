import { createHash, randomUUID } from 'node:crypto';
import type mysql from 'mysql2/promise';
import { db, execute, query, queryOne, withTx } from './pool.js';

/**
 * The automatic lyric sync queue (migration 0039; docs/AUTOMATIC_LYRIC_SYNC_TICKETS.md L4a).
 * Holds hashes, never words: the words are read from the song when the job runs.
 */
export type LyricSyncStatus = 'queued' | 'running' | 'applied' | 'kept' | 'failed';
export type LyricSyncTrigger = 'delivery' | 'backfill' | 'retry';

/** A claim older than this belongs to a worker that stopped (a pod roll): it is taken back. */
const CLAIM_STALE_MINUTES = 10;

export const lyricsSha = (lyrics: string) => createHash('sha256').update(lyrics, 'utf8').digest('hex');

/** One job per song, audio and words, however often it is asked for. */
export async function enqueueLyricSync(params: {
  trackId: string;
  masterSha: string;
  lyrics: string;
  trigger: LyricSyncTrigger;
}): Promise<void> {
  // INSERT IGNORE reports 0 for a skipped row, but nothing here depends on it.
  await execute(
    `INSERT IGNORE INTO lyric_sync_jobs (id, track_id, master_sha256, lyrics_sha, trigger_kind)
     VALUES (?, ?, ?, ?, ?)`,
    [randomUUID(), params.trackId, params.masterSha, lyricsSha(params.lyrics), params.trigger],
  );
}

export interface ClaimedLyricSync {
  id: string;
  trigger_kind: LyricSyncTrigger;
  track_id: string;
  master_sha256: string;
  lyrics_sha: string;
  attempts: number;
  /** The song as it is now: words, length, and the render the aligner can fetch. */
  lyrics: string | null;
  duration_ms: number;
  provider_request_id: string | null;
}

/**
 * The next due job, claimed for `worker`; null when none is due. A job whose
 * claim went stale is taken back, and its attempt counts.
 */
export async function claimNextLyricSync(worker: string): Promise<ClaimedLyricSync | null> {
  return withTx(async (tx) => {
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM lyric_sync_jobs
        WHERE (status = 'queued' AND next_attempt_at <= UTC_TIMESTAMP(3))
           OR (status = 'running' AND claimed_at < UTC_TIMESTAMP(3) - INTERVAL ${CLAIM_STALE_MINUTES} MINUTE)
        -- A new song's sync goes before an older song's backfill.
        ORDER BY trigger_kind = 'backfill', next_attempt_at, created_at
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [],
      tx,
    );
    if (!row) return null;
    await execute(
      `UPDATE lyric_sync_jobs
          SET status = 'running', claimed_by = ?, claimed_at = UTC_TIMESTAMP(3), attempts = attempts + 1
        WHERE id = ?`,
      [worker.slice(0, 64), row.id],
      tx,
    );
    const job = await queryOne<ClaimedLyricSync>(
      `SELECT j.id, j.trigger_kind, j.track_id, j.master_sha256, j.lyrics_sha, j.attempts, t.lyrics, t.duration_ms,
              (SELECT a.provider_request_id FROM generation_attempts a
                WHERE a.job_id = t.job_id AND a.status = 'succeeded' AND a.provider_request_id IS NOT NULL
                ORDER BY a.attempt_no DESC LIMIT 1) AS provider_request_id
         FROM lyric_sync_jobs j JOIN tracks t ON t.id = j.track_id
        WHERE j.id = ?`,
      [row.id],
      tx,
    );
    return job ? { ...job, attempts: Number(job.attempts), duration_ms: Number(job.duration_ms) } : null;
  });
}

/** Ends a job. Only the claimant's claim is ended: a job taken back by another worker is theirs now. */
export async function finishLyricSync(
  id: string,
  worker: string,
  status: 'applied' | 'kept' | 'failed',
  failure?: string | null,
): Promise<void> {
  await execute(
    `UPDATE lyric_sync_jobs
        SET status = ?, failure = COALESCE(?, failure), finished_at = UTC_TIMESTAMP(3), claimed_by = NULL
      WHERE id = ? AND status = 'running' AND claimed_by = ?`,
    [status, failure ? failure.slice(0, 64) : null, id, worker.slice(0, 64)],
  );
}

/** Puts a job back in the queue to be tried again in `afterSeconds`. */
export async function retryLyricSync(id: string, worker: string, afterSeconds: number, failure: string): Promise<void> {
  await execute(
    `UPDATE lyric_sync_jobs
        SET status = 'queued', failure = ?, claimed_by = NULL,
            next_attempt_at = UTC_TIMESTAMP(3) + INTERVAL ? SECOND
      WHERE id = ? AND status = 'running' AND claimed_by = ?`,
    [failure.slice(0, 64), Math.max(1, Math.round(afterSeconds)), id, worker.slice(0, 64)],
  );
}

/** The newest job for a song, for the song's sync state. */
export async function latestLyricSync(trackId: string): Promise<{ status: LyricSyncStatus } | null> {
  return (
    (await queryOne<{ status: LyricSyncStatus }>(
      `SELECT status FROM lyric_sync_jobs WHERE track_id = ? ORDER BY created_at DESC LIMIT 1`,
      [trackId],
    )) ?? null
  );
}

/** Midnight in Japan, as UTC: the backfill quota is a JST day. */
const JST_DAY_START_UTC = `(TIMESTAMP(DATE(UTC_TIMESTAMP(3) + INTERVAL 9 HOUR)) - INTERVAL 9 HOUR)`;
const BACKFILL_LOCK = 'yuha_lyric_backfill';

/**
 * An older song's owner opened it with no heard timeline (L4b). Queues its
 * backfill unless the day's quota is spent:
 *   syncing   queued now, or already on its way
 *   deferred  the quota is spent today; asked again the next time it is opened
 *   none      nothing to do today (this version already ended; a failure is
 *             tried again on a later day, not again today)
 * One job per song, master and words, so tabs take one slot. Count and insert
 * run under one lock on an autocommit connection, so the quota holds against
 * owners opening songs at the same moment.
 */
export async function requestLyricBackfill(params: {
  trackId: string;
  masterSha: string;
  lyrics: string;
  dailyQuota: number;
}): Promise<'syncing' | 'deferred' | 'none'> {
  const sha = lyricsSha(params.lyrics);
  const conn: mysql.PoolConnection = await db().getConnection();
  try {
    const got = await queryOne<{ ok: number | null }>(`SELECT GET_LOCK(?, 5) AS ok`, [BACKFILL_LOCK], conn);
    if (Number(got?.ok) !== 1) return 'deferred';
    try {
      const existing = await queryOne<{ id: string; status: LyricSyncStatus; before_today: number | null }>(
        `SELECT id, status, finished_at < ${JST_DAY_START_UTC} AS before_today
           FROM lyric_sync_jobs WHERE track_id = ? AND master_sha256 = ? AND lyrics_sha = ?`,
        [params.trackId, params.masterSha, sha],
        conn,
      );
      if (existing && (existing.status === 'queued' || existing.status === 'running')) return 'syncing';
      if (existing && !(existing.status === 'failed' && Number(existing.before_today) === 1)) return 'none';
      const today = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM lyric_sync_jobs WHERE trigger_kind = 'backfill' AND created_at >= ${JST_DAY_START_UTC}`,
        [],
        conn,
      );
      if (Number(today?.n ?? 0) >= params.dailyQuota) return 'deferred';
      if (existing) {
        // A failure from an earlier day: a fresh set of attempts, counted against today's quota.
        await execute(
          `UPDATE lyric_sync_jobs
              SET status = 'queued', trigger_kind = 'backfill', attempts = 0, failure = NULL, claimed_by = NULL,
                  next_attempt_at = UTC_TIMESTAMP(3), created_at = UTC_TIMESTAMP(3), finished_at = NULL
            WHERE id = ?`,
          [existing.id],
          conn,
        );
      } else {
        await execute(
          `INSERT IGNORE INTO lyric_sync_jobs (id, track_id, master_sha256, lyrics_sha, trigger_kind) VALUES (?, ?, ?, ?, 'backfill')`,
          [randomUUID(), params.trackId, params.masterSha, sha],
          conn,
        );
      }
      return 'syncing';
    } finally {
      await queryOne(`SELECT RELEASE_LOCK(?)`, [BACKFILL_LOCK], conn);
    }
  } finally {
    conn.release();
  }
}
