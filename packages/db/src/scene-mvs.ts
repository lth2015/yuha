import { randomUUID } from 'node:crypto';
import type mysql from 'mysql2/promise';
import { db, execute, query, queryOne, withTx } from './pool.js';

/**
 * AI scene MV jobs and their shots (migration 0036; docs/AI_SCENE_MV_SPEC.md).
 *
 * The only writer of those tables, so the rules live here and nowhere else:
 *   - a job moves only forward: draft → queued → generating → composing →
 *     ready, or to failed / cancelled from anywhere before ready;
 *   - one person has one job in the queue at a time (the database's unique
 *     key on `active_owner` refuses the second, however the requests race);
 *   - one shot is on the GPU at a time across every worker;
 *   - a shot gets SHOT_TRIES tries, at least RETRY_AFTER_SECONDS apart (the
 *     LTX service's note: resubmit a failure at most once, five minutes on,
 *     because the machine cools between runs); after that the job fails,
 *     which frees the person's slot — the platform failed, not them;
 *   - a cancel stops every shot not yet drawn, and a shot that finishes after
 *     its job was cancelled is not saved as done.
 *
 * Every "did that work" is read back under a lock, never taken from
 * affectedRows (CLAUDE.md: the driver counts matched rows).
 */
export type SceneMvStatus = 'draft' | 'queued' | 'generating' | 'composing' | 'ready' | 'failed' | 'cancelled';
export type SceneMvShotStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface SceneMvShotRow {
  id: string;
  scene_mv_id: string;
  idx: number;
  prompt: string;
  status: SceneMvShotStatus;
  attempts: number;
  provider_clip_id: string | null;
  clip_key: string | null;
  failure: string | null;
  claimed_by: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface SceneMvRow {
  id: string;
  owner_id: string;
  track_id: string;
  status: SceneMvStatus;
  style: string;
  description: string | null;
  clip_start: number;
  clip_end: number;
  timings_sha: string | null;
  output_key: string | null;
  failure: string | null;
  created_at: Date;
  queued_at: Date | null;
  finished_at: Date | null;
  expires_at: Date | null;
}

/** Tries per shot before the job is failed: the first, and one resubmission. */
const SHOT_TRIES = 2;
/** How long a failed shot waits before it is tried again. */
const RETRY_AFTER_SECONDS = 300;
const OPEN: SceneMvStatus[] = ['draft', 'queued', 'generating', 'composing'];
/** The forward moves. Failing is allowed from every stage that is under way; cancelling has its own door. */
const MOVES: Record<string, SceneMvStatus[]> = {
  queued: ['generating', 'failed'],
  generating: ['composing', 'failed'],
  composing: ['ready', 'failed'],
};

const ER_DUP_ENTRY = 1062;

export async function createSceneMvDraft(p: {
  ownerId: string;
  trackId: string;
  style: string;
  description: string | null;
  clipStart: number;
  clipEnd: number;
  timingsSha: string | null;
  shots: string[];
}): Promise<string> {
  if (!p.shots.length || p.shots.length > 12) throw new Error('a scene MV has 1–12 shots');
  const id = randomUUID();
  await withTx(async (tx) => {
    await execute(
      `INSERT INTO scene_mvs (id, owner_id, track_id, style, description, clip_start, clip_end, timings_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.ownerId, p.trackId, p.style, p.description, p.clipStart, p.clipEnd, p.timingsSha],
      tx,
    );
    for (const [idx, prompt] of p.shots.entries()) {
      await execute(`INSERT INTO scene_mv_shots (id, scene_mv_id, idx, prompt) VALUES (?, ?, ?, ?)`, [randomUUID(), id, idx, prompt], tx);
    }
  });
  return id;
}

function parseMv(row: SceneMvRow): SceneMvRow {
  return { ...row, clip_start: Number(row.clip_start), clip_end: Number(row.clip_end) };
}

export async function getSceneMv(id: string): Promise<(SceneMvRow & { shots: SceneMvShotRow[] }) | null> {
  const row = await queryOne<SceneMvRow>(
    `SELECT id, owner_id, track_id, status, style, description, clip_start, clip_end, timings_sha, output_key, failure,
            created_at, queued_at, finished_at, expires_at FROM scene_mvs WHERE id = ?`,
    [id],
  );
  if (!row) return null;
  const shots = await query<SceneMvShotRow>(`SELECT * FROM scene_mv_shots WHERE scene_mv_id = ? ORDER BY idx`, [id]);
  return { ...parseMv(row), shots: shots.map((s) => ({ ...s, idx: Number(s.idx), attempts: Number(s.attempts) })) };
}

/** Puts the owner's draft in the queue: refused when it is not theirs, not a draft, or they already have one there. */
export async function queueSceneMv(
  id: string,
  ownerId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'not_draft' | 'busy' }> {
  try {
    return await withTx(async (tx) => {
      const row = await queryOne<{ status: SceneMvStatus }>(`SELECT status FROM scene_mvs WHERE id = ? AND owner_id = ? FOR UPDATE`, [id, ownerId], tx);
      if (!row) return { ok: false, reason: 'not_found' } as const;
      if (row.status !== 'draft') return { ok: false, reason: 'not_draft' } as const;
      await execute(`UPDATE scene_mvs SET status = 'queued', queued_at = UTC_TIMESTAMP(3) WHERE id = ?`, [id], tx);
      return { ok: true } as const;
    });
  } catch (err) {
    if ((err as { errno?: number }).errno === ER_DUP_ENTRY) return { ok: false, reason: 'busy' };
    throw err;
  }
}

/** One forward move, `from` → `to`; false when the job was not at `from` or the move is not allowed. */
export async function advanceSceneMv(
  id: string,
  from: SceneMvStatus,
  to: SceneMvStatus,
  extra: { outputKey?: string; failure?: string; expiresAt?: Date } = {},
): Promise<boolean> {
  if (!MOVES[from]?.includes(to)) return false;
  if (to === 'ready' && !extra.outputKey) throw new Error('a ready scene MV needs its output');
  return withTx(async (tx) => {
    const row = await queryOne<{ status: SceneMvStatus }>(`SELECT status FROM scene_mvs WHERE id = ? FOR UPDATE`, [id], tx);
    if (row?.status !== from) return false;
    const ends = to === 'ready' || to === 'failed';
    await execute(
      `UPDATE scene_mvs SET status = ?, output_key = COALESCE(?, output_key), failure = ?, expires_at = COALESCE(?, expires_at),
              finished_at = ${ends ? 'UTC_TIMESTAMP(3)' : 'finished_at'} WHERE id = ?`,
      [to, extra.outputKey ?? null, to === 'failed' ? (extra.failure ?? 'failed').slice(0, 64) : null, extra.expiresAt ?? null, id],
      tx,
    );
    if (to === 'failed') {
      await execute(`UPDATE scene_mv_shots SET status = 'cancelled' WHERE scene_mv_id = ? AND status IN ('pending','running','failed')`, [id], tx);
    }
    return true;
  });
}

/** The owner's cancel, from any stage before ready. Shots already drawn are kept; the rest are stopped. */
export async function cancelSceneMv(id: string, ownerId: string): Promise<boolean> {
  return withTx(async (tx) => {
    const row = await queryOne<{ status: SceneMvStatus }>(`SELECT status FROM scene_mvs WHERE id = ? AND owner_id = ? FOR UPDATE`, [id, ownerId], tx);
    if (!row || !OPEN.includes(row.status)) return false;
    await execute(`UPDATE scene_mvs SET status = 'cancelled', finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [id], tx);
    await execute(`UPDATE scene_mv_shots SET status = 'cancelled' WHERE scene_mv_id = ? AND status IN ('pending','running','failed')`, [id], tx);
    return true;
  });
}

/**
 * The next shot to draw, or none: the lowest shot that is waiting or may be
 * tried again, of the job that has waited longest since its last shot — a job
 * that has had nothing yet first, then round the others in turn, so one long
 * job cannot hold the machine while another waits (docs/AI_SCENE_MV_SPEC.md). None while any shot is running,
 * anywhere — one GPU, one shot. A named lock makes check-and-claim one step
 * across every worker.
 */
export async function claimNextShot(worker: string, opts: { retryAfterSeconds?: number } = {}): Promise<SceneMvShotRow | null> {
  const conn: mysql.PoolConnection = await db().getConnection();
  try {
    const got = await queryOne<{ ok: number | null }>(`SELECT GET_LOCK('yuha_scene_mv_shot_claim', 10) AS ok`, [], conn);
    if (Number(got?.ok) !== 1) return null;
    try {
      if (await queryOne(`SELECT id FROM scene_mv_shots WHERE status = 'running' LIMIT 1`, [], conn)) return null;
      const next = await queryOne<{ id: string }>(
        `SELECT s.id FROM scene_mv_shots s JOIN scene_mvs m ON m.id = s.scene_mv_id
          WHERE m.status = 'generating'
            AND (s.status = 'pending'
                 OR (s.status = 'failed' AND s.attempts < ? AND s.finished_at <= UTC_TIMESTAMP(3) - INTERVAL ? SECOND))
          ORDER BY (SELECT MAX(x.started_at) FROM scene_mv_shots x WHERE x.scene_mv_id = m.id) IS NOT NULL,
                   (SELECT MAX(x.started_at) FROM scene_mv_shots x WHERE x.scene_mv_id = m.id),
                   m.queued_at, m.id, s.idx
          LIMIT 1`,
        [SHOT_TRIES, opts.retryAfterSeconds ?? RETRY_AFTER_SECONDS],
        conn,
      );
      if (!next) return null;
      await execute(
        `UPDATE scene_mv_shots SET status = 'running', attempts = attempts + 1, claimed_by = ?, started_at = UTC_TIMESTAMP(3), failure = NULL,
              -- A new try is a new clip: asking after the failed one again would spend every try on one failure.
              provider_clip_id = NULL, clip_key = NULL
          WHERE id = ? AND status IN ('pending','failed')`,
        [worker.slice(0, 64), next.id],
        conn,
      );
      const row = await queryOne<SceneMvShotRow>(`SELECT * FROM scene_mv_shots WHERE id = ?`, [next.id], conn);
      if (!row || row.status !== 'running' || row.claimed_by !== worker.slice(0, 64)) return null;
      return { ...row, idx: Number(row.idx), attempts: Number(row.attempts) };
    } finally {
      await queryOne(`SELECT RELEASE_LOCK('yuha_scene_mv_shot_claim')`, [], conn);
    }
  } finally {
    conn.release();
  }
}

/** The running shot, if any (there is at most one), with the job it belongs to. */
export async function runningShot(): Promise<(SceneMvShotRow & { owner_id: string; job_status: SceneMvStatus; clip_start: number; clip_end: number; shot_count: number }) | null> {
  const row = await queryOne<SceneMvShotRow & { owner_id: string; job_status: SceneMvStatus; clip_start: number; clip_end: number; shot_count: number }>(
    `SELECT s.*, m.owner_id, m.status AS job_status, m.clip_start, m.clip_end,
            (SELECT COUNT(*) FROM scene_mv_shots c WHERE c.scene_mv_id = m.id) AS shot_count
       FROM scene_mv_shots s JOIN scene_mvs m ON m.id = s.scene_mv_id
      WHERE s.status = 'running' ORDER BY s.started_at LIMIT 1`,
  );
  if (!row) return null;
  return { ...row, idx: Number(row.idx), attempts: Number(row.attempts), clip_start: Number(row.clip_start), clip_end: Number(row.clip_end), shot_count: Number(row.shot_count) };
}

/** The provider's id for the clip a running shot asked for, so a restarted worker asks after it rather than asking again. */
export async function recordShotSubmitted(shotId: string, providerClipId: string): Promise<void> {
  await execute(`UPDATE scene_mv_shots SET provider_clip_id = ? WHERE id = ? AND status = 'running'`, [providerClipId.slice(0, 64), shotId]);
}

/**
 * Hands a running shot back to the queue without spending a try: the
 * service was full or unreachable, which is the platform's, not the shot's.
 */
export async function releaseShot(shotId: string): Promise<void> {
  await execute(
    `UPDATE scene_mv_shots SET status = 'pending', attempts = GREATEST(attempts, 1) - 1, claimed_by = NULL, started_at = NULL, provider_clip_id = NULL
      WHERE id = ? AND status = 'running' AND provider_clip_id IS NULL`,
    [shotId],
  );
}

/** Queued jobs start being made: every one of them, since shots, not jobs, take turns on the GPU. */
export async function startQueuedSceneMvs(): Promise<number> {
  const rows = await query<{ id: string }>(`SELECT id FROM scene_mvs WHERE status = 'queued' ORDER BY queued_at`);
  let n = 0;
  for (const r of rows) if (await advanceSceneMv(r.id, 'queued', 'generating')) n += 1;
  return n;
}

/** Jobs whose every shot is drawn move on to composing. */
export async function finishDrawnSceneMvs(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT m.id FROM scene_mvs m WHERE m.status = 'generating'
        AND NOT EXISTS (SELECT 1 FROM scene_mv_shots s WHERE s.scene_mv_id = m.id AND s.status <> 'succeeded')`,
  );
  const moved: string[] = [];
  for (const r of rows) if (await advanceSceneMv(r.id, 'generating', 'composing')) moved.push(r.id);
  return moved;
}

/**
 * How a running shot ended. A shot whose job was cancelled meanwhile stays
 * cancelled, whatever it says. The last allowed failure fails the job.
 */
export async function finishShot(
  shotId: string,
  outcome: { status: 'succeeded'; clipKey: string } | { status: 'failed'; failure: string },
): Promise<void> {
  const ref = await queryOne<{ scene_mv_id: string }>(`SELECT scene_mv_id FROM scene_mv_shots WHERE id = ?`, [shotId]);
  if (!ref) return;
  await withTx(async (tx) => {
    // The job first, then the shot: the order cancelSceneMv takes them in.
    const mv = await queryOne<{ status: SceneMvStatus }>(`SELECT status FROM scene_mvs WHERE id = ? FOR UPDATE`, [ref.scene_mv_id], tx);
    const shot = await queryOne<{ status: SceneMvShotStatus; attempts: number }>(
      `SELECT status, attempts FROM scene_mv_shots WHERE id = ? FOR UPDATE`,
      [shotId],
      tx,
    );
    if (!mv || !shot || shot.status !== 'running') return;
    if (mv.status !== 'generating') {
      await execute(`UPDATE scene_mv_shots SET status = 'cancelled', finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [shotId], tx);
      return;
    }
    if (outcome.status === 'succeeded') {
      await execute(`UPDATE scene_mv_shots SET status = 'succeeded', clip_key = ?, finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [outcome.clipKey, shotId], tx);
      return;
    }
    await execute(`UPDATE scene_mv_shots SET status = 'failed', failure = ?, finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [outcome.failure.slice(0, 64), shotId], tx);
    if (Number(shot.attempts) >= SHOT_TRIES) {
      await execute(`UPDATE scene_mvs SET status = 'failed', failure = 'shot_failed', finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [ref.scene_mv_id], tx);
      await execute(`UPDATE scene_mv_shots SET status = 'cancelled' WHERE scene_mv_id = ? AND status IN ('pending','failed') AND id <> ?`, [ref.scene_mv_id, shotId], tx);
    }
  });
}

/** Every stored object a song's scene MVs hold: finished MVs and drawn shots. */
export async function sceneMvStorageKeys(trackId: string): Promise<string[]> {
  const rows = await query<{ k: string }>(
    `SELECT output_key AS k FROM scene_mvs WHERE track_id = ? AND output_key IS NOT NULL
     UNION SELECT s.clip_key FROM scene_mv_shots s JOIN scene_mvs m ON m.id = s.scene_mv_id
      WHERE m.track_id = ? AND s.clip_key IS NOT NULL`,
    [trackId, trackId],
  );
  return rows.map((r) => r.k);
}

/**
 * First step of removing a song's scene MVs: stop any being made and drop what
 * the person wrote, at once, whether or not the stored files then go.
 */
export async function stopAndScrubSceneMvs(trackId: string): Promise<void> {
  await withTx(async (tx) => {
    await query(`SELECT id FROM scene_mvs WHERE track_id = ? FOR UPDATE`, [trackId], tx);
    await execute(
      `UPDATE scene_mvs SET status = IF(status IN ('draft','queued','generating','composing'), 'cancelled', status),
              finished_at = COALESCE(finished_at, UTC_TIMESTAMP(3)), description = NULL WHERE track_id = ?`,
      [trackId],
      tx,
    );
    await execute(
      `UPDATE scene_mv_shots s JOIN scene_mvs m ON m.id = s.scene_mv_id
          SET s.prompt = '', s.status = IF(s.status = 'succeeded', s.status, 'cancelled') WHERE m.track_id = ?`,
      [trackId],
      tx,
    );
  });
}

/** Last step, once the stored files are gone: the records themselves. */
export async function deleteSceneMvs(trackId: string): Promise<void> {
  await execute(`DELETE FROM scene_mvs WHERE track_id = ?`, [trackId]);
}

/** A shot's file has been deleted: its record no longer points at it. */
export async function forgetShotClips(sceneMvId: string, shotId: string): Promise<void> {
  await execute(`UPDATE scene_mv_shots SET clip_key = NULL WHERE id = ? AND scene_mv_id = ?`, [shotId, sceneMvId]);
}

/** A song's scene MVs, newest first. */
export async function listSceneMvsForTrack(trackId: string): Promise<SceneMvRow[]> {
  const rows = await query<SceneMvRow>(
    `SELECT id, owner_id, track_id, status, style, description, clip_start, clip_end, timings_sha, output_key, failure,
            created_at, queued_at, finished_at, expires_at FROM scene_mvs WHERE track_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
    [trackId],
  );
  return rows.map(parseMv);
}

/** The person's MV in the queue or being made, if any (there is at most one). */
export async function activeSceneMvFor(ownerId: string): Promise<string | null> {
  return (await queryOne<{ id: string }>(`SELECT id FROM scene_mvs WHERE active_owner = ?`, [ownerId]))?.id ?? null;
}

/** The owner's edit of a draft's storyboard; false unless it is their draft. */
export async function replaceDraftShots(id: string, ownerId: string, shots: string[]): Promise<boolean> {
  if (!shots.length || shots.length > 12) throw new Error('a scene MV has 1–12 shots');
  return withTx(async (tx) => {
    const row = await queryOne<{ status: SceneMvStatus }>(`SELECT status FROM scene_mvs WHERE id = ? AND owner_id = ? FOR UPDATE`, [id, ownerId], tx);
    if (row?.status !== 'draft') return false;
    await execute(`DELETE FROM scene_mv_shots WHERE scene_mv_id = ?`, [id], tx);
    for (const [idx, prompt] of shots.entries()) {
      await execute(`INSERT INTO scene_mv_shots (id, scene_mv_id, idx, prompt) VALUES (?, ?, ?, ?)`, [randomUUID(), id, idx, prompt], tx);
    }
    return true;
  });
}

/** One MV's stored files: the finished MV and any drawn shots. */
export async function sceneMvKeys(id: string): Promise<string[]> {
  const rows = await query<{ k: string }>(
    `SELECT output_key AS k FROM scene_mvs WHERE id = ? AND output_key IS NOT NULL
     UNION SELECT clip_key FROM scene_mv_shots WHERE scene_mv_id = ? AND clip_key IS NOT NULL`,
    [id, id],
  );
  return rows.map((r) => r.k);
}

/** Stops one MV and drops what was written for it; the first step of deleting it, as for a song's. */
export async function stopAndScrubSceneMv(id: string): Promise<void> {
  await withTx(async (tx) => {
    await query(`SELECT id FROM scene_mvs WHERE id = ? FOR UPDATE`, [id], tx);
    await execute(
      `UPDATE scene_mvs SET status = IF(status IN ('draft','queued','generating','composing'), 'cancelled', status),
              finished_at = COALESCE(finished_at, UTC_TIMESTAMP(3)), description = NULL WHERE id = ?`,
      [id],
      tx,
    );
    await execute(`UPDATE scene_mv_shots SET prompt = '', status = IF(status = 'succeeded', status, 'cancelled') WHERE scene_mv_id = ?`, [id], tx);
  });
}

export async function deleteSceneMvRow(id: string): Promise<void> {
  await execute(`DELETE FROM scene_mvs WHERE id = ?`, [id]);
}

/**
 * MVs to let go of: a finished one past its keeping date, and a failed,
 * cancelled or abandoned draft a week on — what was written for any of them
 * is not kept indefinitely just because nothing came of it.
 */
export async function expiredSceneMvs(limit = 50): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM scene_mvs
      WHERE (expires_at IS NOT NULL AND expires_at < UTC_TIMESTAMP(3))
         OR (status IN ('failed','cancelled') AND finished_at < UTC_TIMESTAMP(3) - INTERVAL 7 DAY)
         OR (status = 'draft' AND created_at < UTC_TIMESTAMP(3) - INTERVAL 7 DAY)
      LIMIT ?`,
    [limit],
  );
  return rows.map((r) => r.id);
}

/** The service's ids for a scene MV's clips that were never collected: to let go of them there. */
export async function uncollectedClipIds(sceneMvId: string): Promise<string[]> {
  const rows = await query<{ p: string }>(
    `SELECT provider_clip_id AS p FROM scene_mv_shots WHERE scene_mv_id = ? AND provider_clip_id IS NOT NULL AND status <> 'succeeded'`,
    [sceneMvId],
  );
  return rows.map((r) => r.p);
}
