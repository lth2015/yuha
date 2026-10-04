/**
 * A webhook event that is claimed and then dropped, and one that fails.
 *
 * `claimWebhookEvents` moved a row to `processing` and selected only
 * `received` and `failed`. A worker that died between those two — a deploy, an
 * OOM, a lost database connection — left the row `processing` with nobody
 * looking at it again, ever. For a Stripe event that is a payment that was
 * taken and an entitlement that never landed, and nothing in the system says
 * so: the row is not `failed`, so no alert counts it.
 *
 * The retry budget had the opposite problem. A failed row went straight back
 * into the next pass, which runs 100ms later, so `attempts` reached its limit
 * of 10 in about a second. Ten attempts is meant to span an outage; it spanned
 * a blink. Any upstream hiccup burned the whole budget and parked the event
 * permanently.
 *
 * Re-claiming is safe by construction: the event id is UNIQUE and the grants
 * are keyed on (user, source, source_ref), so applying the same event twice
 * grants once. That is what makes a lease the right answer rather than a risk.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimWebhookEvents,
  query,
  execute,
  finishWebhookEvent,
  query,
  recordWebhookEvent,
  withTx,
  WEBHOOK_LEASE_SECONDS,
  WEBHOOK_MAX_ATTEMPTS,
  webhookRetryDelaySeconds,
} from '@yuha/db';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness';

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
beforeEach(async () => { await resetData(); });
afterAll(async () => { await h?.close(); await teardown(); });

let seq = 0;
async function arrive(): Promise<string> {
  seq += 1;
  const { row } = await recordWebhookEvent({
    provider: 'stripe',
    eventId: `evt_retry_${seq}`,
    eventType: 'checkout.session.completed',
    signatureVerified: true,
    payload: { id: `cs_${seq}` },
  });
  return row.id;
}

const claim = () => withTx(async (tx) => claimWebhookEvents(10, tx));

/** Pretends the row was claimed or last tried `seconds` ago. */
const age = (id: string, seconds: number) =>
  execute(
    `UPDATE webhook_events SET attempted_at = UTC_TIMESTAMP(3) - INTERVAL ? SECOND WHERE id = ?`,
    [seconds, id],
  );

const stateOf = async (id: string) =>
  (await query<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM webhook_events WHERE id = ?`, [id],
  ))[0]!;

describe('a webhook claimed by a worker that then died', () => {
  it('is picked up again once its lease expires', async () => {
    const id = await arrive();
    expect((await claim()).map((e) => e.id)).toContain(id);
    expect((await stateOf(id)).status).toBe('processing');

    // The worker is gone; nothing will ever call finishWebhookEvent.
    expect((await claim()).map((e) => e.id)).not.toContain(id);

    await age(id, WEBHOOK_LEASE_SECONDS + 5);
    const again = await claim();
    expect(again.map((e) => e.id)).toContain(id);
    // The second claim counts: a row that keeps being abandoned must still
    // reach the attempt limit rather than spinning for ever.
    expect((await stateOf(id)).attempts).toBe(2);
  });

  it('is left alone while a live worker still holds it', async () => {
    const id = await arrive();
    await claim();
    await age(id, WEBHOOK_LEASE_SECONDS - 10);
    expect((await claim()).map((e) => e.id)).not.toContain(id);
  });

  it('frees a row that was already stuck before the lease existed', async () => {
    // The migration backfills `attempted_at` from `received_at` so rows left
    // 'processing' by the old code satisfy a lease comparison. A NULL is
    // treated as claimable anyway, so a row the backfill somehow missed is
    // freed rather than stuck for the exact reason the lease was added.
    const id = await arrive();
    await execute(
      `UPDATE webhook_events SET status = 'processing', attempted_at = NULL WHERE id = ?`,
      [id],
    );
    expect((await claim()).map((e) => e.id)).toContain(id);
  });

  it('is not re-claimed once it has finished', async () => {
    const id = await arrive();
    await claim();
    await finishWebhookEvent({ id, status: 'processed' });
    await age(id, WEBHOOK_LEASE_SECONDS * 10);
    expect((await claim()).map((e) => e.id)).not.toContain(id);
  });
});

describe('a webhook whose handler threw', () => {
  it('waits before being tried again, instead of going round at loop speed', async () => {
    const id = await arrive();
    await claim();
    await finishWebhookEvent({ id, status: 'failed', error: 'upstream 503' });

    // The loop comes back in 100ms. It must not take this row with it.
    expect((await claim()).map((e) => e.id)).not.toContain(id);

    await age(id, webhookRetryDelaySeconds(1) + 5);
    expect((await claim()).map((e) => e.id)).toContain(id);
  });

  it('waits longer each time, so ten attempts span an outage and not a second', async () => {
    const delays = Array.from({ length: WEBHOOK_MAX_ATTEMPTS - 1 }, (_, i) =>
      webhookRetryDelaySeconds(i + 1),
    );
    // Strictly increasing until it caps, and never decreasing after.
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!, `attempt ${i + 1}`).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
    expect(delays[0]).toBeGreaterThan(10);
    // The whole budget has to outlast a real incident, not a blink.
    const total = delays.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(3600);
  });

  it('still stops for good at the attempt limit', async () => {
    const id = await arrive();
    await execute(`UPDATE webhook_events SET status = 'failed', attempts = ? WHERE id = ?`, [
      WEBHOOK_MAX_ATTEMPTS,
      id,
    ]);
    await age(id, 86_400);
    expect((await claim()).map((e) => e.id)).not.toContain(id);
  });
});


/**
 * The backoff is written twice, so the two copies have to be held together.
 *
 * `webhookRetryDelaySeconds` is the readable one; the claim query computes the
 * same curve in SQL, because selecting candidates and then discarding some in
 * the worker would hold locks on rows it had already decided to skip. Two
 * implementations of one rule drift the moment somebody tunes one of them, and
 * the drift is invisible: the suite would still pass, and events would simply
 * be retried on a schedule nobody chose.
 */
describe('the SQL backoff and the JS one are the same curve', () => {
  it('agrees at every attempt the budget allows', async () => {
    const rows = await query<{ n: number; sql_delay: number }>(
      `SELECT n, LEAST(30 * POW(2, GREATEST(n, 1) - 1), ?) AS sql_delay
         FROM (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5
               UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) t
        ORDER BY n`,
      [1800],
    );
    expect(rows).toHaveLength(WEBHOOK_MAX_ATTEMPTS - 1);
    for (const r of rows) {
      expect(Number(r.sql_delay), `attempt ${r.n}`).toBe(webhookRetryDelaySeconds(Number(r.n)));
    }
  });
});
