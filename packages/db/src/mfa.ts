import type { PoolConnection } from 'mysql2/promise';
import { execute, newId, queryOne } from './pool.js';

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
    `SELECT id, user_id, secret_encrypted, enabled, confirmed_at, recovery_codes, last_used_at, created_at, updated_at
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
