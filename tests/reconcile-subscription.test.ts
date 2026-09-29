/**
 * The subscriber nobody could repair.
 *
 * `a0d355d` fixed the invoice we misread. This is the invoice that never
 * arrives — the same outage `reconcile-pending.test.ts` reproduces by stopping
 * `stripe listen`, one event further along.
 *
 * For a subscription the money and the goods are settled by two different
 * events. `checkout.session.completed` marks the order paid and deliberately
 * grants nothing (PAY-06 — granting in both places would double it); the
 * credits arrive with `invoice.paid`. Lose the second and the subscriber has
 * paid ¥1,980 for nothing, and:
 *
 *   - `recoverUngrantedOrders` reaches the order and then skips it outright:
 *     `if (!product || product.kind !== 'one_time') continue`.
 *   - `reconcilePendingCheckouts` replays the checkout, which for a
 *     subscription grants nothing by design, so it "settles" an order whose
 *     customer still has zero credits.
 *   - `subscription_period` batches are created in exactly one place in the
 *     repository, inside `handleInvoicePaid`. No event, no batch, ever.
 *
 * So unlike the one-time case there was no repair at all, and the order sits in
 * `listUngrantedPaidOrders` forever — which backs an alarm that fires above
 * zero, so it also goes permanently red with no way back to green.
 *
 * The sweep under test does not re-implement the grant. It reads the
 * subscription from the provider and grants under the SAME business key the
 * webhook would have used, `<subscriptionId>:<latestInvoiceId>`, so a delivery
 * that turns up late finds the batch already there and changes nothing. That
 * key is why this is a recovery and not a second source of truth.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processWebhookEvent, reconcilePendingCheckouts, reconcileUngrantedSubscriptions } from '@yuha/api';
import { claimWebhookEvents, getActiveProduct, getOrder, query, recordWebhookEvent, withTx } from '@yuha/db';
import { SimulatedPaymentsAdapter } from '@yuha/providers';
import { createHarness, resetData, teardown, balanceOf, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let sim: SimulatedPaymentsAdapter;
/*
 * Read from the catalogue, not written here: the harness seeds `pro_monthly`
 * with its own numbers (100 songs) which are not the shipped ones (15). A
 * literal would pin the fixture; the claim under test is that the sweep grants
 * the product's size, whatever that is.
 */
let planUnits: number;

beforeAll(async () => {
  h = await createHarness({ FEATURE_SUBSCRIPTIONS_ENABLED: 'true' });
  sim = h.ctx.payments as SimulatedPaymentsAdapter;
  planUnits = (await getActiveProduct('pro_monthly'))!.units;
  expect(planUnits).toBeGreaterThan(0);
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

/**
 * Subscribes and settles the session **on the adapter**, so the provider
 * believes it is paid and not one event reaches our pipeline — which is the
 * whole scenario. Then runs the checkout sweep, because the outage that loses
 * `invoice.paid` loses `checkout.session.completed` too, and that sweep is what
 * brings the order to `paid` in the real recovery. It grants nothing.
 */
async function subscribeWithoutTellingUs(user: TestUser) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/checkout',
    headers: user.authHeader,
    payload: { priceKey: 'pro_monthly', idempotencyKey: `idem_${Math.random().toString(36).slice(2)}` } as never,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { orderId: string; checkoutUrl: string };
  const sessionId = new URL(body.checkoutUrl).searchParams.get('session_id')!;
  const session = sim.settle(sessionId, 'paid')!;
  await reconcilePendingCheckouts(h.ctx, 0);
  return { orderId: body.orderId, sessionId, subscriptionId: session.subscriptionId! };
}

async function drainWebhooks(): Promise<number> {
  const events = await withTx(async (tx) => claimWebhookEvents(20, tx));
  for (const ev of events) await processWebhookEvent(h.ctx, ev);
  return events.length;
}

const batchesOf = (userId: string) =>
  query<{ source: string; source_ref: string; granted_units: number }>(
    `SELECT source, source_ref, granted_units FROM entitlement_batches WHERE user_id = ? ORDER BY created_at`,
    [userId],
  );

describe('reconciling subscriptions whose invoice never arrived', () => {
  it('leaves the subscriber with nothing until the sweep runs', async () => {
    const user = await h.createUser();
    const { orderId } = await subscribeWithoutTellingUs(user);

    // This is the state a real subscriber was in: charged, order settled, and
    // not one credit. Asserted before the repair so the test would still fail
    // if the repair were quietly moved into the checkout path, where PAY-06
    // says it must not live.
    const order = await getOrder(orderId);
    expect(order?.status).toBe('paid');
    expect(order?.entitlement_granted_at).toBeNull();
    expect((await balanceOf(user.id)).available).toBe(0);
    expect(await batchesOf(user.id)).toHaveLength(0);
  });

  it('grants the period, and records the order as fulfilled', async () => {
    const user = await h.createUser();
    const { orderId, subscriptionId } = await subscribeWithoutTellingUs(user);

    expect(await reconcileUngrantedSubscriptions(h.ctx)).toBe(1);

    expect((await balanceOf(user.id)).available).toBe(planUnits);
    const batches = await batchesOf(user.id);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.source).toBe('subscription_period');
    // The key the webhook would have used, not one invented by the sweep.
    expect(batches[0]!.source_ref).toMatch(new RegExp(`^${subscriptionId}:in_sim_`));

    const order = await getOrder(orderId);
    expect(order?.entitlement_granted_at).not.toBeNull();
  });

  it('writes the subscription row, so the duplicate-subscription guard still works', async () => {
    // `customer.subscription.created` was lost in the same outage. Without a
    // row, `getActiveSubscription` finds nothing and the subscriber can buy a
    // second subscription — SUBSCRIPTION_ALREADY_ACTIVE never fires.
    const user = await h.createUser();
    await subscribeWithoutTellingUs(user);
    await reconcileUngrantedSubscriptions(h.ctx);

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: user.authHeader,
      payload: { priceKey: 'premier_monthly', idempotencyKey: `idem_${Math.random().toString(36).slice(2)}` } as never,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
  });

  it('grants once when the lost invoice is delivered afterwards', async () => {
    const user = await h.createUser();
    const { subscriptionId } = await subscribeWithoutTellingUs(user);
    await reconcileUngrantedSubscriptions(h.ctx);

    // The same invoice, arriving by the route it should have taken all along,
    // in the shape 2026-08-26.dahlia actually sends.
    const invoiceId = (await h.ctx.payments.retrieveSubscription(subscriptionId))!.latestInvoiceId!;
    await recordWebhookEvent({
      provider: 'stripe',
      eventId: `evt_late_${invoiceId}`,
      eventType: 'invoice.paid',
      signatureVerified: true,
      payload: {
        id: `evt_late_${invoiceId}`,
        type: 'invoice.paid',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: invoiceId,
            object: 'invoice',
            status: 'paid',
            paid: true,
            parent: {
              type: 'subscription_details',
              subscription_details: {
                subscription: subscriptionId,
                metadata: { user_id: user.id, price_key: 'pro_monthly' },
              },
            },
          },
        },
      },
    });
    expect(await drainWebhooks()).toBe(1);

    expect((await balanceOf(user.id)).available).toBe(planUnits);
    expect(await batchesOf(user.id)).toHaveLength(1);
  });

  it('runs a second time without granting a second period', async () => {
    const user = await h.createUser();
    await subscribeWithoutTellingUs(user);

    expect(await reconcileUngrantedSubscriptions(h.ctx)).toBe(1);
    // Nothing is ungranted any more, so there is nothing to repair. A sweep
    // that counted the same order every minute would also grant every minute.
    expect(await reconcileUngrantedSubscriptions(h.ctx)).toBe(0);
    expect((await balanceOf(user.id)).available).toBe(planUnits);
  });

  it('leaves a one-time order to the sweep that owns it', async () => {
    const user = await h.createUser();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: user.authHeader,
      payload: { priceKey: 'drop_5', idempotencyKey: `idem_${Math.random().toString(36).slice(2)}` } as never,
    });
    const body = res.json() as { checkoutUrl: string };
    sim.settle(new URL(body.checkoutUrl).searchParams.get('session_id')!, 'paid');
    await reconcilePendingCheckouts(h.ctx, 0);

    // `reconcilePendingCheckouts` already granted this one. The subscription
    // sweep must not treat it as its own work and must not touch the balance.
    const before = (await balanceOf(user.id)).available;
    expect(await reconcileUngrantedSubscriptions(h.ctx)).toBe(0);
    expect((await balanceOf(user.id)).available).toBe(before);
  });
});
