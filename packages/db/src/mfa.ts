import type { PoolConnection } from 'mysql2/promise';
import { execute, newId, query, queryOne } from './pool.js';

/**
 * MFA factor storage. The secret arrives already encrypted (AES-256-GCM) and
 * recovery codes arrive already hashed — the database never sees either in
 * the clear, and neither do the logs.
 */
export interface MfaFactorRow {
  id: string;
  user_id: string;
  secret_encrypted: string;
  enabled: boolean;
  confirmed_at: Date | null;
  recovery_codes: string[];
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** Consecutive failed codes against this account, any address. */
  failed_attempts: number;
  locked_until: Date | null;
}

function normalise(row: MfaFactorRow): MfaFactorRow {
  if (typeof row.recovery_codes === 'string') {
    try {
      row.recovery_codes = JSON.parse(row.recovery_codes) as string[];
    } catch {
      row.recovery_codes = [];
    }
  }
  return row;
}

/** Creates or replaces the (single) pending factor for a user. */
export async function upsertMfaFactor(
  params: { userId: string; secretEncrypted: string; recoveryHashes: string[] },
  tx?: PoolConnection,
): Promise<MfaFactorRow> {
  await execute(
    `INSERT INTO mfa_factors (id, user_id, secret_encrypted, recovery_codes, spent_challenges)
     VALUES (?, ?, ?, ?, JSON_ARRAY())
     ON DUPLICATE KEY UPDATE
       secret_encrypted = VALUES(secret_encrypted),
       recovery_codes = VALUES(recovery_codes),
       enabled = 0,
       confirmed_at = NULL,
       updated_at = UTC_TIMESTAMP(3)`,
    [newId(), params.userId, params.secretEncrypted, JSON.stringify(params.recoveryHashes)],
    tx,
  );
  const row = await getMfaFactor(params.userId, tx);
  if (!row) throw new Error('mfa factor upsert failed to read back');
  return row;
}

export async function getMfaFactor(userId: string, tx?: PoolConnection): Promise<MfaFactorRow | undefined> {
  const row = await queryOne<MfaFactorRow>(
    // Named explicitly rather than SELECT *, and so a new column has to be
    // added here too. `failed_attempts` and `locked_until` were not, and the
    // row type said they existed — so the lock check read `undefined` and let
    // every attempt through while the code around it looked correct.
    `SELECT id, user_id, secret_encrypted, enabled, confirmed_at, recovery_codes, last_used_at,
            failed_attempts, locked_until, created_at, updated_at
       FROM mfa_factors WHERE user_id = ?`,
    [userId],
    tx,
  );
  return row ? normalise(row) : undefined;
}

export async function getEnabledMfaFactor(userId: string, tx?: PoolConnection): Promise<MfaFactorRow | undefined> {
  const row = await getMfaFactor(userId, tx);
  return row?.enabled ? row : undefined;
}

export async function enableMfaFactor(userId: string, tx?: PoolConnection): Promise<void> {
  await execute(
    `UPDATE mfa_factors SET enabled = 1, confirmed_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
      WHERE user_id = ?`,
    [userId],
    tx,
  );
}

export async function disableMfaFactor(userId: string, tx?: PoolConnection): Promise<boolean> {
  const res = await execute(`DELETE FROM mfa_factors WHERE user_id = ?`, [userId], tx);
  return res.affectedRows > 0;
}

/**
 * Counts a failed code against the account and locks it once there have been
 * enough in a row.
 *
 * Per account, not per address: the per-IP limit is multiplied by however many
 * addresses an attacker has, and a six-digit code does not survive that. The
 * lock is short — this is a speed limit, not a punishment, and an account its
 * owner cannot get back into is its own kind of failure.
 *
 * Returns the count after the increment so the caller can say how it went.
 */
export async function recordMfaFailure(
  params: { userId: string; maxAttempts: number; lockSeconds: number },
  tx?: PoolConnection,
): Promise<{ attempts: number; lockedUntil: Date | null }> {
  // Two statements, each correct on its own, rather than one that depends on
  // MySQL evaluating a multi-column SET left to right: inside a single UPDATE
  // a later assignment reads the ALREADY-updated value, so
  // `failed_attempts = failed_attempts + 1, locked_until = CASE WHEN
  // failed_attempts + 1 >= 5 ...` tests old + 2 and locked the account on the
  // fourth wrong code. The lock then refused the fifth even when it was right.
  //
  // The increment is atomic; the lock below is derived from the stored count
  // and is idempotent, so concurrent failures can only err towards locking.
  await execute(
    `UPDATE mfa_factors
        SET failed_attempts = failed_attempts + 1, updated_at = UTC_TIMESTAMP(3)
      WHERE user_id = ?`,
    [params.userId],
    tx,
  );
  await execute(
    `UPDATE mfa_factors
        SET locked_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
            updated_at = UTC_TIMESTAMP(3)
      WHERE user_id = ?
        AND failed_attempts >= ?
        AND (locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))`,
    [params.lockSeconds, params.userId, params.maxAttempts],
    tx,
  );
  const rows = await query<{ failed_attempts: number; locked_until: Date | null }>(
    `SELECT failed_attempts, locked_until FROM mfa_factors WHERE user_id = ?`,
    [params.userId],
    tx,
  );
  const row = rows[0];
  return { attempts: Number(row?.failed_attempts ?? 0), lockedUntil: row?.locked_until ?? null };
}

/** A correct code clears the slate, including any lock it had already earned. */
export async function clearMfaFailures(userId: string, tx?: PoolConnection): Promise<void> {
  await execute(
    `UPDATE mfa_factors
        SET failed_attempts = 0, locked_until = NULL, updated_at = UTC_TIMESTAMP(3)
      WHERE user_id = ?`,
    [userId],
    tx,
  );
}

export async function touchMfaFactor(userId: string, tx?: PoolConnection): Promise<void> {
  await execute(`UPDATE mfa_factors SET last_used_at = UTC_TIMESTAMP(3) WHERE user_id = ?`, [userId], tx);
}

/** True when this challenge token was already redeemed (single-use). */
export async function isChallengeSpent(userId: string, hash: string): Promise<boolean> {
  const row = await queryOne<{ spent: string[] }>(
    `SELECT JSON_TABLE(spent_challenges, '$[*]' COLUMNS(h VARCHAR(64) PATH '$')) AS spent
       FROM (SELECT spent_challenges) AS t, JSON_TABLE(spent_challenges, '$[*]' COLUMNS(h VARCHAR(64) PATH '$')) AS jt
       JOIN mfa_factors f ON f.user_id = ?
      LIMIT 1`,
    [userId],
  ).catch(() => null);
  return !!row && Array.isArray(row.spent) && row.spent.includes(hash);
}

/**
 * Redeems a challenge exactly once: the JSON_MERGE only lands if this hash is
 * not already in the array, so concurrent redemptions cannot both win.
 */
export async function redeemChallenge(userId: string, hash: string, tx?: PoolConnection): Promise<boolean> {
  const res = await execute(
    `UPDATE mfa_factors
        SET spent_challenges = JSON_ARRAY_APPEND(COALESCE(NULLIF(spent_challenges, 'null'), JSON_ARRAY()), '$', ?),
            last_used_at = UTC_TIMESTAMP(3)
      WHERE user_id = ?
        AND NOT JSON_CONTAINS(COALESCE(NULLIF(spent_challenges, 'null'), JSON_ARRAY()), JSON_QUOTE(?))`,
    [hash, userId, hash],
    tx,
  );
  return res.affectedRows > 0;
}

/**
 * Consumes one recovery code: the update only matches when the hash list
 * still contains it, so two parallel attempts cannot both spend code #k.
 */
export async function consumeRecoveryCode(
  params: { userId: string; hash: string },
  tx?: PoolConnection,
): Promise<boolean> {
  const res = await execute(
    `UPDATE mfa_factors
        SET recovery_codes = JSON_REMOVE(
              recovery_codes,
              JSON_UNQUOTE(JSON_SEARCH(recovery_codes, 'one', ?))
            ),
            last_used_at = UTC_TIMESTAMP(3),
            updated_at = UTC_TIMESTAMP(3)
      WHERE user_id = ? AND JSON_SEARCH(recovery_codes, 'one', ?) IS NOT NULL`,
    [params.hash, params.userId, params.hash],
    tx,
  );
  return res.affectedRows > 0;
}
