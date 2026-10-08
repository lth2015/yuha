/**
 * Finding a customer, and giving them credits.
 *
 * Neither was possible before this. `POST /v1/admin/users/:id/compensate` had
 * existed since the first release and nothing anywhere could turn an email
 * address into that `:id` — no list, no search, no console screen — so the
 * documented way to give somebody credits was to read `users.id` out of a SQL
 * client. Meanwhile `services/purchase-cap.ts` told the reader that an
 * operator "can issue credits directly from the console", offering that as the
 * reason not to worry about the purchase cap stopping a real customer. The
 * escape hatch did not exist.
 *
 * What is tested here is mostly the refusals, because the refusals are the
 * feature: a credit is a generation and a generation is provider cost, so this
 * screen spends money.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EntitlementSource } from '@yuha/contracts';
import { getBalance, listBatches, query } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

const root = resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

let h: Harness;
let admin: TestUser;
let support: TestUser;

beforeAll(async () => {
  h = await createHarness({
    ADMIN_MFA_REQUIRED: 'false',
    ADMIN_GRANT_MAX_UNITS: '100',
    ADMIN_GRANT_MAX_UNITS_PER_DAY: '150',
    ADMIN_GRANT_VALIDITY_DAYS: '90',
  });
});
beforeEach(async () => {
  await resetData();
  admin = await h.createUser({ email: 'ops-admin@example.test', role: 'admin' });
  support = await h.createUser({ email: 'ops-support@example.test', role: 'support' });
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const find = (who: TestUser, email: string) =>
  h.app.inject({
    method: 'GET',
    url: `/v1/admin/users?email=${encodeURIComponent(email)}`,
    headers: who.authHeader,
  });

const gift = (who: TestUser, userId: string, body: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/admin/users/${userId}/grant`,
    headers: who.authHeader,
    payload: body as never,
  });

describe('looking a customer up', () => {
  it('finds them by their exact address, and reports what they hold', async () => {
    const friend = await h.createUser({ email: 'a-friend@example.test', credits: 7 });

    const res = await find(admin, 'a-friend@example.test');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ userId: friend.id, email: 'a-friend@example.test', available: 7 });
  });

  it('matches the start of an address but never the middle', async () => {
    await h.createUser({ email: 'alice@example.test' });
    await h.createUser({ email: 'bob@example.test' });

    // A prefix, which is what an operator typing an address produces.
    expect((await find(admin, 'alic')).json().items).toHaveLength(1);

    /*
     * And not a substring. `LIKE '%example%'` would return every customer —
     * two characters of a common domain is the whole customer list — and it
     * cannot use the index on email either. A support tool that takes any
     * fragment of anything is a people search.
     */
    expect((await find(admin, 'example.test')).json().items).toHaveLength(0);
  });

  it('refuses to answer a query short enough to enumerate with', async () => {
    await h.createUser({ email: 'aaa@example.test' });
    // Two characters is a listing, not a search.
    expect((await find(admin, 'aa')).statusCode).toBe(400);
  });

  it('does not let an underscore in an address act as a wildcard', async () => {
    /*
     * `_` is LIKE's single-character wildcard. Unescaped, a search for
     * `a_b@example.test` also matches `axb@example.test` — so an operator
     * pasting a real address gets back an account that is not the one they
     * meant, which is the worst possible moment for a near miss.
     */
    const meant = await h.createUser({ email: 'a_b@example.test' });
    await h.createUser({ email: 'axb@example.test' });

    const items = (await find(admin, 'a_b@example.test')).json().items;
    expect(items).toHaveLength(1);
    expect(items[0].userId).toBe(meant.id);
  });

  it('leaves out an account whose deletion was executed', async () => {
    const gone = await h.createUser({ email: 'deleted-person@example.test' });
    await query(`UPDATE users SET status = 'deleted', deleted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [gone.id]);
    // Granting credits to the row a deletion left behind would quietly undo it.
    expect((await find(admin, 'deleted-person@example.test')).json().items).toHaveLength(0);
  });

  it('leaves out a row with a deletion timestamp and no deleted status', async () => {
    /*
     * The two halves of the exclusion, pulled apart.
     *
     * The query matches `email_active`, a generated column that is `email`
     * while `deleted_at IS NULL` and NULL otherwise — which is also the only
     * indexed form of the address. So the timestamp alone is enough, and this
     * is the case that a search written against plain `email` would return
     * while still passing the test above, where both fields are set. The
     * `status` filter is the mirror of this test and covers the reverse.
     */
    const halfGone = await h.createUser({ email: 'half-deleted@example.test' });
    await query(`UPDATE users SET deleted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [halfGone.id]);
    expect((await find(admin, 'half-deleted@example.test')).json().items).toHaveLength(0);
  });

  it('is closed to customers', async () => {
    const nosy = await h.createUser({ email: 'nosy@example.test' });
    expect((await find(nosy, 'nosy@example.test')).statusCode).toBe(403);
  });

  it('shows where each batch of credits came from, not just a total', async () => {
    /*
     * The batch list is the point. An operator about to give somebody fifty
     * credits should see that they already hold some, and from what — a
     * compensation means we may owe them an apology rather than a gift.
     */
    const friend = await h.createUser({ email: 'has-history@example.test', credits: 4 });
    await gift(admin, friend.id, { units: 6, reason: 'a birthday present' });

    const detail = (
      await h.app.inject({ method: 'GET', url: `/v1/admin/users/${friend.id}`, headers: admin.authHeader })
    ).json();
    expect(detail.balance.available).toBe(10);
    expect(detail.credits.map((c: { source: string }) => c.source).sort()).toEqual([
      'manual_adjustment',
      'operator_gift',
    ]);
  });
});

describe('giving credits away', () => {
  it('gives the asked-for number, dated, and says when they expire', async () => {
    const friend = await h.createUser({ email: 'fifty-please@example.test' });

    const res = await gift(admin, friend.id, { units: 50, reason: 'a friend trying the product' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ units: 50, remainingToday: 100 });

    expect((await getBalance(friend.id)).available).toBe(50);
    const [batch] = await listBatches(friend.id);
    expect(batch!.source).toBe('operator_gift');
    // Not open-ended: a giveaway that never expires is a liability nobody
    // remembers agreeing to.
    expect(batch!.expires_at).toBeInstanceOf(Date);
    const days = (batch!.expires_at!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  it('is recorded as a gift, never as an apology for a failure', async () => {
    /*
     * The whole reason this is not just `compensate` with a bigger cap.
     * `compensation` says in the books that we broke something; routing a
     * deliberate giveaway through it would make every gift read as an
     * apology, and "how much have we given away" — a question somebody asks
     * the first time the provider bill outruns revenue — would have no answer.
     */
    const friend = await h.createUser({ email: 'booked-right@example.test' });
    await gift(admin, friend.id, { units: 5, reason: 'a friend trying the product' });

    const [batch] = await listBatches(friend.id);
    expect(batch!.source).toBe('operator_gift');
    expect(batch!.source).not.toBe('compensation');

    const audit = await query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit_logs WHERE subject_id = ? ORDER BY created_at DESC`,
      [friend.id],
    );
    expect(audit[0]!.action).toBe('entitlement.gifted');
    expect(audit[0]!.reason).toBe('a friend trying the product');
  });

  it('refuses more than one gift may carry', async () => {
    const friend = await h.createUser({ email: 'too-generous@example.test' });
    // 500 instead of 50 is one keystroke.
    const res = await gift(admin, friend.id, { units: 500, reason: 'a slip of the finger' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('100');
    expect((await getBalance(friend.id)).available).toBe(0);
  });

  it('refuses past the daily total, which is what the per-gift cap does not bound', async () => {
    /*
     * The per-gift cap alone bounds nothing: fifty gifts of fifty is still two
     * and a half thousand generations of provider cost. The account doing
     * that is a compromised one rather than a careless one, and an audit log
     * read tomorrow is not a limit.
     */
    const a = await h.createUser({ email: 'daily-a@example.test' });
    const b = await h.createUser({ email: 'daily-b@example.test' });

    expect((await gift(admin, a.id, { units: 100, reason: 'first round of gifts' })).statusCode).toBe(200);
    const second = await gift(admin, b.id, { units: 100, reason: 'second round of gifts' });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.message).toContain('daily');
    expect((await getBalance(b.id)).available).toBe(0);

    // And the remainder is still spendable, so the cap is a ceiling and not a
    // switch that trips.
    expect((await gift(admin, b.id, { units: 50, reason: 'the rest of the allowance' })).statusCode).toBe(200);
  });

  it('counts the day per operator, not per deployment', async () => {
    /*
     * Otherwise one busy operator stops everybody else from doing their job.
     *
     * The numbers are chosen so a GLOBAL cap would fail this test: the daily
     * allowance in this harness is 150, and the two gifts total 200. A test
     * that gave 100 + 100 under a 500 limit would pass either way and prove
     * nothing about which total is being counted.
     */
    const other = await h.createUser({ email: 'ops-admin-two@example.test', role: 'admin' });
    const friend = await h.createUser({ email: 'two-operators@example.test' });

    expect((await gift(admin, friend.id, { units: 100, reason: 'first operator gives' })).statusCode).toBe(200);
    expect((await gift(other, friend.id, { units: 100, reason: 'second operator gives' })).statusCode).toBe(200);
    expect((await getBalance(friend.id)).available).toBe(200);
  });

  it('holds the daily total against this operator even in parallel', async () => {
    /*
     * The cap is a read followed by a write, and without a lock on the
     * OPERATOR'S own row it is a suggestion: two requests aimed at two
     * DIFFERENT recipients take two different recipient locks, both see the
     * same stale total, and both commit. Measured before the lock existed —
     * fifty parallel requests wrote five thousand units against a
     * five-hundred-a-day limit.
     *
     * Five recipients, 100 each, against an allowance of 150: at most one can
     * succeed, whatever the interleaving.
     */
    const friends = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => h.createUser({ email: `parallel-${n}@example.test` })),
    );
    const results = await Promise.all(
      friends.map((f, i) => gift(admin, f.id, { units: 100, reason: `parallel gift number ${i}` })),
    );

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const total = (await Promise.all(friends.map((f) => getBalance(f.id)))).reduce(
      (sum, b) => sum + b.available,
      0,
    );
    expect(total).toBe(100);
  });

  it('reports a remaining allowance that matches what the next gift is allowed', async () => {
    // `remainingToday` was computed from the same stale read as the cap, so it
    // told every one of a set of parallel callers the same wrong number.
    const friend = await h.createUser({ email: 'remaining@example.test' });
    const first = await gift(admin, friend.id, { units: 60, reason: 'the first of two gifts' });
    expect(first.json().remainingToday).toBe(90);

    const second = await gift(admin, friend.id, { units: 90, reason: 'exactly the remainder' });
    expect(second.statusCode).toBe(200);
    expect(second.json().remainingToday).toBe(0);

    expect((await gift(admin, friend.id, { units: 1, reason: 'one past the allowance' })).statusCode).toBe(400);
  });

  it('demands a reason, because the audit row is the only record of why', async () => {
    const friend = await h.createUser({ email: 'no-reason@example.test' });
    expect((await gift(admin, friend.id, { units: 5, reason: '' })).statusCode).toBe(400);
    expect((await gift(admin, friend.id, { units: 5 })).statusCode).toBe(400);
    expect((await getBalance(friend.id)).available).toBe(0);
  });

  it('refuses a fractional or negative number of credits', async () => {
    const friend = await h.createUser({ email: 'odd-numbers@example.test' });
    for (const units of [0, -5, 1.5]) {
      expect((await gift(admin, friend.id, { units, reason: 'a strange request' })).statusCode).toBe(400);
    }
    expect((await getBalance(friend.id)).available).toBe(0);
  });

  it('lets an operator shorten the validity but never lengthen it', async () => {
    const friend = await h.createUser({ email: 'short-dated@example.test' });

    const ok = await gift(admin, friend.id, { units: 3, reason: 'a week to try it', validityDays: 7 });
    expect(ok.statusCode).toBe(200);
    const days = (new Date(ok.json().expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeLessThan(8);

    const tooLong = await gift(admin, friend.id, { units: 3, reason: 'for ever please', validityDays: 365 });
    expect(tooLong.statusCode).toBe(400);
  });

  it('is closed to support, and to customers', async () => {
    /*
     * Support can compensate — that is an apology for a failure, capped at
     * twenty, and refusing it would stop support doing its job. Giving credits
     * away spends money, which is a different authority.
     */
    const friend = await h.createUser({ email: 'wrong-hands@example.test' });
    expect((await gift(support, friend.id, { units: 5, reason: 'support tries to give' })).statusCode).toBe(403);
    expect((await getBalance(friend.id)).available).toBe(0);

    const customer = await h.createUser({ email: 'self-service@example.test' });
    expect((await gift(customer, customer.id, { units: 5, reason: 'helping myself' })).statusCode).toBe(403);
    expect((await getBalance(customer.id)).available).toBe(0);
  });

  it('refuses a suspended account, and one already deleted', async () => {
    const suspended = await h.createUser({ email: 'suspended-one@example.test' });
    await query(`UPDATE users SET status = 'suspended' WHERE id = ?`, [suspended.id]);
    expect((await gift(admin, suspended.id, { units: 5, reason: 'serving a stopped account' })).statusCode).toBe(403);

    const gone = await h.createUser({ email: 'gone-already@example.test' });
    await query(`UPDATE users SET status = 'deleted', deleted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [gone.id]);
    expect((await gift(admin, gone.id, { units: 5, reason: 'undoing a deletion' })).statusCode).toBe(404);
  });

  it('gives twice when asked twice, rather than swallowing the second as a retry', async () => {
    /*
     * The opposite of what the order and invoice paths want. Those key on a
     * business reference so a replayed webhook grants once; a person clicking
     * "give 50" twice means a hundred, because each click is a decision
     * somebody made rather than a delivery being retried.
     */
    const friend = await h.createUser({ email: 'twice-over@example.test' });
    await gift(admin, friend.id, { units: 20, reason: 'first gift to this person' });
    await gift(admin, friend.id, { units: 20, reason: 'second gift to this person' });
    expect((await getBalance(friend.id)).available).toBe(40);
    expect(await listBatches(friend.id)).toHaveLength(2);
  });

  it('can be switched off entirely', async () => {
    const off = await createHarness({ ADMIN_MFA_REQUIRED: 'false', ADMIN_GRANT_MAX_UNITS: '0' });
    try {
      const ops = await off.createUser({ email: 'offswitch-admin@example.test', role: 'admin' });
      const friend = await off.createUser({ email: 'offswitch-friend@example.test' });
      const res = await off.app.inject({
        method: 'POST',
        url: `/v1/admin/users/${friend.id}/grant`,
        headers: ops.authHeader,
        payload: { units: 5, reason: 'gifting is switched off here' } as never,
      });
      expect(res.statusCode).toBe(403);
      // The message, not only the code: 403 is also what the role gate, the
      // MFA gate and the suspended-account refusal return, so a harness
      // misconfiguration would otherwise make this pass for the wrong reason.
      expect(res.json().error.message).toContain('switched off');
    } finally {
      await off.close();
    }
  });
});

describe('compensation is bounded too', () => {
  /*
   * `POST /v1/admin/users/:id/compensate` is capped at 20 per call and was
   * capped at nothing per day — while the gift path's daily cap was being
   * described in docs/OPERATIONS.md as the protection against a compromised
   * operator account. Twenty at a time, repeated, is unbounded; and this route
   * is open to `support`, which is the wider of the two doors.
   */
  const compensate = (who: TestUser, userId: string, units: number, reason: string) =>
    h.app.inject({
      method: 'POST',
      url: `/v1/admin/users/${userId}/compensate`,
      headers: who.authHeader,
      payload: { units, reason } as never,
    });

  it('refuses past the operator\'s daily compensation total', async () => {
    const capped = await createHarness({
      ADMIN_MFA_REQUIRED: 'false',
      ADMIN_COMPENSATION_MAX_UNITS_PER_DAY: '30',
    });
    try {
      const agent = await capped.createUser({ email: 'cap-support@example.test', role: 'support' });
      const hurt = await capped.createUser({ email: 'cap-customer@example.test' });
      const post = (units: number, reason: string) =>
        capped.app.inject({
          method: 'POST',
          url: `/v1/admin/users/${hurt.id}/compensate`,
          headers: agent.authHeader,
          payload: { units, reason } as never,
        });

      expect((await post(20, 'upstream outage, first batch')).statusCode).toBe(200);
      const over = await post(20, 'upstream outage, second batch');
      expect(over.statusCode).toBe(400);
      expect(over.json().error.message).toContain('daily compensation');
      // The remainder is still usable, so it is a ceiling and not a trip switch.
      expect((await post(10, 'upstream outage, the remainder')).statusCode).toBe(200);
    } finally {
      await capped.close();
    }
  });

  it('keeps its allowance separate from the gift allowance', async () => {
    /*
     * One must not eat the other's budget: they answer to different limits for
     * different reasons.
     *
     * The numbers are chosen so a MERGED budget fails. This harness allows
     * 150 gift units a day; the gift below takes 140, leaving 10. A shared
     * pool would then refuse the 20-unit compensation, so the second 200 is
     * the assertion. The first version gifted 100 and compensated 20 against
     * allowances of 150 and 2000, which passes whether the budgets are
     * separate or shared — the test name was the one thing it did not test.
     */
    const friend = await h.createUser({ email: 'separate-budgets@example.test' });
    // Two gifts, because a single 140 would hit the 100 per-gift cap. Together
    // they take 140 of the 150 daily allowance, leaving 10.
    expect((await gift(admin, friend.id, { units: 100, reason: 'most of the gift allowance' })).statusCode).toBe(200);
    expect((await gift(admin, friend.id, { units: 40, reason: 'the rest of the gift allowance' })).statusCode).toBe(200);
    // 140 + 20 = 160, past the 150 gift allowance — so this can only succeed
    // if compensation counts against its own.
    expect((await compensate(admin, friend.id, 20, 'a failure of ours, unrelated')).statusCode).toBe(200);
    expect((await getBalance(friend.id)).available).toBe(160);
  });

  it('refuses a reason too long for the ledger column instead of answering 500', async () => {
    /*
     * `ledger_entries.reason` is VARCHAR(255) and the route used to allow 500.
     * With the `operator_gift: ` prefix that is 515 characters for a 255-byte
     * column, so an operator pasting a long justification got
     * ER_DATA_TOO_LONG — not an AppError, therefore a bare 500
     * INTERNAL_ERROR with nothing pointing at the field — and then retried.
     */
    const friend = await h.createUser({ email: 'long-reason@example.test' });
    const tooLong = await gift(admin, friend.id, { units: 5, reason: 'x'.repeat(300) });
    expect(tooLong.statusCode).toBe(400);
    expect((await getBalance(friend.id)).available).toBe(0);

    // And a reason that fits still works, prefix included.
    const ok = await gift(admin, friend.id, { units: 5, reason: 'y'.repeat(200) });
    expect(ok.statusCode).toBe(200);
  });

  it('treats a repeated idempotency key as a retry, not as a second gift', async () => {
    /*
     * The one money endpoint in this API that had no idempotency key, while
     * `IDEMPOTENCY_HEADER` and `idempotencyKeySchema` are a convention
     * enforced on licence purchase and both generation routes. The failure is
     * ordinary: the API commits, the response is lost to an idle timeout or a
     * pod roll, the console shows an error beside the pre-gift balance, and
     * the operator types the number again.
     */
    const friend = await h.createUser({ email: 'retried-gift@example.test' });
    const body = { units: 30, reason: 'a gift that was retried', idempotencyKey: 'gift-retry-key-1' };

    const first = await gift(admin, friend.id, body);
    const second = await gift(admin, friend.id, body);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ replayed: true, batchId: first.json().batchId });

    expect((await getBalance(friend.id)).available).toBe(30);
    expect(await listBatches(friend.id)).toHaveLength(1);
    // One gift, one audit row — the operator asked once.
    const audit = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE subject_id = ? AND action = 'entitlement.gifted'`,
      [friend.id],
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('still gives twice when the second gift carries its own key', async () => {
    // A deliberate second gift sends a NEW key. The key tells the two apart;
    // it does not stop anybody giving twice.
    const friend = await h.createUser({ email: 'two-keys@example.test' });
    await gift(admin, friend.id, { units: 10, reason: 'the first gift', idempotencyKey: 'two-keys-a' });
    await gift(admin, friend.id, { units: 10, reason: 'the second gift', idempotencyKey: 'two-keys-b' });
    expect((await getBalance(friend.id)).available).toBe(20);
  });

  it('refuses a compensation for a deleted or suspended account', async () => {
    /*
     * `grant` refused both from the start; `compensate` refused neither,
     * although it is the wider door — open to `support`, with four times the
     * daily allowance. Crediting the row an executed erasure left behind
     * partially reverses the erasure.
     */
    const gone = await h.createUser({ email: 'compensate-gone@example.test' });
    await query(`UPDATE users SET status = 'deleted', deleted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [gone.id]);
    expect((await compensate(support, gone.id, 5, 'compensating a tombstone')).statusCode).toBe(404);

    const stopped = await h.createUser({ email: 'compensate-stopped@example.test' });
    await query(`UPDATE users SET status = 'suspended' WHERE id = ?`, [stopped.id]);
    expect((await compensate(support, stopped.id, 5, 'compensating a stopped account')).statusCode).toBe(403);
  });

  it('answers 400 rather than 500 for a compensation to a non-uuid id', async () => {
    // It reached the entitlement_batches foreign key and surfaced as a 500.
    const res = await compensate(support, 'not-a-uuid', 5, 'a malformed account id');
    expect(res.statusCode).toBe(400);
  });
});

describe('the gift source is one list, in three places', () => {
  it('the migration, the zod enum and the database agree', async () => {
    /*
     * A CHECK constraint is an explicit list, which is the shape this
     * repository has been bitten by five times. There are three copies of it:
     * migration 0018, the zod enum, and the live column. Any two can agree
     * while the third does not — and an `operator_gift` the CHECK rejects
     * fails at the INSERT, in production, on the one action that spends money.
     */
    const migration = read('packages/db/src/migrations/0018_an_operator_can_give_credits_away.sql');
    /*
     * Only the CHECK's own list, not every quoted string in the file. Taken
     * over the whole text this would also pick up anything quoted in the
     * comment block above it, so adding a seventh value to the comment while
     * forgetting the constraint would have passed.
     */
    // Anchored to the ADD CONSTRAINT, not to the first `source IN (` in the
    // file: the comment block above it is prose that could easily contain the
    // phrase, and then a seventh value added to the comment alone would pass.
    const list = /ADD CONSTRAINT[\s\S]*?source IN\s*\(([^)]*)\)/.exec(migration)?.[1];
    expect(list, 'migration 0018 has no `source IN (...)` list').toBeTruthy();
    const inMigration = [...list!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...new Set(inMigration)].sort()).toEqual([...EntitlementSource.options].sort());

    /*
     * `CONSTRAINT_SCHEMA = DATABASE()` is not tidiness. Without it this read
     * the constraint from whichever database information_schema listed first —
     * loopscene_dev, on a machine that has one — and reported that the live
     * CHECK rejects `operator_gift` while the inserts above were succeeding
     * against the test schema. A check that queries the wrong database answers
     * confidently about something it is not looking at.
     */
    const [col] = await query<{ cc: string }>(
      `SELECT CHECK_CLAUSE AS cc FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND CONSTRAINT_NAME = 'entitlement_batches_source_chk'`,
    );
    expect(col, 'the source CHECK is not on this schema at all').toBeTruthy();
    for (const source of EntitlementSource.options) {
      expect(col!.cc, `the live CHECK does not allow ${source}`).toContain(source);
    }
    /*
     * And nothing MORE than the enum. `toContain` in one direction only
     * proves the CHECK permits each value — a later migration that adds a
     * seventh without touching the enum would pass, and then a source exists
     * in the database that no API response can name.
     */
    /*
     * MySQL renders the clause with charset introducers and escaped quotes —
     * `(\`source\` in (_utf8mb4\\'one_time_order\\',…))` — so the backslashes
     * come off before the literals are read. Matching `'([a-z_]+)'` against
     * the raw text found nothing and compared an empty list, which is a check
     * that cannot fail in the other direction.
     */
    const inLiveCheck = [...col!.cc.replace(/\\/g, '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(inLiveCheck.length, 'no literals were parsed out of the live CHECK clause').toBeGreaterThan(0);
    expect([...new Set(inLiveCheck)].sort()).toEqual([...EntitlementSource.options].sort());
  });

  it('every source the enum names has a label in all three languages', async () => {
    // A source with no translation renders as its own key — `operator_gift` —
    // on the screen an operator reads to decide whether somebody needs a gift.
    const dict = read('apps/web/src/lib/i18n.tsx');
    for (const source of EntitlementSource.options) {
      const uses = [...dict.matchAll(new RegExp(`'admin\\.cust\\.source\\.${source}':`, 'g'))];
      expect(uses, `admin.cust.source.${source} is missing from a dictionary`).toHaveLength(3);
    }
  });
});
