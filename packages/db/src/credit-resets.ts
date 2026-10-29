import type { PoolConnection } from 'mysql2/promise';
import { getBalance, grantUnits } from './ledger.js';
import { execute, lockUserEntitlements, newId, query, queryOne } from './pool.js';

/**
 * Credit resets (migration 0023, docs/CREDIT_RESET.md).
 *
 * An operator, when they choose, tops every active account up to `floor`
 * counting everything it holds, and gives every account that paid since the
 * previous reset `bonus` more. Both are `credit_reset` batches with no expiry
 * date of their own: the NEXT reset expires them, and `reserveUnit` spends
 * them before anything else, so a customer is never left holding paid credits
 * while free ones that are about to vanish sit unused.
 *
 * The run goes account by account, one transaction each, and advances the
 * reset's cursor in the same transaction as the account's grants: interrupted
 * anywhere, running it again continues after the last account finished, and
 * the grants' (user, source, source_ref) uniqueness means an account is never
 * paid twice even if two runners overlap.
 */
export interface CreditResetRow {
  id: string;
  idempotency_key: string;
  actor_id: string;
  reason: string;
  floor_units: number;
  bonus_units: number;
  window_start: Date;
  status: 'running' | 'done';
  cursor_user_id: string | null;
  users_seen: number;
  users_topped: number;
  units_topped: number;
  users_bonus: number;
  units_bonus: number;
  created_at: Date;
  finished_at: Date | null;
}

/** Sources that mean the account paid: a pack bought, or a subscription period paid for. */
const PAID_SOURCES = `('one_time_order','subscription_period')`;

/**
 * Batch `b` was paid for and not refunded in full (docs/CREDIT_RESET.md).
 *
 * This was `b.status <> 'revoked'`: the credits standing in for the money.
 * Buy five, use one, refund in full, and four are revoked while the used one
 * keeps the batch active — so a refunded buyer kept qualifying for the paid
 * bonus. The money says it: a one-time order whose status is `refunded`, or
 * a subscription period whose recorded refunds reach what the period cost.
 * A partial refund still paid for something.
 */
const PAID_NOT_REFUNDED = (b: string) => `${b}.source IN ${PAID_SOURCES} AND ${b}.status <> 'revoked'
  AND NOT EXISTS (SELECT 1 FROM orders o WHERE ${b}.source = 'one_time_order' AND o.id = ${b}.source_ref AND o.status = 'refunded')
  AND NOT (${b}.source = 'subscription_period' AND COALESCE((
        SELECT -SUM(p.amount_minor) FROM payments p
         WHERE p.kind = 'refund' AND p.status = 'succeeded'
           AND p.stripe_invoice_id = SUBSTRING_INDEX(${b}.source_ref, ':', -1)), 0)
      >= COALESCE((SELECT pc.amount_minor FROM product_catalog pc
                    WHERE pc.price_key = ${b}.product_key AND pc.version = ${b}.price_version), 1))`;
/** The first reset looks this far back for payments. */
const FIRST_WINDOW_DAYS = 30;

export async function getCreditReset(id: string): Promise<CreditResetRow | null> {
  return (await queryOne<CreditResetRow>(`SELECT * FROM credit_resets WHERE id = ?`, [id])) ?? null;
}

export async function listCreditResets(limit = 10): Promise<CreditResetRow[]> {
  return query<CreditResetRow>(`SELECT * FROM credit_resets ORDER BY created_at DESC, id DESC LIMIT ?`, [limit]);
}

/** Where the next reset's payment window starts: the latest reset, or 30 days back. */
export async function nextResetWindowStart(): Promise<Date> {
  const last = await queryOne<{ created_at: Date }>(`SELECT created_at FROM credit_resets ORDER BY created_at DESC LIMIT 1`);
  return last?.created_at ?? new Date(Date.now() - FIRST_WINDOW_DAYS * 86400_000);
}

/**
 * Starts a reset, or returns the one this key already started. Refuses (null
 * `created` and the blocking row) while another reset is unfinished, so two
 * cannot interleave and expire each other's grants.
 */
export async function createCreditReset(
  params: { idempotencyKey: string; actorId: string; reason: string; floor: number; bonus: number },
  tx: PoolConnection,
): Promise<{ reset: CreditResetRow; created: boolean } | { blockedBy: CreditResetRow }> {
  // One reset at a time. A locking read over the whole (small) table takes
  // next-key locks on every row and gap, so a concurrent start blocks here
  // until this one commits, then sees it.
  await query(`SELECT id FROM credit_resets FOR UPDATE`, [], tx);
  const same = await queryOne<CreditResetRow>(`SELECT * FROM credit_resets WHERE idempotency_key = ?`, [params.idempotencyKey], tx);
  if (same) return { reset: same, created: false };
  const running = await queryOne<CreditResetRow>(`SELECT * FROM credit_resets WHERE status = 'running' LIMIT 1`, [], tx);
  if (running) return { blockedBy: running };
  const last = await queryOne<{ created_at: Date }>(`SELECT created_at FROM credit_resets ORDER BY created_at DESC LIMIT 1`, [], tx);
  const windowStart = last?.created_at ?? new Date(Date.now() - FIRST_WINDOW_DAYS * 86400_000);
  const id = newId();
  await execute(
    `INSERT INTO credit_resets (id, idempotency_key, actor_id, reason, floor_units, bonus_units, window_start)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, params.idempotencyKey, params.actorId, params.reason, params.floor, params.bonus, windowStart],
    tx,
  );
  return { reset: (await queryOne<CreditResetRow>(`SELECT * FROM credit_resets WHERE id = ?`, [id], tx))!, created: true };
}

/** The next accounts a reset reaches: active, not deleted, after the cursor, in id order. */
export async function accountsAfter(cursor: string | null, limit: number): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM users
      WHERE status = 'active' AND deleted_at IS NULL AND id > ?
      ORDER BY id LIMIT ?`,
    [cursor ?? '', limit],
  );
  return rows.map((r) => r.id);
}

/**
 * One account's share of a reset, and the cursor past it, in one transaction.
 * Returns what it gave; zero for an account already done by this reset.
 */
export async function resetAccount(reset: CreditResetRow, userId: string, tx: PoolConnection): Promise<{ topped: number; bonus: number }> {
  /*
   * Only while this reset is still the one running, read under the reset
   * row's lock in this transaction. The runner's guard was an in-process
   * Set, so on two pods a runner could still be walking reset A's accounts
   * after A finished and B began; its next account expired B's credits and
   * gave nothing back (review S1). Locked here, `finishCreditReset` and a
   * new reset's creation wait for the account in hand, and the next one
   * sees A is done.
   */
  const live = await queryOne<{ status: string }>(`SELECT status FROM credit_resets WHERE id = ? FOR UPDATE`, [reset.id], tx);
  if (live?.status !== 'running') return { topped: 0, bonus: 0 };

  await lockUserEntitlements(userId, tx);
  const prefix = `${reset.id}:`;

  // Earlier resets' credits end now — earlier only: never a newer reset's,
  // whatever a stale caller holds. Expiry is by date, as for every other
  // batch, so the ledger needs no entry and reconciliation is untouched.
  await execute(
    `UPDATE entitlement_batches b
       JOIN credit_resets r ON r.id = SUBSTRING_INDEX(b.source_ref, ':', 1)
        SET b.expires_at = UTC_TIMESTAMP(3), b.updated_at = UTC_TIMESTAMP(3)
      WHERE b.user_id = ? AND b.source = 'credit_reset' AND b.status = 'active'
        AND r.id <> ? AND r.created_at <= ?
        AND (b.expires_at IS NULL OR b.expires_at > UTC_TIMESTAMP(3))`,
    [userId, reset.id, reset.created_at],
    tx,
  );

  const mine = await query<{ source_ref: string }>(
    `SELECT source_ref FROM entitlement_batches WHERE user_id = ? AND source = 'credit_reset' AND LEFT(source_ref, ?) = ?`,
    [userId, prefix.length, prefix],
    tx,
  );
  const has = (part: string) => mine.some((r) => r.source_ref === `${prefix}${part}`);

  let topped = 0;
  if (!has('floor')) {
    const { available } = await getBalance(userId, tx);
    topped = Math.max(0, reset.floor_units - available);
    if (topped > 0) {
      await grantUnits(
        { userId, source: 'credit_reset', sourceRef: `${prefix}floor`, units: topped, reason: `credit_reset:${reset.id}:floor`, actorId: reset.actor_id },
        tx,
      );
    }
  }

  let bonus = 0;
  if (reset.bonus_units > 0 && !has('bonus')) {
    const paid = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM entitlement_batches b
        WHERE b.user_id = ? AND ${PAID_NOT_REFUNDED('b')} AND b.created_at > ?`,
      [userId, reset.window_start],
      tx,
    );
    if (Number(paid?.n ?? 0) > 0) {
      bonus = reset.bonus_units;
      await grantUnits(
        { userId, source: 'credit_reset', sourceRef: `${prefix}bonus`, units: bonus, reason: `credit_reset:${reset.id}:bonus`, actorId: reset.actor_id },
        tx,
      );
    }
  }

  // Advance only forward: a second runner that already passed this account changes nothing.
  await execute(
    `UPDATE credit_resets
        SET cursor_user_id = ?,
            users_seen = users_seen + 1,
            users_topped = users_topped + ?,
            units_topped = units_topped + ?,
            users_bonus = users_bonus + ?,
            units_bonus = units_bonus + ?
      WHERE id = ? AND (cursor_user_id IS NULL OR cursor_user_id < ?)`,
    [userId, topped > 0 ? 1 : 0, topped, bonus > 0 ? 1 : 0, bonus, reset.id, userId],
    tx,
  );
  return { topped, bonus };
}

/** Marks a reset done; returns false when it already was (a second runner finished it). */
export async function finishCreditReset(id: string, tx: PoolConnection): Promise<boolean> {
  const row = await queryOne<{ status: string }>(`SELECT status FROM credit_resets WHERE id = ? FOR UPDATE`, [id], tx);
  if (row?.status !== 'running') return false;
  await execute(`UPDATE credit_resets SET status = 'done', finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [id], tx);
  return true;
}

/**
 * What a reset started now would give, without giving it. The same rules as
 * `resetAccount`, over every account at once: the balance it would count
 * excludes credits the reset is about to expire.
 */
export async function previewCreditReset(floor: number, bonus: number, windowStart: Date): Promise<{
  accounts: number;
  toppedAccounts: number;
  toppedUnits: number;
  bonusAccounts: number;
  bonusUnits: number;
}> {
  const row = await queryOne<{ accounts: number; topped_accounts: number; topped_units: number; bonus_accounts: number }>(
    `SELECT COUNT(*) AS accounts,
            COALESCE(SUM(t.top > 0), 0) AS topped_accounts,
            COALESCE(SUM(t.top), 0) AS topped_units,
            COALESCE(SUM(t.paid), 0) AS bonus_accounts
       FROM (
         SELECT GREATEST(0, ? - COALESCE((
                  SELECT SUM(b.granted_units - b.reserved_units - b.consumed_units)
                    FROM entitlement_batches b
                   WHERE b.user_id = u.id AND b.status = 'active' AND b.source <> 'credit_reset'
                     AND b.effective_from <= UTC_TIMESTAMP(3)
                     AND (b.expires_at IS NULL OR b.expires_at > UTC_TIMESTAMP(3))), 0)) AS top,
                EXISTS (SELECT 1 FROM entitlement_batches p
                         WHERE p.user_id = u.id AND ${PAID_NOT_REFUNDED('p')}
                           AND p.created_at > ?) AS paid
           FROM users u
          WHERE u.status = 'active' AND u.deleted_at IS NULL
       ) t`,
    [floor, windowStart],
  );
  const bonusAccounts = bonus > 0 ? Number(row?.bonus_accounts ?? 0) : 0;
  return {
    accounts: Number(row?.accounts ?? 0),
    toppedAccounts: Number(row?.topped_accounts ?? 0),
    toppedUnits: Number(row?.topped_units ?? 0),
    bonusAccounts,
    bonusUnits: bonusAccounts * bonus,
  };
}
