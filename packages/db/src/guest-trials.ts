import type { PoolConnection } from 'mysql2/promise';
import { execute, newId, query, queryOne } from './pool.js';
import { getUser, type UserRow } from './users.js';

/**
 * Trials without an account (docs/GROWTH_SPEC.md, part three).
 *
 * A guest is a users row with role 'guest' and provider 'guest'; its email is
 * a reserved-domain placeholder (RFC 2606 `.invalid`), because the column is
 * NOT NULL and unique and a guest has none. `guest_trials` holds the two keyed
 * hashes the limits are counted on.
 */
export interface GuestTrialRow {
  user_id: string;
  device_ref: string | null;
  ip_ref: string | null;
  created_at: Date;
  claimed_by: string | null;
  claimed_at: Date | null;
  purged_at: Date | null;
}

export async function insertGuest(
  params: { deviceRef: string; ipRef: string; consentVersion: string },
  tx: PoolConnection,
): Promise<UserRow> {
  const id = newId();
  await execute(
    `INSERT INTO users (id, auth_provider, external_id, email, role, age_confirmed_at, terms_accepted_at, consent_version)
     VALUES (?, 'guest', ?, ?, 'guest', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), ?)`,
    [id, id, `guest+${id}@guest.invalid`, params.consentVersion],
    tx,
  );
  await execute(`INSERT INTO guest_trials (user_id, device_ref, ip_ref) VALUES (?, ?, ?)`, [id, params.deviceRef, params.ipRef], tx);
  return (await getUser(id, tx))!;
}

/**
 * The counts the door is decided on, read under a lock on the day's rows so
 * two visitors arriving together cannot both take the last place.
 * `dayStart` is midnight in Japan, as a UTC instant.
 */
export async function trialCounts(
  params: { deviceRef: string; ipRef: string; dayStart: Date },
  tx: PoolConnection,
): Promise<{ device: number; network: number; day: number }> {
  const rows = await query<{ device_ref: string | null; ip_ref: string | null; created_at: Date }>(
    `SELECT device_ref, ip_ref, created_at FROM guest_trials
      WHERE created_at >= ? OR device_ref = ? FOR UPDATE`,
    [params.dayStart, params.deviceRef],
    tx,
  );
  const today = rows.filter((r) => r.created_at >= params.dayStart);
  return {
    device: rows.filter((r) => r.device_ref === params.deviceRef).length,
    network: today.filter((r) => r.ip_ref === params.ipRef).length,
    day: today.length,
  };
}

/** Trial songs waiting for the engine, or on it: the queue's share for guests. */
export async function openGuestJobs(tx?: PoolConnection): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM generation_jobs
      WHERE priority = 1 AND state IN ('VALIDATING','RESERVED','QUEUED','SUBMITTED','UNKNOWN','PROCESSING')`,
    [],
    tx,
  );
  return Number(row?.n ?? 0);
}

export async function getGuestTrial(userId: string, tx?: PoolConnection): Promise<GuestTrialRow | undefined> {
  return queryOne<GuestTrialRow>(
    `SELECT user_id, device_ref, ip_ref, created_at, claimed_by, claimed_at, purged_at FROM guest_trials WHERE user_id = ?`,
    [userId],
    tx,
  );
}

/**
 * A guest's songs become an account's: everything that names an owner moves
 * in one transaction. Returns the tracks that moved, for the authorship
 * records the claim writes next.
 */
export async function moveGuestOwnership(
  params: { guestId: string; userId: string },
  tx: PoolConnection,
): Promise<Array<{ id: string; created_at: Date; state: string }>> {
  const tracks = await query<{ id: string; created_at: Date; state: string }>(
    `SELECT id, created_at, state FROM tracks WHERE owner_id = ? AND deleted_at IS NULL FOR UPDATE`,
    [params.guestId],
    tx,
  );
  const move = [params.userId, params.guestId];
  await execute(`UPDATE projects SET owner_id = ? WHERE owner_id = ?`, move, tx);
  await execute(`UPDATE generation_jobs SET user_id = ? WHERE user_id = ?`, move, tx);
  await execute(`UPDATE tracks SET owner_id = ? WHERE owner_id = ?`, move, tx);
  await execute(`UPDATE asset_versions SET owner_id = ? WHERE owner_id = ?`, move, tx);
  await execute(`UPDATE share_cards SET owner_id = ? WHERE owner_id = ?`, move, tx);
  return tracks;
}

export async function markGuestClaimed(params: { guestId: string; userId: string }, tx: PoolConnection): Promise<void> {
  await execute(`UPDATE guest_trials SET claimed_by = ?, claimed_at = UTC_TIMESTAMP(3) WHERE user_id = ?`, [params.userId, params.guestId], tx);
  // The guest session ends here: the songs have a real owner now.
  await execute(
    `UPDATE users SET status = 'deleted', deleted_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND role = 'guest'`,
    [params.guestId],
    tx,
  );
}

/** Trials older than `cutoff` that nobody claimed and that are not purged yet. */
export async function listExpiredGuestTrials(cutoff: Date, limit = 50): Promise<GuestTrialRow[]> {
  return query<GuestTrialRow>(
    `SELECT user_id, device_ref, ip_ref, created_at, claimed_by, claimed_at, purged_at FROM guest_trials
      WHERE created_at < ? AND claimed_by IS NULL AND purged_at IS NULL
      ORDER BY created_at LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
    [cutoff],
  );
}

/** The device and network hashes of claimed trials made before `cutoff`, cleared. */
export async function clearClaimedTrialRefs(cutoff: Date): Promise<void> {
  await execute(
    `UPDATE guest_trials SET device_ref = NULL, ip_ref = NULL
      WHERE claimed_by IS NOT NULL AND created_at < ? AND (device_ref IS NOT NULL OR ip_ref IS NOT NULL)`,
    [cutoff],
  );
}

export async function markGuestPurged(guestId: string, tx?: PoolConnection): Promise<void> {
  await execute(`UPDATE guest_trials SET device_ref = NULL, ip_ref = NULL, purged_at = UTC_TIMESTAMP(3) WHERE user_id = ?`, [guestId], tx);
}
