/**
 * Holding a paid card order until a person has looked at it.
 *
 * `docs/FRAUD_PREVENTION.md`'s measure ⑥ was real for the stablecoin channel
 * and absent for the card one — the channel carrying every payment today. What
 * is held is DELIVERY and never the payment: Stripe has taken it already, and
 * the thing that cannot be undone is the song somebody downloaded, not the
 * charge.
 *
 * The property that matters most here is not that a risky order is held. It is
 * that a held order stays held — `listUngrantedPaidOrders` selects exactly
 * "paid and not granted", which is what a held order looks like, so a hold
 * enforced anywhere other than inside the one grant function would be
 * delivered by the recovery sweep on its next pass. That is the same mistake
 * the stablecoin round made with its review state, which was set correctly and
 * reached nobody.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query, withTx } from '@yuha/db';
import { cardOrderRiskReasons } from '../apps/api/src/services/order-review.js';
import { base32Decode } from '../apps/api/src/auth/totp.js';
import { balanceOf, createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `198.19.0.${(callNo++ % 200) + 10}` });

/** A TOTP code, because the console requires staff to have a second factor. */
function totpAt(secret: string, atMs: number): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const hmac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

beforeAll(async () => {
  h = await createHarness({
    // A new account spending ¥980 is enough to be held here; production holds
    // at ¥5,000, which is five packs before anything has been listened to.
    CARD_REVIEW_NEW_ACCOUNT_VALUE_MINOR: '980',
    CARD_REVIEW_NEW_ACCOUNT_MINUTES: '60',
    CARD_REVIEW_VELOCITY_ORDERS: '10',
  });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await teardown();
});

async function staffUser(email: string, role: 'support' | 'admin'): Promise<TestUser> {
  const user = await h.createUser({ email, role });
  const enroll = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/enroll',
    headers: { ...user.authHeader, ...freshIp() },
  });
  expect(enroll.statusCode, enroll.body).toBe(200);
  await h.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/confirm',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { code: totpAt(enroll.json().secret as string, Date.now()) } as never,
  });
  return user;
}

/** The simulated session id behind a checkout URL. */
function sessionIdOf(checkoutUrl: string): string {
  return new URL(checkoutUrl).searchParams.get('session_id')!;
}

/**
 * Runs whatever webhook events are waiting, the way the worker does.
 *
 * `processWebhookEvent` takes a STORED event row and not a hand-written Stripe
 * object: the simulate endpoint records the event, and this claims and
 * processes it. Driving the handler with a literal would skip the recording
 * and the claim, which is most of what makes a redelivery safe.
 */
async function drainWebhooks(): Promise<number> {
  const { claimWebhookEvents } = await import('@yuha/db');
  const { processWebhookEvent } = await import('../apps/api/src/services/webhooks.js');
  const events = await withTx(async (tx) => claimWebhookEvents(20, tx));
  for (const ev of events) await processWebhookEvent(h.ctx, ev);
  return events.length;
}

/** Buys a DROP pack through the real checkout, the real provider and the real webhook. */
async function paidByCard(user: TestUser, key: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/checkout',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { priceKey: 'drop_5', idempotencyKey: key } as never,
  });
  expect(res.statusCode, res.body).toBe(200);
  const { orderId, checkoutUrl } = res.json() as { orderId: string; checkoutUrl: string };
  await h.app.inject({
    method: 'POST',
    url: '/v1/dev/simulate-payment',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { sessionId: sessionIdOf(checkoutUrl), outcome: 'paid' } as never,
  });
  await drainWebhooks();
  return orderId;
}

const queue = (user: TestUser) =>
  h.app.inject({ method: 'GET', url: '/v1/admin/order-reviews', headers: { ...user.authHeader, ...freshIp() } });

const decide = (user: TestUser, id: string, body: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/admin/order-reviews/${id}/decide`,
    headers: { ...user.authHeader, ...freshIp() },
    payload: body as never,
  });

describe('which signals fire', () => {
  const limits = { newAccountMinutes: 60, newAccountValueMinor: 5000, velocityOrders: 10 };
  const facts = { amountMinor: 980, accountAgeMs: 10 * 86_400_000, ordersStartedInWindow: 1, priorDisputes: 0 };

  it('says nothing about an ordinary purchase by an ordinary account', () => {
    expect(cardOrderRiskReasons(facts, limits)).toEqual([]);
  });

  it('needs BOTH halves of the new-account signal', () => {
    /*
     * Age alone describes every genuine first purchase, which is most
     * purchases; value alone describes a good customer. Only the pair looks
     * like a card tester's successful attempt.
     */
    expect(cardOrderRiskReasons({ ...facts, accountAgeMs: 60_000 }, limits)).toEqual([]);
    expect(cardOrderRiskReasons({ ...facts, amountMinor: 9800 }, limits)).toEqual([]);
    expect(cardOrderRiskReasons({ ...facts, accountAgeMs: 60_000, amountMinor: 9800 }, limits)).toEqual([
      'new_account_high_value',
    ]);
  });

  it('notices a previous chargeback on the account', () => {
    expect(cardOrderRiskReasons({ ...facts, priorDisputes: 1 }, limits)).toEqual(['prior_dispute']);
  });

  it('notices the tenth order in a day, which is below the purchase cap', () => {
    // The cap stops the twentieth; this is where a person would have started
    // wondering.
    expect(cardOrderRiskReasons({ ...facts, ordersStartedInWindow: 9 }, limits)).toEqual([]);
    expect(cardOrderRiskReasons({ ...facts, ordersStartedInWindow: 10 }, limits)).toEqual(['order_velocity']);
  });

  it('reports several signals in a stable order', () => {
    // The array is stored on the row and read back months later; an operator
    // comparing two holds should not have to notice the ordering.
    const all = cardOrderRiskReasons(
      { amountMinor: 9800, accountAgeMs: 60_000, ordersStartedInWindow: 12, priorDisputes: 2 },
      limits,
    );
    expect(all).toEqual(['new_account_high_value', 'order_velocity', 'prior_dispute']);
  });

  it('can be switched off a signal at a time', () => {
    const off = { ...limits, newAccountMinutes: 0, velocityOrders: 0 };
    expect(
      cardOrderRiskReasons({ amountMinor: 9800, accountAgeMs: 60_000, ordersStartedInWindow: 99, priorDisputes: 0 }, off),
    ).toEqual([]);
  });
});

describe('a held order', () => {
  it('takes the payment and delivers nothing yet', async () => {
    const user = await h.createUser({ email: 'hold-new@example.jp' });
    const orderId = await paidByCard(user, 'hold-new-0001');

    const orders = await query<{ status: string; granted: Date | null }>(
      `SELECT status, entitlement_granted_at AS granted FROM orders WHERE id = ?`,
      [orderId],
    );
    expect(orders[0]!.status).toBe('paid');
    expect(orders[0]!.granted).toBeNull();
    expect((await balanceOf(user.id)).available).toBe(0);

    const reviews = await query<{ reasons: string[] }>(`SELECT reasons FROM order_reviews WHERE order_id = ?`, [
      orderId,
    ]);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.reasons).toContain('new_account_high_value');
  });

  it('tells the customer, rather than leaving a page polling for nothing', async () => {
    /*
     * The alternative is a success page that waits for a grant which is not
     * coming and eventually says "this is taking a while" — true and useless.
     * A customer whose money has been taken is owed the actual reason.
     */
    const user = await h.createUser({ email: 'hold-says@example.jp' });
    const orderId = await paidByCard(user, 'hold-says-0001');
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: { ...user.authHeader, ...freshIp() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().heldForReview).toBe(true);
    expect(res.json().entitlementGranted).toBe(false);

    const list = await h.app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: { ...user.authHeader, ...freshIp() },
    });
    expect(list.json().items[0].heldForReview).toBe(true);
  });

  it('is NOT delivered by the recovery sweep, which is the whole point', async () => {
    /*
     * `listUngrantedPaidOrders` selects "paid and not granted", which is
     * exactly what a held order looks like. A hold enforced anywhere other
     * than inside the one grant function both channels and this sweep run
     * would be delivered on the next pass — cosmetic, and discovered in
     * production.
     */
    const user = await h.createUser({ email: 'hold-sweep@example.jp' });
    const orderId = await paidByCard(user, 'hold-sweep-0001');

    const { recoverUngrantedOrders } = await import('../apps/api/src/services/webhooks.js');
    expect(await recoverUngrantedOrders(h.ctx)).toBe(0);
    expect((await balanceOf(user.id)).available).toBe(0);

    const orders = await query<{ granted: Date | null }>(
      `SELECT entitlement_granted_at AS granted FROM orders WHERE id = ?`,
      [orderId],
    );
    expect(orders[0]!.granted).toBeNull();
  });

  it('is not opened twice by a replayed webhook', async () => {
    const user = await h.createUser({ email: 'hold-replay@example.jp' });
    const orderId = await paidByCard(user, 'hold-replay-0001');
    /*
     * The same session settled again: `markOrderPaid` reports no change and
     * nothing after it runs, but the insert is IGNORE-guarded regardless — a
     * second review row would mean two queue entries for one order and two
     * decisions to make.
     */
    const session = await query<{ sid: string }>(
      `SELECT stripe_checkout_session_id AS sid FROM orders WHERE id = ?`,
      [orderId],
    );
    await h.app.inject({
      method: 'POST',
      url: '/v1/dev/simulate-payment',
      headers: { ...user.authHeader, ...freshIp() },
      payload: { sessionId: session[0]!.sid, outcome: 'paid' } as never,
    });
    await drainWebhooks();

    const reviews = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM order_reviews WHERE order_id = ?`, [
      orderId,
    ]);
    expect(Number(reviews[0]!.n)).toBe(1);
  });
});

describe('an operator deciding', () => {
  it('releases it, and delivery happens through the same path as everything else', async () => {
    const user = await h.createUser({ email: 'rel-user@example.jp' });
    const orderId = await paidByCard(user, 'release-0001');
    const admin = await staffUser('rel-adm@example.jp', 'admin');

    const listed = await queue(admin);
    expect(listed.statusCode).toBe(200);
    const item = listed.json().items[0];
    expect(item.orderId).toBe(orderId);
    expect(item.amountMinor).toBe(980);
    expect(item.userEmail).toBe('rel-user@example.jp');

    const res = await decide(admin, item.reviewId as string, {
      decision: 'release',
      reason: 'known customer, card matches the account name',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().delivered).toBe(true);
    expect((await balanceOf(user.id)).available).toBe(5);

    // Out of the queue, and on the audit trail with who and why.
    expect((await queue(admin)).json().items).toHaveLength(0);
    const audit = await query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit_logs WHERE subject_id = ?`,
      [orderId],
    );
    expect(audit[0]!.action).toBe('card_order.release');
    expect(audit[0]!.reason).toMatch(/known customer/);
  });

  it('refuses it, delivers nothing, and does not pretend to have refunded', async () => {
    /*
     * The refund happens in Stripe, by a person, and the refund webhook is
     * what records it here. A button that implied otherwise would be the same
     * failure as a UI that says "saved" without saving.
     */
    const user = await h.createUser({ email: 'ref-user@example.jp' });
    const orderId = await paidByCard(user, 'refuse-0001');
    const admin = await staffUser('ref-adm@example.jp', 'admin');
    const reviewId = (await queue(admin)).json().items[0].reviewId as string;

    const res = await decide(admin, reviewId, { decision: 'refuse', reason: 'card reported stolen by the issuer' });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(false);
    expect((await balanceOf(user.id)).available).toBe(0);

    const orders = await query<{ status: string; granted: Date | null }>(
      `SELECT status, entitlement_granted_at AS granted FROM orders WHERE id = ?`,
      [orderId],
    );
    // Still paid: the money really was taken, and saying otherwise here would
    // make the record disagree with Stripe.
    expect(orders[0]!.status).toBe('paid');
    expect(orders[0]!.granted).toBeNull();
  });

  it('cannot be decided twice at the database, which is the guard for two operators at once', async () => {
    /*
     * Tested at the db function and not through the route, deliberately.
     *
     * `decideHeldOrder` reads the review first and refuses an already-decided
     * one, so a SEQUENTIAL second call is caught before the UPDATE is reached
     * — which means a test through the route proves nothing about the UPDATE's
     * `AND decided_at IS NULL`. That clause is the guard for two operators
     * clicking in the same instant, and removing it survived a route-level
     * test. This is the third time an earlier guard answering first has made a
     * regression test vacuous here, so this one asks the statement directly.
     */
    const user = await h.createUser({ email: 'dbrace-user@example.jp' });
    await paidByCard(user, 'dbrace-0001');
    const { decideOrderReview, listOpenOrderReviews } = await import('@yuha/db');
    const [review] = await listOpenOrderReviews();
    const admin = await staffUser('dbrace-adm@example.jp', 'admin');

    const first = await decideOrderReview({
      id: review!.id,
      decision: 'release',
      actorId: admin.id,
      reason: 'first',
    });
    const second = await decideOrderReview({
      id: review!.id,
      decision: 'refuse',
      actorId: admin.id,
      reason: 'second',
    });
    expect(first).toBe(true);
    expect(second).toBe(false);

    // And the row still records the first decision, not the second.
    const rows = await query<{ decision: string; decision_reason: string }>(
      `SELECT decision, decision_reason FROM order_reviews WHERE id = ?`,
      [review!.id],
    );
    expect(rows[0]!.decision).toBe('release');
    expect(rows[0]!.decision_reason).toBe('first');
  });

  it('cannot be decided twice', async () => {
    const user = await h.createUser({ email: 'twice-user@example.jp' });
    await paidByCard(user, 'twice-0001');
    const admin = await staffUser('twice-adm@example.jp', 'admin');
    const reviewId = (await queue(admin)).json().items[0].reviewId as string;

    expect((await decide(admin, reviewId, { decision: 'release', reason: 'first decision' })).statusCode).toBe(200);
    const again = await decide(admin, reviewId, { decision: 'refuse', reason: 'changed my mind' });
    expect(again.statusCode).toBe(409);
  });

  it('needs a reason, and needs to be an admin', async () => {
    const user = await h.createUser({ email: 'auth-user@example.jp' });
    await paidByCard(user, 'authz-0001');
    const admin = await staffUser('auth-adm@example.jp', 'admin');
    const support = await staffUser('auth-sup@example.jp', 'support');
    const reviewId = (await queue(admin)).json().items[0].reviewId as string;

    expect((await decide(admin, reviewId, { decision: 'release', reason: '' })).statusCode).toBe(400);
    // Support can see the queue and cannot decide.
    expect((await queue(support)).statusCode).toBe(200);
    expect((await decide(support, reviewId, { decision: 'release', reason: 'support tried' })).statusCode).toBe(403);
  });
});

describe('an order nothing is wrong with', () => {
  it('is delivered immediately, as before', async () => {
    /*
     * The cost of this feature is measured here. A hold on a legitimate
     * purchase is a customer who paid and received nothing, and at this scale
     * that is the worse failure — so an account that is not new, has no
     * disputes and is not racing must notice no difference at all.
     */
    const user = await h.createUser({ email: 'clean-buy@example.jp' });
    await query(`UPDATE users SET created_at = UTC_TIMESTAMP(3) - INTERVAL 30 DAY WHERE id = ?`, [user.id]);
    const orderId = await paidByCard(user, 'clean-0001');

    expect((await balanceOf(user.id)).available).toBe(5);
    const orders = await query<{ granted: Date | null }>(
      `SELECT entitlement_granted_at AS granted FROM orders WHERE id = ?`,
      [orderId],
    );
    expect(orders[0]!.granted).not.toBeNull();
    const reviews = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM order_reviews`);
    expect(Number(reviews[0]!.n)).toBe(0);
  });

  it('is delivered immediately when the whole feature is switched off', async () => {
    const off = await createHarness({ CARD_REVIEW_ENABLED: 'false' });
    try {
      const user = await off.createUser({ email: 'off-buy@example.jp' });
      const res = await off.app.inject({
        method: 'POST',
        url: '/v1/checkout',
        headers: { ...user.authHeader, ...freshIp() },
        payload: { priceKey: 'drop_5', idempotencyKey: 'off-0001' } as never,
      });
      const { checkoutUrl } = res.json() as { checkoutUrl: string };
      await off.app.inject({
        method: 'POST',
        url: '/v1/dev/simulate-payment',
        headers: { ...user.authHeader, ...freshIp() },
        payload: { sessionId: sessionIdOf(checkoutUrl), outcome: 'paid' } as never,
      });
      const { claimWebhookEvents } = await import('@yuha/db');
      const { processWebhookEvent } = await import('../apps/api/src/services/webhooks.js');
      const events = await withTx(async (tx) => claimWebhookEvents(20, tx));
      for (const ev of events) await processWebhookEvent(off.ctx, ev);
      expect((await balanceOf(user.id)).available).toBe(5);
    } finally {
      await off.app.close();
    }
  });
});

describe('a stablecoin order', () => {
  it('is never held, because an on-chain payment has no chargeback', async () => {
    /*
     * The signals here are all about card fraud. Holding delivery on a
     * payment that cannot be reversed buys nothing and costs a customer their
     * song.
     */
    const { reviewPaidCardOrder } = await import('../apps/api/src/services/order-review.js');
    const { getOrder, getUser, insertOrder, markOrderPaid } = await import('@yuha/db');
    const user = await h.createUser({ email: 'sc-nohold@example.jp' });

    const reasons = await withTx(async (tx) => {
      const order = await insertOrder(
        {
          userId: user.id,
          priceKey: 'drop_5',
          priceVersion: 2,
          kind: 'one_time',
          amountMinor: 980,
          currency: 'jpy',
          idempotencyKey: 'sc-nohold-0001',
          metadata: {},
          paymentMethod: 'stablecoin',
        },
        tx,
      );
      await markOrderPaid({ orderId: order.id, paymentIntentId: null, receiptUrl: null, customerId: null }, tx);
      const paid = (await getOrder(order.id, tx))!;
      return reviewPaidCardOrder(h.ctx, { order: paid, user: (await getUser(user.id, tx))! }, tx);
    });

    expect(reasons).toEqual([]);
    const reviews = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM order_reviews`);
    expect(Number(reviews[0]!.n)).toBe(0);
  });
});
