/**
 * Credit resets (docs/CREDIT_RESET.md): an operator, when they choose, tops
 * every active account up to 5 counting everything it holds, and gives every
 * account that paid since the previous reset 5 more. Both expire at the next
 * reset, so free credits never pile up, and they are spent before anything
 * the customer paid for, so the reset never wipes credits a customer could
 * have used instead of their own.
 *
 * Every credit is a generation and a generation is provider cost, so what is
 * pinned here is the arithmetic, the expiry, the spending order, that a reset
 * runs once however often it is asked for, that an interrupted one finishes
 * without paying anyone twice, and that only an admin can start one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getBalance, grantUnits, listBatches, query, queryOne, reconcileBalances, reserveUnit, resetAccount, withTx, type CreditResetRow } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';
import { allowInvariantBreach } from './helpers/invariant-guard.js';

let h: Harness;
let admin: TestUser;

beforeAll(async () => {
  h = await createHarness({ ADMIN_MFA_REQUIRED: 'false' });
});
beforeEach(async () => {
  await resetData();
  admin = await h.createUser({ email: 'reset-admin@example.test', role: 'admin' });
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

/** A purchase: a one-time pack batch, as fulfilment grants it, optionally back-dated. */
async function bought(userId: string, units: number, daysAgo = 0) {
  const ref = `order-${randomUUID()}`;
  await withTx((tx) =>
    grantUnits({ userId, source: 'one_time_order', sourceRef: ref, units, reason: 'test_purchase', expiresAt: new Date(Date.now() + 90 * 86400_000) }, tx),
  );
  if (daysAgo) {
    await query(`UPDATE entitlement_batches SET created_at = UTC_TIMESTAMP(3) - INTERVAL ? DAY WHERE source_ref = ?`, [daysAgo, ref]);
  }
}

const available = async (u: { id: string }) => (await getBalance(u.id)).available;

const start = (who: TestUser, body: Record<string, unknown> = {}) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/admin/credit-resets',
    headers: who.authHeader,
    payload: { reason: 'monthly reset', idempotencyKey: `reset-${randomUUID()}`, ...body } as never,
  });

const overview = (who: TestUser) => h.app.inject({ method: 'GET', url: '/v1/admin/credit-resets', headers: who.authHeader });

/** Starts a reset and waits for it to finish, as the console does by polling. */
async function reset(body: Record<string, unknown> = {}) {
  const res = await start(admin, body);
  expect(res.statusCode).toBe(202);
  const id = res.json().id as string;
  for (let i = 0; i < 200; i += 1) {
    const r = await h.app.inject({ method: 'GET', url: `/v1/admin/credit-resets/${id}`, headers: admin.authHeader });
    if (r.json().status === 'done') return r.json();
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error('reset did not finish');
}

describe('a reset', () => {
  it('tops every active account up to 5, counting what it already holds', async () => {
    const empty = await h.createUser();
    const three = await h.createUser({ credits: 3 });
    const seven = await h.createUser({ credits: 7 });
    await reset();
    expect(await available(empty)).toBe(5);
    expect(await available(three)).toBe(5);
    expect(await available(seven)).toBe(7);
  });

  it('gives 5 more to an account that paid since the previous reset, after the top-up', async () => {
    const payer = await h.createUser();
    await bought(payer.id, 3);
    const lapsed = await h.createUser();
    await bought(lapsed.id, 3, 60); // before the first reset's 30-day window
    await reset();
    expect(await available(payer)).toBe(5 + 5); // 3 bought + 2 top-up + 5 bonus
    expect(await available(lapsed)).toBe(5); // 3 bought + 2 top-up
  });

  it('leaves suspended and deleted accounts alone', async () => {
    const suspended = await h.createUser();
    const deleted = await h.createUser();
    await query(`UPDATE users SET status = 'suspended' WHERE id = ?`, [suspended.id]);
    await query(`UPDATE users SET status = 'deleted', deleted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [deleted.id]);
    await reset();
    expect(await available(suspended)).toBe(0);
    expect(await available(deleted)).toBe(0);
  });

  it('expires the previous reset’s credits, so free credits never pile up', async () => {
    const idle = await h.createUser();
    const payer = await h.createUser();
    await bought(payer.id, 3);
    await reset();
    expect(await available(idle)).toBe(5);
    expect(await available(payer)).toBe(10);
    await reset();
    // Still 5, not 10: the first reset's five are gone and five new ones stand in.
    expect(await available(idle)).toBe(5);
    // No purchase since the first reset: the bonus is not repeated; the 3 bought remain.
    expect(await available(payer)).toBe(5);
    expect((await listBatches(idle.id)).filter((b) => b.source === 'credit_reset' && b.status === 'active' && (!b.expires_at || b.expires_at > new Date()))).toHaveLength(1);
  });

  it('spends reset credits before anything the customer paid for', async () => {
    const u = await h.createUser();
    await bought(u.id, 3);
    await reset();
    const r = await withTx((tx) => reserveUnit({ userId: u.id, jobId: randomUUID() }, tx));
    expect(r.ok).toBe(true);
    const [batch] = await query<{ source: string }>(`SELECT source FROM entitlement_batches WHERE id = ?`, [r.ok ? r.batchId : '']);
    expect(batch!.source).toBe('credit_reset');
  });

  it('runs once for one idempotency key, however often it is asked', async () => {
    const u = await h.createUser();
    const key = `reset-${randomUUID()}`;
    const first = await reset({ idempotencyKey: key });
    const again = await start(admin, { idempotencyKey: key });
    expect(again.json().id).toBe(first.id);
    await new Promise((ok) => setTimeout(ok, 100));
    expect(await available(u)).toBe(5);
    expect(await query(`SELECT id FROM credit_resets`)).toHaveLength(1);
  });

  it('refuses to start a second reset while one is unfinished', async () => {
    await query(
      `INSERT INTO credit_resets (id, idempotency_key, actor_id, reason, floor_units, bonus_units, window_start, status)
       VALUES (?, 'stuck', ?, 'left running', 5, 5, UTC_TIMESTAMP(3), 'running')`,
      [randomUUID(), admin.id],
    );
    const res = await start(admin);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('finishes an interrupted reset without paying anyone twice', async () => {
    const users = await Promise.all(Array.from({ length: 6 }, () => h.createUser()));
    const done = await reset();
    // Pretend it stopped half way: rewind the cursor and mark it running again.
    const ids = (await query<{ id: string }>(`SELECT id FROM users WHERE status = 'active' ORDER BY id`)).map((r) => r.id);
    await query(`UPDATE credit_resets SET status = 'running', finished_at = NULL, cursor_user_id = ? WHERE id = ?`, [ids[2], done.id]);
    const resumed = await reset({ idempotencyKey: done.idempotencyKey });
    expect(resumed.id).toBe(done.id);
    for (const u of users) expect(await available(u)).toBe(5);
    expect(await reconcileBalances()).toEqual([]);
  });

  /*
   * Review S1. Two API pods: one is still walking reset A's accounts when A
   * is finished by the other and an admin starts B. The slow runner's next
   * account expired every credit_reset batch not its own — B's included —
   * and A's floor had already been given, so the account was left at 0.
   */
  it('a runner still holding a finished reset changes nothing, and never expires a newer reset', async () => {
    const u = await h.createUser();
    const a = await reset();
    const b = await reset();
    expect(await available(u)).toBe(5);
    const staleA = (await queryOne<CreditResetRow>(`SELECT * FROM credit_resets WHERE id = ?`, [a.id]))!;
    const out = await withTx((tx) => resetAccount(staleA, u.id, tx));
    expect(out).toEqual({ topped: 0, bonus: 0 });
    expect(await available(u)).toBe(5);
    void b;
  });

  /*
   * Review R3. "Paid since the last reset, and not refunded in full"
   * (docs/CREDIT_RESET.md) was read off the credits: a batch not revoked.
   * Buy five, use one, refund in full — four are revoked, the used one keeps
   * the batch active, and the refunded buyer got the paying customer's bonus.
   */
  it('gives no paid bonus for a purchase refunded in full, in the preview or the run', async () => {
    // An order written as refunded with its credit still granted: the reset
    // must judge by the order, whatever the batch says.
    allowInvariantBreach('refunded-order-left-nothing-spendable');
    const refunded = await h.createUser();
    const partial = await h.createUser();
    for (const [user, status] of [[refunded, 'refunded'], [partial, 'partially_refunded']] as const) {
      const orderId = randomUUID();
      await query(
        `INSERT INTO orders (id, user_id, price_key, price_version, kind, amount_minor, currency, status, idempotency_key, metadata, payment_method)
         SELECT ?, ?, price_key, version, kind, amount_minor, currency, ?, ?, '{}', 'card' FROM product_catalog WHERE price_key = 'drop_5' ORDER BY version DESC LIMIT 1`,
        [orderId, user.id, status, `o-${orderId}`],
      );
      await withTx((tx) =>
        grantUnits({ userId: user.id, source: 'one_time_order', sourceRef: orderId, units: 1, reason: 'test_purchase' }, tx),
      );
    }
    const preview = (await overview(admin)).json().preview;
    expect(preview.bonusAccounts).toBe(1);
    await reset();
    expect(await available(refunded)).toBe(5); // 1 still held + 4 top-up, no bonus
    expect(await available(partial)).toBe(10); // partly refunded still paid: + 5
  });

  it('shows beforehand what it will give, and the run gives exactly that', async () => {
    const a = await h.createUser();
    const b = await h.createUser({ credits: 4 });
    const c = await h.createUser();
    await bought(c.id, 1);
    const preview = (await overview(admin)).json().preview;
    // admin 5, a 5, b 1, c 4 topped; c's bonus 5.
    expect(preview).toMatchObject({ accounts: 4, toppedAccounts: 4, toppedUnits: 15, bonusAccounts: 1, bonusUnits: 5, floor: 5, bonus: 5 });
    const done = await reset();
    expect(done).toMatchObject({ usersSeen: 4, usersTopped: 4, unitsTopped: 15, usersBonus: 1, unitsBonus: 5 });
    void a;
    void b;
  });

  it('is an admin’s decision, with a reason, and is audited', async () => {
    const support = await h.createUser({ role: 'support' });
    const user = await h.createUser();
    expect((await start(support)).statusCode).toBe(403);
    expect((await start(user)).statusCode).toBe(403);
    expect((await start(admin, { reason: '' })).statusCode).toBe(400);
    const done = await reset({ reason: 'October thank-you' });
    const audit = await query<{ action: string; reason: string; actor_id: string }>(
      `SELECT action, reason, actor_id FROM audit_logs WHERE subject_id = ? ORDER BY created_at, action`,
      [done.id],
    );
    expect(audit.map((a) => a.action).sort()).toEqual(['credit_reset.finished', 'credit_reset.started']);
    expect(audit.every((a) => a.reason === 'October thank-you' && a.actor_id === admin.id)).toBe(true);
  });

  it('keeps the ledger reconcilable', async () => {
    const u = await h.createUser({ credits: 2 });
    await bought(u.id, 1);
    await reset();
    await reset();
    expect(await reconcileBalances()).toEqual([]);
  });
});
