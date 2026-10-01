import type { PoolConnection } from 'mysql2/promise';
import { execute, newId, query, queryOne } from './pool.js';

export type AccountDeletionStatus =
  | 'requested'
  | 'verified'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'cancelled';

/**
 * The states that still have work in them. `failed` is one: it is claimable
 * and it left objects behind. `executing` is one because a run can die.
 */
const OPEN_STATUSES = "'requested','verified','executing','failed'";

export interface AccountDeletionRow {
  id: string;
  user_id: string;
  ticket: string;
  status: AccountDeletionStatus;
  reason: string | null;
  requested_at: Date;
  verified_by: string | null;
  verified_at: Date | null;
  executed_at: Date | null;
  outcome: unknown;
  failure: string | null;
}

const COLUMNS = `id, user_id, ticket, status, reason, requested_at,
                 verified_by, verified_at, executed_at, outcome, failure`;

/**
 * Open a deletion request, or hand back the one that is already open.
 *
 * Asking twice is not an error and must not produce two erasures of the same
 * account: the second caller gets the first ticket back. Which is also what
 * someone who lost the email wants — they are told the ticket again rather
 * than starting a parallel process nobody is tracking.
 */
export async function openAccountDeletion(params: {
  userId: string;
  reason?: string | null;
}): Promise<{ row: AccountDeletionRow; created: boolean }> {
  const existing = await queryOne<AccountDeletionRow>(
    `SELECT ${COLUMNS} FROM account_deletions
      WHERE user_id = ? AND status IN (${OPEN_STATUSES})
      ORDER BY requested_at DESC LIMIT 1`,
    [params.userId],
  );
  if (existing) return { row: existing, created: false };

  const id = newId();
  const ticket = newId();
  await execute(
    `INSERT INTO account_deletions (id, user_id, ticket, status, reason)
     VALUES (?, ?, ?, 'requested', ?)`,
    [id, params.userId, ticket, params.reason ?? null],
  );
  const row = await getAccountDeletion(id);
  if (!row) throw new Error('account deletion row vanished immediately after insert');
  return { row, created: true };
}

export async function getAccountDeletion(id: string): Promise<AccountDeletionRow | undefined> {
  return queryOne<AccountDeletionRow>(`SELECT ${COLUMNS} FROM account_deletions WHERE id = ?`, [id]);
}

export async function listAccountDeletions(params: {
  status?: AccountDeletionStatus;
  limit: number;
}): Promise<AccountDeletionRow[]> {
  if (params.status) {
    return query<AccountDeletionRow>(
      `SELECT ${COLUMNS} FROM account_deletions WHERE status = ?
        ORDER BY requested_at ASC LIMIT ?`,
      [params.status, params.limit],
    );
  }
  return query<AccountDeletionRow>(
    `SELECT ${COLUMNS} FROM account_deletions ORDER BY requested_at DESC LIMIT ?`,
    [params.limit],
  );
}

/**
 * Record that a human confirmed the person asking owns the account.
 *
 * Guarded on the current status rather than read-then-write: two operators
 * verifying at once must not both proceed to erase. The caller is told how
 * many rows moved, and zero means somebody else got there first.
 */
export async function markAccountDeletionVerified(params: {
  id: string;
  verifiedBy: string;
}): Promise<boolean> {
  const { affectedRows } = await execute(
    `UPDATE account_deletions
        SET status = 'verified', verified_by = ?, verified_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND status = 'requested'`,
    [params.verifiedBy, params.id],
  );
  return affectedRows === 1;
}

/**
 * Claim a request for execution, so two runs cannot share one.
 *
 * Moves to `executing`, not `executed`. Writing the finished state before
 * doing the work meant a run that died — SIGKILL, the worker's 15s exit —
 * left a row that read exactly like a success, `outcome` NULL, and that no
 * claim would pick up again: a half-erased account nobody could tell from a
 * finished one. A row left `executing` is claimable once it is stale, so a
 * dead run is taken over rather than abandoned.
 *
 * `failed` is claimable as well as `verified`. A run that could not reach
 * storage leaves objects behind and marks itself failed; without this there
 * was no transition out of that state and a half-erased account could only be
 * finished by the user asking again, which an operator cannot do for them.
 * Identity was already verified — that fact does not expire because a bucket
 * was briefly unreachable.
 */
export async function claimAccountDeletion(id: string): Promise<boolean> {
  const { affectedRows } = await execute(
    `UPDATE account_deletions
        SET status = 'executing', executed_at = UTC_TIMESTAMP(3), failure = NULL
      WHERE id = ?
        AND (status IN ('verified', 'failed')
             OR (status = 'executing'
                 AND updated_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE)))`,
    [id, STALE_EXECUTION_MINUTES],
  );
  return affectedRows === 1;
}

/**
 * How long a run may be in flight before another may take it over.
 *
 * An erasure is a bounded loop over one account's assets, so fifteen minutes
 * is far beyond a healthy run and far short of leaving a crashed one stuck
 * forever. Without this, a worker killed mid-erasure left a row nothing could
 * ever claim again.
 */
const STALE_EXECUTION_MINUTES = 15;

/** Mark a claimed run finished. Only the run that claimed it should call this. */
export async function completeAccountDeletion(id: string): Promise<void> {
  await execute(
    `UPDATE account_deletions SET status = 'executed' WHERE id = ? AND status = 'executing'`,
    [id],
  );
}

export async function recordAccountDeletionOutcome(params: {
  id: string;
  outcome: unknown;
}): Promise<void> {
  await execute(`UPDATE account_deletions SET outcome = ? WHERE id = ?`, [
    JSON.stringify(params.outcome),
    params.id,
  ]);
}

export async function failAccountDeletion(params: { id: string; failure: string }): Promise<void> {
  await execute(
    `UPDATE account_deletions SET status = 'failed', failure = ? WHERE id = ?`,
    [params.failure.slice(0, 500), params.id],
  );
}

/**
 * Erase the account's own fields, keeping the row.
 *
 * The row stays because orders and payments reference it and those are kept
 * for the statutory period — a hard DELETE would either fail on the foreign
 * key or orphan the financial record this product is required to hold. What
 * leaves is everything that identifies the person: the address, the name they
 * chose, the provider subject that could be used to sign in again.
 *
 * `external_id` is overwritten rather than nulled: it is NOT NULL and part of
 * a unique key with the provider, so the same Google account signing in later
 * creates a new, empty user instead of resurrecting this one.
 */
export async function anonymiseUser(
  params: { userId: string; tombstone: string },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE users
        SET email = ?, display_name = NULL, external_id = ?, marketing_opt_in = 0,
            status = 'deleted', deleted_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?`,
    [`deleted+${params.tombstone}@invalid.test`, `deleted-${params.tombstone}`, params.userId],
    tx,
  );
}
