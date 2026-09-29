/**
 * The daily upstream spend cap (§12.3).
 *
 * Why this file exists: `DAILY_BUDGET_MINOR` is the only gate standing between
 * a runaway loop and an unbounded supplier bill, and it had no test at all —
 * `docs/OPEN_ITEMS.md` still described it as unimplemented while
 * `assertWithinDailyBudget` had been wired into `createGeneration` for weeks.
 * An enforced cap with no regression test is one careless refactor from being
 * a configured number that does nothing, which is the failure mode the cap
 * exists to prevent.
 *
 * Two properties matter more than the refusal itself:
 *
 *  - Hitting the cap must cost the user nothing. The check runs before the
 *    entitlement transaction, so there must be no `reserve` row in
 *    `ledger_entries` — asserted by reading the table, not by trusting the
 *    response body, because a reservation that is rolled back and one that was
 *    never taken look identical from outside.
 *  - §12.3 asks for generation to pause while order lookup and downloads keep
 *    working. A cap that took the whole product down with it would satisfy the
 *    first half and fail the point.
 *
 * The cap is set explicitly here rather than read from `ctx.config`. The
 * product default is 50,000 and may change; what is under test is the rule,
 * and an expectation taken from the configuration the code under test consults
 * cannot fail when that configuration is wrong.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query, recordCostEvent } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

/** Minor units. Deliberately small and unrelated to the shipped default. */
const CAP = 1000;

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ DAILY_BUDGET_MINOR: String(CAP) });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const body = {
  mode: 'simple' as const,
  prompt: 'a quiet late-night walk, gentle rain',
  styles: ['chill'],
  instrumental: true,
  energy: 0.3,
  durationSeconds: 30,
};

const post = (user: TestUser, idempotencyKey: string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': idempotencyKey },
    payload: body as never,
  });

/**
 * Records upstream spend the way the worker does, in the last 24 hours.
 * `billable` is the contract's answer to "does the supplier charge for this",
 * and the cap sums only what it bills for.
 */
const spend = (costMinor: number, billable = true) =>
  recordCostEvent({
    providerId: 'demo-local',
    providerKind: 'music',
    eventType: 'success',
    billable,
    costMinor,
    isEstimate: true,
  });

const ledgerOf = (userId: string) =>
  query<{ entry_type: string; units: number }>(
    `SELECT entry_type, units FROM ledger_entries WHERE user_id = ? ORDER BY created_at, entry_type`,
    [userId],
  );

const jobCountOf = async (userId: string) => {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM generation_jobs WHERE user_id = ?`,
    [userId],
  );
  return Number(rows[0]!.n);
};

describe('daily upstream budget', () => {
  it('lets a generation through while spend is below the cap', async () => {
    await spend(CAP - 1);
    const user = await h.createUser({ credits: 1 });

    const res = await post(user, 'budget-below-cap');

    expect(res.statusCode).toBe(202);
  });

  it('refuses a generation at the cap, and reserves nothing', async () => {
    await spend(CAP);
    const user = await h.createUser({ credits: 1 });
    const before = await ledgerOf(user.id);

    const res = await post(user, 'budget-at-cap');

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('BUDGET_EXCEEDED');

    // The credit is untouched, read from the ledger rather than from the
    // response: the guard runs before the entitlement transaction, so a
    // `reserve` row here would mean the user paid for being refused.
    const after = await ledgerOf(user.id);
    expect(after).toEqual(before);
    expect(after.map((e) => e.entry_type)).not.toContain('reserve');

    // And no job row to resume, retry or sweep later.
    expect(await jobCountOf(user.id)).toBe(0);
  });

  it('forgets spend older than the window it sums', async () => {
    // The cap is a *daily* ceiling: `billableSpendSince(24)`. Widen that window
    // and the cap stops resetting — after enough months the product refuses
    // every generation forever, which looks exactly like the cap working.
    // `provider_cost_events` was truncated by `resetData`, so this backdates the
    // only row in it.
    await spend(CAP * 10);
    await query(
      `UPDATE provider_cost_events SET occurred_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 25 HOUR)`,
    );
    const user = await h.createUser({ credits: 1 });

    const res = await post(user, 'budget-stale-spend');

    expect(res.statusCode).toBe(202);
  });

  it('counts only spend the supplier bills for', async () => {
    // Same amount, marked as not billable by the contract (AI-06). A cap that
    // summed every cost event would refuse this and understate the headroom.
    await spend(CAP, false);
    const user = await h.createUser({ credits: 1 });

    const res = await post(user, 'budget-unbillable');

    expect(res.statusCode).toBe(202);
  });

  it('stops every user, not only the one whose work spent it', async () => {
    // The cap is a service-wide upstream ceiling, not a per-user quota: the
    // spend is recorded against no user at all. This is deliberate, and worth
    // pinning because it is surprising.
    await spend(CAP);
    const other = await h.createUser({ credits: 5 });

    const res = await post(other, 'budget-other-user');

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('BUDGET_EXCEEDED');
  });

  it('pauses generation without taking the rest of the product down', async () => {
    // §12.3: order lookup, the library and existing downloads keep working.
    // This is the half a "just refuse everything" implementation would fail.
    await spend(CAP);
    const user = await h.createUser({ credits: 1 });

    for (const url of ['/v1/tracks', '/v1/orders', '/v1/entitlements']) {
      const res = await h.app.inject({ method: 'GET', url, headers: user.authHeader });
      expect(res.statusCode, url).toBe(200);
    }
  });
});
