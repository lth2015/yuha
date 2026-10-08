import type { PoolConnection } from 'mysql2/promise';
import type { EntitlementSource, LedgerEntryType } from '@yuha/contracts';
import { execute, lockUserEntitlements, newId, query, queryOne, toJson } from './pool.js';

export interface EntitlementBatchRow {
  id: string;
  user_id: string;
  source: EntitlementSource;
  source_ref: string;
  product_key: string | null;
  price_version: number | null;
  granted_units: number;
  reserved_units: number;
  consumed_units: number;
  effective_from: Date;
  expires_at: Date | null;
  status: 'active' | 'expired' | 'revoked';
  created_at: Date;
}

export interface BalanceSummary {
  available: number;
  reserved: number;
  consumed: number;
  granted: number;
}

const BATCH_COLUMNS = `
  id, user_id, source, source_ref, product_key, price_version,
  granted_units, reserved_units, consumed_units,
  effective_from, expires_at, status, created_at
`;

/**
 * Balance derived from live batches. §6.2 forbids maintaining one overwritable
 * `credits` integer; the numbers here are always recomputed from batch rows,
 * and `reconcileBalances` cross-checks them against the append-only ledger.
 */
export async function getBalance(userId: string, tx?: PoolConnection): Promise<BalanceSummary> {
  const row = await queryOne<{ granted: number; reserved: number; consumed: number }>(
    `SELECT COALESCE(SUM(granted_units), 0)  AS granted,
            COALESCE(SUM(reserved_units), 0) AS reserved,
            COALESCE(SUM(consumed_units), 0) AS consumed
       FROM entitlement_batches
      WHERE user_id = ?
        AND status = 'active'
        AND effective_from <= UTC_TIMESTAMP(3)
        AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))`,
    [userId],
    tx,
  );
  const granted = Number(row?.granted ?? 0);
  const reserved = Number(row?.reserved ?? 0);
  const consumed = Number(row?.consumed ?? 0);
  return { granted, reserved, consumed, available: granted - reserved - consumed };
}

/**
 * Available balances for several accounts in one query.
 *
 * The same arithmetic as `getBalance`, grouped. The console's customer search
 * returns up to ten rows and wants a balance beside each one; a `getBalance`
 * per row is ten round trips on every press of a button.
 *
 * Accounts with no active batch are absent from the map rather than zero, so
 * the caller decides what "no credits" renders as.
 */
export async function balancesFor(
  userIds: string[],
  tx?: PoolConnection,
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await query<{ user_id: string; available: number }>(
    `SELECT user_id,
            COALESCE(SUM(granted_units), 0) - COALESCE(SUM(reserved_units), 0)
              - COALESCE(SUM(consumed_units), 0) AS available
       FROM entitlement_batches
      WHERE user_id IN (${userIds.map(() => '?').join(', ')})
        AND status = 'active'
        AND effective_from <= UTC_TIMESTAMP(3)
        AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))
      GROUP BY user_id`,
    userIds,
    tx,
  );
  return new Map(rows.map((r) => [r.user_id, Number(r.available)]));
}

/**
 * A user's batches, newest expiry first, with a bound.
 *
 * `limit` was added because the operator console renders this list: a gift
 * mints a new batch every time, so the row count grows with operator activity
 * and an account with thousands of them loaded every one into memory and
 * serialised them into a single response. The default is high enough that no
 * existing caller sees a difference.
 */
export async function listBatches(
  userId: string,
  tx?: PoolConnection,
  limit?: number,
): Promise<EntitlementBatchRow[]> {
  return query<EntitlementBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM entitlement_batches
      WHERE user_id = ? AND status <> 'revoked'
      ORDER BY expires_at IS NULL, expires_at, created_at
      LIMIT ?`,
    [userId, Math.min(Math.max(limit ?? 500, 1), 1000)],
    tx,
  );
}

export interface GrantInput {
  userId: string;
  source: EntitlementSource;
  sourceRef: string;
  units: number;
  productKey?: string | null;
  priceVersion?: number | null;
  effectiveFrom?: Date;
  expiresAt?: Date | null;
  reason: string;
  actorId?: string | null;
}

export interface GrantResult {
  batch: EntitlementBatchRow;
  /** false when the (user, source, source_ref) batch already existed. */
  created: boolean;
}

async function getBatch(id: string, tx: PoolConnection): Promise<EntitlementBatchRow | undefined> {
  return queryOne<EntitlementBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM entitlement_batches WHERE id = ?`,
    [id],
    tx,
  );
}

/**
 * Idempotent grant. The unique key on (user_id, source, source_ref) is what
 * makes a replayed or out-of-order Stripe event harmless (PAY-05): a second
 * call with the same business reference returns the existing batch and writes
 * no second ledger entry.
 */
export async function grantUnits(input: GrantInput, tx: PoolConnection): Promise<GrantResult> {
  await lockUserEntitlements(input.userId, tx);

  const existing = await queryOne<EntitlementBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM entitlement_batches
      WHERE user_id = ? AND source = ? AND source_ref = ?`,
    [input.userId, input.source, input.sourceRef],
    tx,
  );
  if (existing) return { batch: existing, created: false };

  const id = newId();
  await execute(
    `INSERT INTO entitlement_batches
       (id, user_id, source, source_ref, product_key, price_version,
        granted_units, effective_from, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, UTC_TIMESTAMP(3)), ?)`,
    [
      id,
      input.userId,
      input.source,
      input.sourceRef,
      input.productKey ?? null,
      input.priceVersion ?? null,
      input.units,
      input.effectiveFrom ?? null,
      input.expiresAt ?? null,
    ],
    tx,
  );

  await writeLedger(
    {
      userId: input.userId,
      batchId: id,
      entryType: 'grant',
      units: input.units,
      reason: input.reason,
      actorId: input.actorId ?? null,
    },
    tx,
  );
  return { batch: (await getBatch(id, tx))!, created: true };
}

export interface LedgerInput {
  userId: string;
  batchId?: string | null;
  jobId?: string | null;
  entryType: LedgerEntryType;
  units: number;
  reason: string;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function writeLedger(input: LedgerInput, tx: PoolConnection): Promise<string> {
  const id = newId();
  await execute(
    `INSERT INTO ledger_entries (id, user_id, batch_id, job_id, entry_type, units, reason, actor_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.batchId ?? null,
      input.jobId ?? null,
      input.entryType,
      input.units,
      input.reason,
      input.actorId ?? null,
      toJson(input.metadata ?? {}),
    ],
    tx,
  );
  return id;
}

export type ReserveOutcome =
  | { ok: true; batchId: string; alreadyReserved: boolean }
  | { ok: false; code: 'INSUFFICIENT_CREDITS' };

/**
 * Reserves exactly one unit for a job.
 *
 * Ordering: the batch expiring soonest is used first, and a batch that is not
 * yet effective is never borrowed from — §6.2 forbids drawing on a future
 * billing period. Idempotent per job via the generated-column unique key on
 * ledger_entries.
 */
export async function reserveUnit(
  params: { userId: string; jobId: string; units?: number; reason?: string },
  tx: PoolConnection,
): Promise<ReserveOutcome> {
  const units = params.units ?? 1;
  await lockUserEntitlements(params.userId, tx);

  const prior = await queryOne<{ batch_id: string | null }>(
    `SELECT batch_id FROM ledger_entries WHERE job_id = ? AND entry_type = 'reserve'`,
    [params.jobId],
    tx,
  );
  if (prior) return { ok: true, batchId: prior.batch_id!, alreadyReserved: true };

  const batch = await queryOne<EntitlementBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM entitlement_batches
      WHERE user_id = ?
        AND status = 'active'
        AND effective_from <= UTC_TIMESTAMP(3)
        AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))
        AND granted_units - reserved_units - consumed_units >= ?
      ORDER BY expires_at IS NULL, expires_at, created_at
      LIMIT 1
      FOR UPDATE`,
    [params.userId, units],
    tx,
  );
  if (!batch) return { ok: false, code: 'INSUFFICIENT_CREDITS' };

  // The WHERE clause repeats the invariant so that even without the row lock
  // this update could not oversell; the CHECK constraint is the third net.
  const res = await execute(
    `UPDATE entitlement_batches
        SET reserved_units = reserved_units + ?, updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?
        AND granted_units - reserved_units - consumed_units >= ?`,
    [units, batch.id, units],
    tx,
  );
  if (res.affectedRows === 0) return { ok: false, code: 'INSUFFICIENT_CREDITS' };

  await writeLedger(
    {
      userId: params.userId,
      batchId: batch.id,
      jobId: params.jobId,
      entryType: 'reserve',
      units,
      reason: params.reason ?? 'generation_reserve',
    },
    tx,
  );
  return { ok: true, batchId: batch.id, alreadyReserved: false };
}

/**
 * Turns a reservation into a consumption. Called once, in the same transaction
 * that marks the job DELIVERED — GEN-08: a repeated success callback finds the
 * ledger entry already present and changes nothing.
 */
export async function consumeReservation(
  params: { userId: string; jobId: string; units?: number; reason?: string },
  tx: PoolConnection,
): Promise<{ consumed: boolean }> {
  const units = params.units ?? 1;
  await lockUserEntitlements(params.userId, tx);

  const already = await queryOne<{ id: string }>(
    `SELECT id FROM ledger_entries WHERE job_id = ? AND entry_type = 'consume'`,
    [params.jobId],
    tx,
  );
  if (already) return { consumed: false };

  const reservation = await queryOne<{ batch_id: string }>(
    `SELECT batch_id FROM ledger_entries WHERE job_id = ? AND entry_type = 'reserve'`,
    [params.jobId],
    tx,
  );
  if (!reservation?.batch_id) {
    throw new Error(`cannot consume: job ${params.jobId} has no reservation`);
  }

  const released = await queryOne<{ id: string }>(
    `SELECT id FROM ledger_entries WHERE job_id = ? AND entry_type = 'release'`,
    [params.jobId],
    tx,
  );
  // GEN-09: the credit was already given back. A late upstream success must not
  // silently re-charge the user.
  if (released) return { consumed: false };

  await execute(
    `UPDATE entitlement_batches
        SET reserved_units = reserved_units - ?,
            consumed_units = consumed_units + ?,
            updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?`,
    [units, units, reservation.batch_id],
    tx,
  );
  await writeLedger(
    {
      userId: params.userId,
      batchId: reservation.batch_id,
      jobId: params.jobId,
      entryType: 'consume',
      units,
      reason: params.reason ?? 'generation_delivered',
    },
    tx,
  );
  return { consumed: true };
}

/**
 * Releases a reservation on technical failure, provider rejection or a
 * successful cancellation (§6.1). Never charges the user for a failure.
 *
 * If the reservation's own batch has since expired the release still restores
 * the units to it, and `expiredBatch` is reported so the caller can apply the
 * configured compensation policy (GEN-11) instead of losing the credit.
 */
export async function releaseReservation(
  params: { userId: string; jobId: string; units?: number; reason: string },
  tx: PoolConnection,
): Promise<{ released: boolean; batchId: string | null; expiredBatch: boolean }> {
  const units = params.units ?? 1;
  await lockUserEntitlements(params.userId, tx);

  const already = await queryOne<{ id: string }>(
    `SELECT id FROM ledger_entries WHERE job_id = ? AND entry_type = 'release'`,
    [params.jobId],
    tx,
  );
  if (already) return { released: false, batchId: null, expiredBatch: false };

  const consumed = await queryOne<{ id: string }>(
    `SELECT id FROM ledger_entries WHERE job_id = ? AND entry_type = 'consume'`,
    [params.jobId],
    tx,
  );
  // Already billed. Correction goes through the compensation flow so the
  // original consume entry is never rewritten (§6.2).
  if (consumed) return { released: false, batchId: null, expiredBatch: false };

  const reservation = await queryOne<{ batch_id: string }>(
    `SELECT batch_id FROM ledger_entries WHERE job_id = ? AND entry_type = 'reserve'`,
    [params.jobId],
    tx,
  );
  if (!reservation?.batch_id) return { released: false, batchId: null, expiredBatch: false };

  await execute(
    `UPDATE entitlement_batches
        SET reserved_units = reserved_units - ?, updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?`,
    [units, reservation.batch_id],
    tx,
  );
  await writeLedger(
    {
      userId: params.userId,
      batchId: reservation.batch_id,
      jobId: params.jobId,
      entryType: 'release',
      units,
      reason: params.reason,
    },
    tx,
  );

  const batch = await getBatch(reservation.batch_id, tx);
  const expired =
    !!batch && (batch.status !== 'active' || (batch.expires_at !== null && batch.expires_at <= new Date()));
  return { released: true, batchId: reservation.batch_id, expiredBatch: expired };
}

/**
 * Issues make-good credits as a NEW batch rather than editing an existing one.
 * Used when a batch expired while a job was still running (GEN-11) or when
 * support corrects a mis-charge — the original flow stays visible in the ledger.
 */
export async function compensateUnits(
  params: {
    userId: string;
    jobId?: string | null;
    units: number;
    reason: string;
    actorId?: string | null;
    validityDays: number;
  },
  tx: PoolConnection,
): Promise<GrantResult> {
  const ref = params.jobId ? `job:${params.jobId}` : `manual:${newId()}`;
  const expiresAt = new Date(Date.now() + params.validityDays * 24 * 3600 * 1000);
  const result = await grantUnits(
    {
      userId: params.userId,
      source: 'compensation',
      sourceRef: ref,
      units: params.units,
      expiresAt,
      reason: params.reason,
      actorId: params.actorId ?? null,
    },
    tx,
  );
  if (result.created && params.jobId) {
    await writeLedger(
      {
        userId: params.userId,
        batchId: result.batch.id,
        jobId: params.jobId,
        entryType: 'compensate',
        units: params.units,
        reason: params.reason,
        actorId: params.actorId ?? null,
      },
      tx,
    );
  }
  return result;
}

/**
 * Credits an operator gives away.
 *
 * Mechanically `grantUnits` with a source of its own, and that source is the
 * whole point: `compensation` says in the books that we broke something, and
 * `manual_adjustment` is what the seed writes for demo accounts. A deliberate
 * giveaway is neither, and the question it has to be able to answer later —
 * how much have we given away, and who gave it — cannot be answered by
 * grepping reasons.
 *
 * `source_ref` is a fresh id per gift, so two gifts to the same person are two
 * batches rather than one silently ignored by the uniqueness on
 * (user, source, source_ref). That is the opposite of what the order and
 * invoice paths want, and it is correct here: an operator giving fifty credits
 * twice means a hundred credits, and a repeat is a decision somebody made
 * twice, not a retry to swallow.
 */
export async function giftUnits(
  params: {
    userId: string;
    units: number;
    reason: string;
    actorId: string;
    validityDays: number;
    /**
     * Turns the business key into one the caller controls, so a retry
     * collapses onto the first attempt. Absent, every call is a new gift —
     * which is right for a person pressing the button twice on purpose, and
     * wrong for a lost response.
     */
    idempotencyKey?: string;
  },
  tx: PoolConnection,
): Promise<GrantResult> {
  return grantUnits(
    {
      userId: params.userId,
      source: 'operator_gift',
      sourceRef: params.idempotencyKey ? `gift:${params.idempotencyKey}` : `gift:${newId()}`,
      units: params.units,
      expiresAt: new Date(Date.now() + params.validityDays * 24 * 3600 * 1000),
      reason: params.reason,
      actorId: params.actorId,
    },
    tx,
  );
}

/**
 * How many units one operator has handed out since a moment.
 *
 * Credits are provider cost, so an operator account that can grant without
 * limit can spend real money without limit. The per-grant cap alone does not
 * bound that — fifty grants of fifty is still fifty grants of fifty — so both
 * operator-facing paths read this before writing and refuse past the day's
 * total.
 *
 * `sources` is the caller's, so the gift path and the compensation path keep
 * separate allowances: they answer to different limits and one must not eat
 * the other's budget.
 *
 * Counted from the LEDGER rather than from the batches, because the ledger is
 * append-only and carries the actor. A revoked or expired batch still counts
 * against the day — the question is how much this operator handed out, not how
 * much of it survives — and there is no way to reset the total: revocation and
 * expiry leave both rows intact, and an account deletion anonymises the user
 * rather than removing the row, so the `ON DELETE CASCADE` never fires.
 *
 * **Read this under a lock on the actor's own row** (`lockUser`), inside the
 * transaction that writes. It is a plain read: without that lock two requests
 * from one operator to two different recipients take two different recipient
 * locks, both see the same stale total, and both commit — which is not a
 * limit, it is a suggestion. Measured: 50 parallel requests wrote 5,000 units
 * against a 500-a-day cap.
 */
export async function unitsGrantedByActorSince(
  params: { actorId: string; sources: EntitlementSource[]; since: Date },
  tx?: PoolConnection,
): Promise<number> {
  if (params.sources.length === 0) return 0;
  const row = await queryOne<{ units: number }>(
    `SELECT COALESCE(SUM(l.units), 0) AS units
       FROM ledger_entries l
       JOIN entitlement_batches b ON b.id = l.batch_id
      WHERE l.actor_id = ?
        AND l.entry_type = 'grant'
        AND b.source IN (${params.sources.map(() => '?').join(', ')})
        AND l.created_at >= ?`,
    [params.actorId, ...params.sources, params.since],
    tx,
  );
  return Number(row?.units ?? 0);
}

/**
 * Revokes unused units from a batch, used by the refund path (PAY-09).
 * Only units that are neither reserved nor consumed can be pulled back, so a
 * refund cannot drive a balance negative or cancel work already delivered.
 */
/**
 * Takes back units nobody has spent yet.
 *
 * `maxUnits` caps how many, for a refund that returned only part of the money.
 * Without it this revoked every unused unit in the batch whatever the amount,
 * so a ¥300 refund on a ¥980 pack took back all five songs — 30% of the money
 * returned, 100% of the goods gone. Omit it and the whole unused remainder
 * goes, which is what a full refund wants.
 *
 * Reserved and consumed units are never touched: a song already generated is
 * not clawed back, and the caller is told what it could not reach so a human
 * can decide.
 */
export async function revokeUnusedUnits(
  params: {
    userId: string;
    batchId: string;
    reason: string;
    actorId?: string | null;
    maxUnits?: number;
  },
  tx: PoolConnection,
): Promise<{ revoked: number; remainingReserved: number; remainingConsumed: number }> {
  await lockUserEntitlements(params.userId, tx);
  const batch = await queryOne<EntitlementBatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM entitlement_batches WHERE id = ? AND user_id = ? FOR UPDATE`,
    [params.batchId, params.userId],
    tx,
  );
  if (!batch) return { revoked: 0, remainingReserved: 0, remainingConsumed: 0 };

  const unused = batch.granted_units - batch.reserved_units - batch.consumed_units;
  const cap = params.maxUnits ?? unused;
  const revokable = Math.max(0, Math.min(unused, cap));
  if (revokable > 0) {
    /*
     * The status is decided here, in one place, from values already read under
     * the row lock above.
     *
     * It used to be a `CASE WHEN granted_units - ? = 0` in the same UPDATE as
     * `granted_units = granted_units - ?`. MySQL evaluates a single-table
     * UPDATE's assignments left to right and a later one sees the NEW value, so
     * that condition actually asked `granted_old - 2 × revokable = 0` — true
     * only when exactly half the batch was revoked.
     *
     * Both directions were wrong and the money went the wrong way in each. A
     * full refund of a 5-unit pack left `granted_units = 0` with status still
     * `active`, so the entitlements screen kept showing a pack the customer had
     * been refunded for. And revoking exactly half of an even pack flipped the
     * whole batch to `revoked`, and `getBalance` only sums active batches — the
     * buyer silently lost the units they had still paid for. The existing test
     * (granted 5, revoked 3) passes under both behaviours, which is why it sat
     * here.
     *
     * Not fixed by reordering the assignments, though that would also work:
     * correctness should not depend on the reader knowing that rule.
     */
    const remainingGranted = batch.granted_units - revokable;
    await execute(
      `UPDATE entitlement_batches
          SET granted_units = ?,
              status = ?,
              updated_at = UTC_TIMESTAMP(3)
        WHERE id = ?`,
      [remainingGranted, remainingGranted === 0 ? 'revoked' : batch.status, batch.id],
      tx,
    );
    await writeLedger(
      {
        userId: params.userId,
        batchId: batch.id,
        entryType: 'revoke',
        units: revokable,
        reason: params.reason,
        actorId: params.actorId ?? null,
      },
      tx,
    );
  }
  return {
    revoked: revokable,
    remainingReserved: batch.reserved_units,
    remainingConsumed: batch.consumed_units,
  };
}

export interface ReconciliationRow {
  user_id: string;
  batch_id: string;
  counter_granted: number;
  counter_reserved: number;
  counter_consumed: number;
  ledger_granted: number;
  ledger_reserved: number;
  ledger_consumed: number;
}

/**
 * Daily consistency check (§6.2): per-batch counters must equal the aggregation
 * of the append-only ledger. Any row returned is a real discrepancy and is
 * alerted on rather than auto-corrected.
 */
export async function reconcileBalances(): Promise<ReconciliationRow[]> {
  return query<ReconciliationRow>(`
    WITH agg AS (
      SELECT batch_id,
             COALESCE(SUM(CASE WHEN entry_type = 'grant'    THEN units ELSE 0 END), 0) AS granted,
             COALESCE(SUM(CASE WHEN entry_type = 'revoke'   THEN units ELSE 0 END), 0) AS revoked,
             COALESCE(SUM(CASE WHEN entry_type = 'reserve'  THEN units ELSE 0 END), 0) AS reserved,
             COALESCE(SUM(CASE WHEN entry_type = 'consume'  THEN units ELSE 0 END), 0) AS consumed,
             COALESCE(SUM(CASE WHEN entry_type = 'release'  THEN units ELSE 0 END), 0) AS released
        FROM ledger_entries
       WHERE batch_id IS NOT NULL
       GROUP BY batch_id
    )
    SELECT b.user_id                                     AS user_id,
           b.id                                          AS batch_id,
           b.granted_units                               AS counter_granted,
           b.reserved_units                              AS counter_reserved,
           b.consumed_units                              AS counter_consumed,
           (agg.granted - agg.revoked)                   AS ledger_granted,
           (agg.reserved - agg.consumed - agg.released)  AS ledger_reserved,
           agg.consumed                                  AS ledger_consumed
      FROM entitlement_batches b
      JOIN agg ON agg.batch_id = b.id
     WHERE b.granted_units  <> (agg.granted - agg.revoked)
        OR b.reserved_units <> (agg.reserved - agg.consumed - agg.released)
        OR b.consumed_units <> agg.consumed
  `);
}

/** Marks batches past their expiry so they stop counting toward the balance. */
export async function expireBatches(tx?: PoolConnection): Promise<number> {
  const res = await execute(
    `UPDATE entitlement_batches
        SET status = 'expired', updated_at = UTC_TIMESTAMP(3)
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= UTC_TIMESTAMP(3)
        AND reserved_units = 0`,
    [],
    tx,
  );
  return res.affectedRows;
}
