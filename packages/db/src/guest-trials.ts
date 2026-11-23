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
  params: { deviceRef: string; ipRef: string },
  tx: PoolConnection,
): Promise<UserRow> {
  const id = newId();
  await execute(
    `INSERT INTO users (id, auth_provider, external_id, email, role, age_confirmed_at, terms_accepted_at)
     VALUES (?, 'guest', ?, ?, 'guest', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [id, id, `guest+${id}@guest.invalid`],
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
