/**
 * Payments, entitlements and refunds: PAY-01 … PAY-11.
 *
 * The simulated payments adapter moves no money, but every event it produces is
 * signed and travels through the SAME verify → persist → process pipeline that
 * Stripe events use. What these tests exercise is therefore the real order,
 * webhook and entitlement logic, not a shortcut around it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processWebhookEvent } from '@yuha/api';
import {
  claimWebhookEvents,
  findSubscriptionByStripeId,
  getActiveProduct,
  getBalance,
  getOrder,
  grantUnits,
  query,
  recordWebhookEvent,
  upsertProduct,
  upsertSubscription,
  withTx,
} from '@yuha/db';
import { SimulatedPaymentsAdapter } from '@yuha/providers';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let sim: SimulatedPaymentsAdapter;

beforeAll(async () => {
  h = await createHarness({ FEATURE_SUBSCRIPTIONS_ENABLED: 'true' });
  sim = h.ctx.payments as SimulatedPaymentsAdapter;
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

/** Runs the worker's webhook loop body once. */
async function drainWebhooks(): Promise<number> {
  const events = await withTx(async (tx) => claimWebhookEvents(20, tx));
  for (const ev of events) await processWebhookEvent(h.ctx, ev);
  return events.length;
}

async function checkout(user: TestUser, priceKey: string, idempotencyKey: string) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/checkout',
    headers: user.authHeader,
    payload: { priceKey, idempotencyKey } as never,
  });
}

async function settle(sessionId: string, outcome: 'paid' | 'failed', user: TestUser) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/dev/simulate-payment',
    headers: user.authHeader,
    payload: { sessionId, outcome } as never,
  });
}

/** Extracts the simulated session id from the returned checkout URL. */
function sessionIdOf(checkoutUrl: string): string {
  return new URL(checkoutUrl).searchParams.get('session_id')!;
}

describe('checkout', () => {
  it('PAY-01: the amount comes from the server catalogue, not the client', async () => {
    const user = await h.createUser();
    // The request body has no amount field at all — there is nothing to tamper with.
    const res = await checkout(user, 'drop_5', 'checkout-key-1');
    expect(res.statusCode).toBe(200);

    const order = await getOrder(res.json().orderId);
    expect(order!.amount_minor).toBe(499);
    expect(order!.currency).toBe('usd');
    expect(order!.price_version).toBe(2);
    expect(order!.status).toBe('pending');
  });

  /*
   * A catalogue version is the frozen commercial terms an order was placed
   * against, and `upsertProduct` deliberately leaves `amount_minor`,
   * `currency`, `units` and `validity_days` out of its UPDATE list. But it
   * *does* update `stripe_price_id`, and Stripe Prices are immutable — so
   * raising a price means pointing at a new Price object, and re-running the
   * seed with the same version number left the catalogue saying 980 beside a
   * Stripe Price of 1280.
   *
   * Every checkout for that key then charged the new amount and
   * `handleCheckoutCompleted` threw on the amount-mismatch guard *before* its
   * transaction, so `markOrderPaid` never ran: money taken, order left
   * `pending`, nothing granted, for every buyer. Refusing here is what stops
   * the catalogue being able to disagree with the provider at all.
   */
  it('refuses to redefine the commercial terms of an existing version', async () => {
    const current = (await getActiveProduct('drop_5'))!;
    await expect(
      upsertProduct({
        ...current,
        amount_minor: current.amount_minor + 300,
        stripe_price_id: 'price_test_drop5_raised',
      }),
    ).rejects.toThrow(/different commercial terms/);

    // And the catalogue is untouched, so a checkout still agrees with Stripe.
    const after = (await getActiveProduct('drop_5'))!;
    expect(after.amount_minor).toBe(current.amount_minor);
    expect(after.stripe_price_id).toBe(current.stripe_price_id);
  });

  it('still accepts an unchanged re-seed, so running the seed twice is safe', async () => {
    const current = (await getActiveProduct('drop_5'))!;
    await expect(upsertProduct({ ...current, display_name: 'Starter Pack — renamed' })).resolves
      .toBeUndefined();
    expect((await getActiveProduct('drop_5'))!.amount_minor).toBe(current.amount_minor);
  });

  it('an unknown price key is rejected', async () => {
    const user = await h.createUser();
    const res = await checkout(user, 'unlimited_forever', 'checkout-key-2');
    expect(res.statusCode).toBe(400);
  });

  it('a repeated checkout with the same key does not create a second order', async () => {
    const user = await h.createUser();
    const a = await checkout(user, 'drop_5', 'checkout-key-3');
    const b = await checkout(user, 'drop_5', 'checkout-key-3');

    expect(b.json().orderId).toBe(a.json().orderId);
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE user_id = ?`, [user.id]);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  /*
   * `orders_idempotency_uk` is (user_id, key) and nothing checked that the
   * order being replayed is for the thing being bought. A key first used for
   * a DROP pack and reused on another purchase resumed that same row: the
   * Stripe session was built for the new product while `orders.price_key`
   * still named the old one, and `handleCheckoutCompleted` decides what to
   * hand over from the order. Money taken for one thing, the other delivered.
   *
   * The amount-mismatch guard cannot catch the pairing that matters: in the
   * shipped catalogue `drop_5` and `market_license` are both 980 jpy.
   */
  it('refuses an idempotency key that already belongs to a different product', async () => {
    const user = await h.createUser();
    const first = await checkout(user, 'drop_5', 'crossed-key-1');
    expect(first.statusCode).toBe(200);

    const second = await checkout(user, 'premier_monthly', 'crossed-key-1');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // And nothing was written for the refused purchase.
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE user_id = ?`, [user.id]);
    expect(Number(rows[0]!.n)).toBe(1);
    expect((await getOrder(first.json().orderId))!.price_key).toBe('drop_5');
  });

  it('PAY-12: card details never reach us — checkout is a hosted redirect', async () => {
    const user = await h.createUser();
    const res = await checkout(user, 'drop_5', 'checkout-key-4');
    // The response carries a URL to redirect to, and nothing resembling a card field.
    expect(res.json().checkoutUrl).toMatch(/^https?:\/\//);
    expect(JSON.stringify(res.json())).not.toMatch(/card|pan|cvc|number/i);
  });

  it('an unconfirmed age blocks purchase', async () => {
    const user = await h.createUser();
    await query(`UPDATE users SET age_confirmed_at = NULL WHERE id = ?`, [user.id]);
    const res = await checkout(user, 'drop_5', 'checkout-key-5');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AGE_NOT_CONFIRMED');
  });
});

describe('one-time purchase', () => {
  it('PAY-02: landing on the success page grants nothing until the payment is verified', async () => {
    const user = await h.createUser();
    const { orderId } = (await checkout(user, 'drop_5', 'pay-key-1')).json();

    // The browser "returns" — we only read server state.
    const view = await h.app.inject({ method: 'GET', url: `/v1/orders/${orderId}`, headers: user.authHeader });
    expect(view.json().status).toBe('pending');
    expect(view.json().entitlementGranted).toBe(false);
    expect((await getBalance(user.id)).available).toBe(0);
  });

  it('PAY-03: a verified payment grants exactly one 5-unit batch', async () => {
    const user = await h.createUser();
    const { orderId, checkoutUrl } = (await checkout(user, 'drop_5', 'pay-key-2')).json();

    await settle(sessionIdOf(checkoutUrl), 'paid', user);
    await drainWebhooks();

    const order = await getOrder(orderId);
    expect(order!.status).toBe('paid');
    expect(order!.entitlement_granted_at).not.toBeNull();

    const batches = await query<{ granted_units: number; source: string; expires_at: Date }>(
      `SELECT granted_units, source, expires_at FROM entitlement_batches WHERE user_id = ?`,
      [user.id],
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]!.granted_units).toBe(5);
    expect(batches[0]!.source).toBe('one_time_order');
    // 90-day validity from the catalogue.
    expect(batches[0]!.expires_at).not.toBeNull();
    expect((await getBalance(user.id)).available).toBe(5);
  });

  it('PAY-05: the same event delivered twice grants once', async () => {
    const user = await h.createUser();
    const { checkoutUrl } = (await checkout(user, 'drop_5', 'pay-key-3')).json();
    const sessionId = sessionIdOf(checkoutUrl);

    await settle(sessionId, 'paid', user);
    await drainWebhooks();
    // Redelivery of the identical event.
    await settle(sessionId, 'paid', user);
    await drainWebhooks();

    expect((await getBalance(user.id)).available).toBe(5);
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM entitlement_batches WHERE user_id = ?`,
      [user.id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('PAY-05: two different events describing the same payment still grant once', async () => {
    const user = await h.createUser();
    const { orderId, checkoutUrl } = (await checkout(user, 'drop_5', 'pay-key-4')).json();
    const sessionId = sessionIdOf(checkoutUrl);
    sim.settle(sessionId, 'paid');

    // A distinct event id, same underlying session — the second idempotency
    // layer (the business object) has to catch this one.
    for (const eventId of ['evt_first', 'evt_second']) {
      const payload = {
        id: eventId,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: sessionId,
            client_reference_id: orderId,
            payment_status: 'paid',
            amount_total: 499,
            currency: 'usd',
            metadata: { order_id: orderId, user_id: user.id },
          },
        },
      };
      await recordWebhookEvent({
        provider: 'stripe',
        eventId,
        eventType: payload.type,
        signatureVerified: true,
        payload,
      });
    }
    await drainWebhooks();

    expect((await getBalance(user.id)).available).toBe(5);
  });

  it('PAY-04: an invalid signature changes nothing', async () => {
    const user = await h.createUser();
    const { orderId, checkoutUrl } = (await checkout(user, 'drop_5', 'pay-key-5')).json();
    const sessionId = sessionIdOf(checkoutUrl);
    sim.settle(sessionId, 'paid');

    const body = JSON.stringify({
      id: 'evt_forged',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: sessionId, client_reference_id: orderId, payment_status: 'paid' } },
    });

    const forged = await h.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      payload: body,
    });
    expect(forged.statusCode).toBe(400);

    const missing = await h.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(missing.statusCode).toBe(400);

    await drainWebhooks();
    expect((await getBalance(user.id)).available).toBe(0);
    expect((await getOrder(orderId))!.status).toBe('pending');
  });

  it('PAY-04: a stale signature timestamp is refused', async () => {
    const body = Buffer.from(JSON.stringify({ id: 'evt_stale', type: 'checkout.session.completed' }));
    // Signed with the right key but an hour ago — outside the tolerance window.
    const oldTs = Math.floor(Date.now() / 1000) - 3600;
    const { createHmac } = await import('node:crypto');
    const mac = createHmac('sha256', 'test-signing-0123456789abcdef0123456789abcd')
      .update(`${oldTs}.${body.toString('utf8')}`)
      .digest('hex');

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${oldTs},v1=${mac}` },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it('a failed payment grants nothing', async () => {
    const user = await h.createUser();
    const { orderId, checkoutUrl } = (await checkout(user, 'drop_5', 'pay-key-6')).json();

    await settle(sessionIdOf(checkoutUrl), 'failed', user);
    await drainWebhooks();

    expect((await getBalance(user.id)).available).toBe(0);
    expect((await getOrder(orderId))!.status).not.toBe('paid');
  });

  it('PAY-11: an order paid but never granted is recovered by the sweep', async () => {
    const user = await h.createUser();
    const { orderId, checkoutUrl } = (await checkout(user, 'drop_5', 'pay-key-7')).json();
    await settle(sessionIdOf(checkoutUrl), 'paid', user);
    await drainWebhooks();

    // Simulate the crash window: paid, but the grant never landed.
    await query(
      `DELETE FROM ledger_entries WHERE user_id = ?`,
      [user.id],
    );
    await query(`DELETE FROM entitlement_batches WHERE user_id = ?`, [user.id]);
    await query(`UPDATE orders SET entitlement_granted_at = NULL WHERE id = ?`, [orderId]);

    const { recoverUngrantedOrders } = await import('@yuha/api');
    const repaired = await recoverUngrantedOrders(h.ctx);

    expect(repaired).toBe(1);
    expect((await getBalance(user.id)).available).toBe(5);
    expect((await getOrder(orderId))!.entitlement_granted_at).not.toBeNull();
  });
});

describe('subscription', () => {
  const subId = 'sub_test_0001';

  async function seedSubscription(user: TestUser, periodEnd: Date) {
    await withTx(async (tx) =>
      upsertSubscription(
        {
          userId: user.id,
          stripeSubscriptionId: subId,
          stripeCustomerId: 'cus_test_1',
          priceKey: 'pro_monthly',
          priceVersion: 1,
          status: 'active',
          currentPeriodStart: new Date(Date.now() - 86400_000),
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          eventAt: new Date(),
        },
        tx,
      ),
    );
  }

  async function seedSubscriptionAs(user: TestUser, stripeSubscriptionId: string) {
    await withTx(async (tx) =>
      upsertSubscription(
        {
          userId: user.id,
          stripeSubscriptionId,
          stripeCustomerId: 'cus_test_1',
          priceKey: 'pro_monthly',
          priceVersion: 1,
          status: 'active',
          currentPeriodStart: new Date(Date.now() - 86400_000),
          currentPeriodEnd: new Date(Date.now() + 25 * 86400_000),
          cancelAtPeriodEnd: false,
          eventAt: new Date(Date.now() - 86400_000),
        },
        tx,
      ),
    );
  }

  it('a second subscription is refused, and no order is created for it', async () => {
    const user = await h.createUser();
    await seedSubscription(user, new Date(Date.now() + 30 * 86400_000));

    const before = await query<{ n: number }>('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?', [user.id]);
    const res = await checkout(user, 'premier_monthly', 'dup-sub-1');

    // Stripe would happily create a second live subscription and bill twice;
    // nothing downstream merges them. Changing plan goes through billing.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');

    // Refused before anything is written, not compensated afterwards.
    const after = await query<{ n: number }>('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?', [user.id]);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  });

  it('a subscriber can still buy a one-time pack', async () => {
    const user = await h.createUser();
    await seedSubscription(user, new Date(Date.now() + 30 * 86400_000));

    // Buying credits while subscribed is ordinary, and must not be caught by
    // the duplicate-subscription guard.
    const res = await checkout(user, 'drop_5', 'onetime-while-subbed');
    expect(res.statusCode).toBe(200);
  });

  it('PAY-06: an invoice grants exactly one period of 20 units', async () => {
    const user = await h.createUser();
    await seedSubscription(user, new Date(Date.now() + 30 * 86400_000));

    const grant = () =>
      withTx(async (tx) =>
        grantUnits(
          {
            userId: user.id,
            source: 'subscription_period',
            sourceRef: `${subId}:in_0001`,
            units: 20,
            productKey: 'pro_monthly',
            priceVersion: 1,
            expiresAt: new Date(Date.now() + 30 * 86400_000),
            reason: 'invoice',
          },
          tx,
        ),
      );

    const first = await grant();
    // Multiple events describing the same invoice must not stack.
    const second = await grant();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect((await getBalance(user.id)).available).toBe(20);
  });

  it('PAY-06: a genuine renewal (a new invoice) grants the next period', async () => {
    const user = await h.createUser();
    await seedSubscription(user, new Date(Date.now() + 30 * 86400_000));

    for (const invoice of ['in_0001', 'in_0002']) {
      await withTx(async (tx) =>
        grantUnits(
          {
            userId: user.id,
            source: 'subscription_period',
            sourceRef: `${subId}:${invoice}`,
            units: 20,
            expiresAt: new Date(Date.now() + 30 * 86400_000),
            reason: 'invoice',
          },
          tx,
        ),
      );
    }
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM entitlement_batches WHERE user_id = ? AND source = 'subscription_period'`,
      [user.id],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('PAY-05: an out-of-order event does not overwrite newer subscription state', async () => {
    const user = await h.createUser();
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    await withTx(async (tx) =>
      upsertSubscription(
        {
          userId: user.id,
          stripeSubscriptionId: subId,
          stripeCustomerId: 'cus_test_1',
          priceKey: 'pro_monthly',
          priceVersion: 1,
          status: 'canceled',
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: true,
          eventAt: now,
        },
        tx,
      ),
    );

    // A stale "active" event arriving late must be ignored.
    const stale = await withTx(async (tx) =>
      upsertSubscription(
        {
          userId: user.id,
          stripeSubscriptionId: subId,
          stripeCustomerId: 'cus_test_1',
          priceKey: 'pro_monthly',
          priceVersion: 1,
          status: 'active',
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          eventAt: earlier,
        },
        tx,
      ),
    );

    expect(stale.applied).toBe(false);
    const current = await findSubscriptionByStripeId(subId);
    expect(current!.status).toBe('canceled');
    expect(current!.cancel_at_period_end).toBe(true);
  });

  it('PAY-07: a failed renewal grants nothing and keeps existing entitlements', async () => {
    const user = await h.createUser({ credits: 4 });
    await seedSubscription(user, new Date(Date.now() + 5 * 86400_000));

    const before = await getBalance(user.id);
    await withTx(async (tx) =>
      upsertSubscription(
        {
          userId: user.id,
          stripeSubscriptionId: subId,
          stripeCustomerId: 'cus_test_1',
          priceKey: 'pro_monthly',
          priceVersion: 1,
          status: 'past_due',
          currentPeriodStart: new Date(Date.now() - 86400_000),
          currentPeriodEnd: new Date(Date.now() + 5 * 86400_000),
          cancelAtPeriodEnd: false,
          eventAt: new Date(),
        },
        tx,
      ),
    );

    // Still 4 credits: a payment problem does not confiscate what was paid for.
    expect(await getBalance(user.id)).toEqual(before);
  });

  /*
   * PAY-07's own test above never sent the event — it wrote the subscription
   * row by hand — so the handler was unexercised, and it read
   * `invoice['subscription']`, a field that does not exist on API version
   * 2026-08-26.dahlia. The comment above `invoiceSubscription` records that
   * same read having already silently discarded every subscription invoice
   * once. Here it meant every `invoice.payment_failed` returned on its first
   * line: a subscriber whose card had stopped working still read `active`.
   */
  it('PAY-07: a failed renewal is recognised in the shape Stripe actually sends', async () => {
    const user = await h.createUser();
    const res = await checkout(user, 'pro_monthly', 'failed-renewal-1');
    const sessionId = sessionIdOf(res.json().checkoutUrl);
    await settle(sessionId, 'paid', user);
    await drainWebhooks();

    /*
     * The id has to be one the provider can resolve: `handleInvoiceFailed`
     * re-reads the live subscription and returns if it cannot, so a
     * hand-written `sub_test_0001` would make this pass for the wrong reason.
     * The simulator mints one per subscription session.
     */
    const simSubId = (await sim.retrieveCheckoutSession(sessionId))!.subscriptionId!;
    expect(simSubId).toMatch(/^sub_/);
    await seedSubscriptionAs(user, simSubId);

    await recordWebhookEvent({
      provider: 'stripe',
      eventId: 'evt_renewal_failed_1',
      eventType: 'invoice.payment_failed',
      signatureVerified: true,
      payload: {
        id: 'evt_renewal_failed_1',
        type: 'invoice.payment_failed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: 'in_failed_1',
            object: 'invoice',
            status: 'open',
            paid: false,
            // No top-level `subscription`: this is the whole point.
            parent: {
              type: 'subscription_details',
              subscription_details: {
                subscription: simSubId,
                metadata: { user_id: user.id, price_key: 'pro_monthly' },
              },
            },
          },
        },
      },
    });
    expect(await drainWebhooks()).toBe(1);

    const events = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM analytics_events WHERE name = 'subscription_payment_failed'`,
    );
    expect(Number(events[0]!.n), 'the failed renewal was never recognised').toBe(1);
  });

  it('PAY-08: cancelling sets period-end cancellation and is idempotent', async () => {
    const user = await h.createUser();
    await seedSubscription(user, new Date(Date.now() + 10 * 86400_000));
    const sub = await findSubscriptionByStripeId(subId);

    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/subscription/cancel',
      headers: user.authHeader,
      payload: { subscriptionId: sub!.id, idempotencyKey: 'cancel-key-1' } as never,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().cancelAtPeriodEnd).toBe(true);
    // The effective time is a real instant, reported by the server.
    expect(first.json().effectiveAt).toBeTruthy();

    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/subscription/cancel',
      headers: user.authHeader,
      payload: { subscriptionId: sub!.id, idempotencyKey: 'cancel-key-2' } as never,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().cancelAtPeriodEnd).toBe(true);

    expect((await findSubscriptionByStripeId(subId))!.cancel_at_period_end).toBe(true);
  });

  it("SEC-01: a user cannot cancel someone else's subscription", async () => {
    const owner = await h.createUser();
    const attacker = await h.createUser();
    await seedSubscription(owner, new Date(Date.now() + 10 * 86400_000));
    const sub = await findSubscriptionByStripeId(subId);

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/subscription/cancel',
      headers: attacker.authHeader,
      payload: { subscriptionId: sub!.id, idempotencyKey: 'attack-key-1' } as never,
    });
    expect(res.statusCode).toBe(404);
    expect((await findSubscriptionByStripeId(subId))!.cancel_at_period_end).toBe(false);
  });
});

describe('refunds (PAY-09)', () => {
  it('revokes unused units only, leaving delivered and in-flight work alone', async () => {
    const user = await h.createUser();
    const { orderId, checkoutUrl } = (await checkout(user, 'drop_5', 'refund-key-1')).json();
    await settle(sessionIdOf(checkoutUrl), 'paid', user);
    await drainWebhooks();
    expect((await getBalance(user.id)).available).toBe(5);

    // Use two credits: one delivered, one still running.
    const gen = async (key: string) =>
      (
        await h.app.inject({
          method: 'POST',
          url: '/v1/generations',
          headers: { ...user.authHeader, 'idempotency-key': key },
          payload: { scene: 'night_walk', prompt: '夜', energy: 0.4 } as never,
        })
      ).json();

    const delivered = await gen('refund-gen-001');
    const { runJobStep } = await import('@yuha/worker/pipeline');
    for (let i = 0; i < 4; i += 1) {
      await runJobStep({ ctx: h.ctx, owner: 'refund-test', log: () => undefined }, delivered.jobId);
    }
    await gen('refund-gen-002'); // left reserved

    const order = await getOrder(orderId);
    const refundEvent = {
      id: 'evt_refund_1',
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 're_test_1',
          charge: 'ch_test_1',
          payment_intent: order!.stripe_payment_intent_id,
          amount_refunded: 499,
          metadata: { order_id: orderId },
        },
      },
    };
    await recordWebhookEvent({
      provider: 'stripe',
      eventId: refundEvent.id,
      eventType: refundEvent.type,
      signatureVerified: true,
      payload: refundEvent,
    });
    await drainWebhooks();

    const balance = await getBalance(user.id);
    // 5 granted − 1 consumed − 1 reserved = 3 revoked; nothing goes negative.
    expect(balance.available).toBe(0);
    expect(balance.consumed).toBe(1);
    expect(balance.reserved).toBe(1);

    const refunded = await query<{ status: string; refunded_amount_minor: number }>(
      `SELECT status, refunded_amount_minor FROM orders WHERE id = ?`,
      [orderId],
    );
    expect(refunded[0]!.status).toBe('refunded');
  });

  it('a repeated refund event is idempotent', async () => {
    const user = await h.createUser();
    const { orderId, checkoutUrl } = (await checkout(user, 'drop_5', 'refund-key-2')).json();
    await settle(sessionIdOf(checkoutUrl), 'paid', user);
    await drainWebhooks();

    const order = await getOrder(orderId);
    const build = (eventId: string) => ({
      id: eventId,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 're_test_2',
          charge: 'ch_test_2',
          payment_intent: order!.stripe_payment_intent_id,
          amount_refunded: 499,
          metadata: { order_id: orderId },
        },
      },
    });

    for (const id of ['evt_refund_a', 'evt_refund_b']) {
      const ev = build(id);
      await recordWebhookEvent({
        provider: 'stripe',
        eventId: id,
        eventType: ev.type,
        signatureVerified: true,
        payload: ev,
      });
    }
    await drainWebhooks();

    // The refund object id is the same, so only one refund row exists and the
    // revocation ran once.
    const payments = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM payments WHERE kind = 'refund'`,
    );
    expect(Number(payments[0]!.n)).toBe(1);
    expect((await getBalance(user.id)).available).toBe(0);
  });
});

describe('PAY-10: entitlement history survives cancellation', () => {
  it('a track generated under an active subscription is still readable afterwards', async () => {
    const user = await h.createUser({ credits: 1 });
    const gen = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/generations',
        headers: { ...user.authHeader, 'idempotency-key': 'history-key-01' },
        payload: { scene: 'daily_log', prompt: '日常', energy: 0.5 } as never,
      })
    ).json();

    const { runJobStep } = await import('@yuha/worker/pipeline');
    for (let i = 0; i < 4; i += 1) {
      await runJobStep({ ctx: h.ctx, owner: 'history', log: () => undefined }, gen.jobId);
    }

    // Everything expires / is cancelled.
    await query(
      `UPDATE entitlement_batches SET status = 'revoked', granted_units = consumed_units WHERE user_id = ?`,
      [user.id],
    );

    const library = await h.app.inject({ method: 'GET', url: '/v1/tracks', headers: user.authHeader });
    expect(library.json().items).toHaveLength(1);

    const track = library.json().items[0];
    const licence = await h.app.inject({
      method: 'GET',
      url: `/v1/tracks/${track.trackId}/license`,
      headers: user.authHeader,
    });
    // The licence record from generation time is still served unchanged.
    expect(licence.statusCode).toBe(200);
    expect(licence.json().status).toBe('active');
  });
});
