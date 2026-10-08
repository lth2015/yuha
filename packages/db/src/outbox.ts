import type { PoolConnection } from 'mysql2/promise';
import { execute, newId, query, queryOne, toJson } from './pool.js';

export interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'dispatched' | 'failed';
  attempts: number;
  available_at: Date;
  created_at: Date;
}

const OUTBOX_COLUMNS = `
  id, aggregate_type, aggregate_id, event_type, payload, status, attempts, available_at, created_at
`;

/**
 * Enqueues a domain event in the SAME transaction as the state change that
 * produced it (§4.2). This is what makes "credits reserved but nothing queued"
 * impossible: either both commit or neither does.
 */
export async function enqueueOutbox(
  params: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
    availableAt?: Date;
  },
  tx: PoolConnection,
): Promise<string> {
  const id = newId();
  await execute(
    `INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload, available_at)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, UTC_TIMESTAMP(3)))`,
    [
      id,
      params.aggregateType,
      params.aggregateId,
      params.eventType,
      toJson(params.payload),
      params.availableAt ?? null,
    ],
    tx,
  );
  return id;
}

/** Picks up pending rows for dispatch. SKIP LOCKED keeps multiple dispatchers safe. */
export async function claimOutboxBatch(limit: number, tx: PoolConnection): Promise<OutboxRow[]> {
  const candidates = await query<{ id: string }>(
    `SELECT id FROM outbox
      WHERE status <> 'dispatched' AND available_at <= UTC_TIMESTAMP(3)
      ORDER BY created_at
      LIMIT ?
      FOR UPDATE SKIP LOCKED`,
    [limit],
    tx,
  );
  if (!candidates.length) return [];

  const ids = candidates.map((c) => c.id);
  const placeholders = ids.map(() => '?').join(', ');
  await execute(`UPDATE outbox SET attempts = attempts + 1 WHERE id IN (${placeholders})`, ids, tx);
  return query<OutboxRow>(
    `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE id IN (${placeholders}) ORDER BY created_at`,
    ids,
    tx,
  );
}

export async function markDispatched(id: string, tx?: PoolConnection): Promise<void> {
  await execute(
    `UPDATE outbox SET status = 'dispatched', dispatched_at = UTC_TIMESTAMP(3), last_error = NULL
      WHERE id = ?`,
    [id],
    tx,
  );
}

export async function markDispatchFailed(
  params: { id: string; error: string; retryInSeconds: number; maxAttempts: number },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE outbox SET
        status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
        last_error = ?,
        available_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
      WHERE id = ?`,
    [params.maxAttempts, params.error.slice(0, 500), params.retryInSeconds, params.id],
    tx,
  );
}

export async function countPendingOutbox(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`,
  );
  return Number(row?.n ?? 0);
}

// ------------------------------------------------------------ webhook events

export interface WebhookEventRow {
  id: string;
  provider: 'stripe' | 'music';
  event_id: string;
  event_type: string;
  signature_verified: boolean;
  payload: Record<string, unknown>;
  status: 'received' | 'processing' | 'processed' | 'failed' | 'ignored';
  attempts: number;
  last_error: string | null;
  received_at: Date;
}

const WEBHOOK_COLUMNS = `
  id, provider, event_id, event_type, signature_verified, payload, status, attempts, last_error, received_at, attempted_at
`;

/**
 * How long a claim is good for before another worker may take the row.
 *
 * A handler that has not finished in five minutes is not going to: the work is
 * a grant and a couple of writes. The row was previously held for ever by a
 * worker that no longer existed, which is the failure this bounds.
 *
 * Re-claiming is safe by construction, not by luck. The event id is UNIQUE and
 * every grant is keyed on (user, source, source_ref), so an event applied
 * twice grants once — the two idempotency layers PAY-05 asks for are exactly
 * what makes a lease the right answer here rather than a risk.
 */
export const WEBHOOK_LEASE_SECONDS = 300;

/** Attempts past this are never retried; the row waits for a human. */
export const WEBHOOK_MAX_ATTEMPTS = 10;

/**
 * How long to wait before trying a failed event again.
 *
 * There was no wait at all: a failed row was taken by the next pass, 100ms
 * later, so the ten attempts were spent in about a second and any upstream
 * hiccup parked the event permanently. Doubling from 30s and capped at 30
 * minutes spends the same ten attempts over roughly two hours, which is a
 * length an incident can actually be.
 */
const MAX_BACKOFF_SECONDS = 1800;

export function webhookRetryDelaySeconds(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(30 * 2 ** (n - 1), MAX_BACKOFF_SECONDS);
}

/**
 * Stores a verified webhook before doing any work (PAY-04/§4.2): persist,
 * return 2xx fast, process asynchronously. A duplicate event id is a no-op
 * insert, the first of the two idempotency layers PAY-05 asks for.
 */
export async function recordWebhookEvent(
  params: {
    provider: 'stripe' | 'music';
    eventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: Record<string, unknown>;
  },
  tx?: PoolConnection,
): Promise<{ row: WebhookEventRow; duplicate: boolean }> {
  const res = await execute(
    `INSERT IGNORE INTO webhook_events
       (id, provider, event_id, event_type, signature_verified, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      params.provider,
      params.eventId,
      params.eventType,
      params.signatureVerified ? 1 : 0,
      toJson(params.payload),
    ],
    tx,
  );
  const row = await queryOne<WebhookEventRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhook_events WHERE provider = ? AND event_id = ?`,
    [params.provider, params.eventId],
    tx,
  );
  /*
   * `INSERT IGNORE` downgrades EVERY error to a warning, not only a duplicate
   * key, and `duplicate` is inferred from `affectedRows === 0`. So a row
   * refused for any other reason reported `duplicate: true`, and the `!` here
   * asserted a row that is not there — which the webhook route then answered
   * 200 `{received:true, duplicate:true}` to. Stripe marks that delivered and
   * never retries: charged, acknowledged, nothing granted, which is the exact
   * outcome the two-path commit set out to make impossible.
   *
   * Nothing Stripe can send reaches it today (`event_id` is VARCHAR(191)
   * against 28-character ids, `event_type` VARCHAR(128) against types under
   * 60), so this is about the handler being structurally unable to tell the
   * two apart rather than a live hole. Throwing means a 5xx and a redelivery.
   */
  if (!row) {
    throw new Error(
      `webhook event ${params.provider}/${params.eventId} was neither inserted nor found — the insert was refused for a reason other than a duplicate`,
    );
  }
  return { row, duplicate: res.affectedRows === 0 };
}

export async function claimWebhookEvents(limit: number, tx: PoolConnection): Promise<WebhookEventRow[]> {
  /*
   * Three ways a row becomes claimable, and they are genuinely different:
   *
   *  - 'received': never tried. `attempted_at` is NULL until the first claim.
   *  - 'failed': tried and threw. Waits out a backoff that grows with attempts,
   *    so the budget spans an outage instead of a second.
   *  - 'processing': claimed by a worker that never came back. Reclaimed once
   *    the lease expires. Without this the row was held for ever by a process
   *    that no longer existed.
   *
   * The backoff is computed in SQL rather than filtered in JS because the
   * claim has to stay one statement: selecting candidates and then discarding
   * some of them in the worker would hold locks on rows it had already decided
   * to skip, and would under-fill every batch.
   */
  const candidates = await query<{ id: string }>(
    `SELECT id FROM webhook_events
      WHERE signature_verified = 1
        AND attempts < ?
        AND (
          status = 'received'
          OR (status = 'failed'
              AND (attempted_at IS NULL
                   OR attempted_at <= UTC_TIMESTAMP(3)
                      - INTERVAL LEAST(30 * POW(2, GREATEST(attempts, 1) - 1), ?) SECOND))
          OR (status = 'processing'
              AND (attempted_at IS NULL
                   OR attempted_at <= UTC_TIMESTAMP(3) - INTERVAL ? SECOND))
        )
      ORDER BY received_at
      LIMIT ?
      FOR UPDATE SKIP LOCKED`,
    [WEBHOOK_MAX_ATTEMPTS, MAX_BACKOFF_SECONDS, WEBHOOK_LEASE_SECONDS, limit],
    tx,
  );
  if (!candidates.length) return [];

  const ids = candidates.map((c) => c.id);
  const placeholders = ids.map(() => '?').join(', ');
  await execute(
    `UPDATE webhook_events
        SET status = 'processing', attempts = attempts + 1, attempted_at = UTC_TIMESTAMP(3)
      WHERE id IN (${placeholders})`,
    ids,
    tx,
  );
  return query<WebhookEventRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhook_events WHERE id IN (${placeholders}) ORDER BY received_at`,
    ids,
    tx,
  );
}

/**
 * `last_error` is VARCHAR(500), and the cut has to land between characters.
 *
 * It was `.slice(0, 500)`, which counts UTF-16 code units: a message whose
 * 500th unit is the first half of a surrogate pair was cut through the middle
 * of a character, and the lone surrogate reached the driver, which encodes it
 * as U+FFFD. The row stored fine — this never refused a write — but the tail
 * of the message was replaced by a question mark in a diamond, in the one
 * column whose whole job is saying what went wrong.
 *
 * Not exotic: any message quoting the user text that caused it — a title, a
 * prompt, a lyric — can carry an emoji, and those are the messages worth
 * keeping. Same shape as the `maxLength` defect in the composer, in a column
 * instead of a field.
 */
function trimError(error: string | null | undefined): string | null {
  if (!error) return null;
  const points = [...error];
  return points.length <= 500 ? error : points.slice(0, 500).join('');
}

export async function finishWebhookEvent(
  params: { id: string; status: 'processed' | 'failed' | 'ignored'; error?: string | null },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE webhook_events SET status = ?, last_error = ?, processed_at = UTC_TIMESTAMP(3) WHERE id = ?`,
    [params.status, trimError(params.error), params.id],
    tx,
  );
}

export async function countWebhookBacklog(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM webhook_events WHERE status IN ('received','processing','failed')`,
  );
  return Number(row?.n ?? 0);
}
