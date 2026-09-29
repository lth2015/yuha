/**
 * The payment we were never told about.
 *
 * Found by running B5 against the sandbox: `stripe listen` stopped, a real
 * ¥980 DROP paid with 4242. Stripe reported the session `complete` / `paid`.
 * Our side reported the order `pending`, no credits, `webhook_events`
 * unchanged — and, worst of all, healthy:
 *
 *   SELECT COUNT(*) FROM orders WHERE status='paid' AND entitlement_granted_at IS NULL;  -- 0
 *
 * `recoverUngrantedOrders` (PAY-11) only repairs orders we already know were
 * paid, so it had nothing to find, and `UngrantedPaidOrders` — the alarm meant
 * to catch exactly this — reads that same zero. `WebhookBacklog` counts events
 * received and not processed, and no event was ever received. A customer was
 * charged, received nothing, and every signal was green.
 *
 * Stripe retries a failed delivery for about three days, so this needs an
 * outage longer than that, or an endpoint that returns 2xx while dropping the
 * event. Neither is exotic. The money is already gone either way.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcilePendingCheckouts } from '@yuha/api';
import { getOrder } from '@yuha/db';
import { SimulatedPaymentsAdapter } from '@yuha/providers';
import { createHarness, resetData, teardown, balanceOf, type Harness, type TestUser } from './helpers/harness.js';

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

/**
 * Buys, then settles the session **on the adapter directly** rather than
 * through `/v1/dev/simulate-payment`. That endpoint emits a signed event into
 * the webhook pipeline, which is the very thing this scenario is missing: the
 * money moves at the provider and nothing reaches us.
 */
async function payWithoutTellingUs(user: TestUser, priceKey = 'drop_5') {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/checkout',
    headers: user.authHeader,
    payload: { priceKey, idempotencyKey: `idem_${Math.random().toString(36).slice(2)}` } as never,
  });
  const body = res.json() as { orderId: string; checkoutUrl: string };
  const sessionId = new URL(body.checkoutUrl).searchParams.get('session_id')!;
  sim.settle(sessionId, 'paid');
  return body.orderId;
}

describe('reconciling checkouts whose webhook never arrived', () => {
  it('settles a paid order the webhook never told us about', async () => {
    const user: TestUser = await h.createUser();
    const orderId = await payWithoutTellingUs(user);

    // Nothing has reached us: this is the state the sandbox reproduced.
    expect((await getOrder(orderId))?.status).toBe('pending');
    expect((await balanceOf(user.id)).available).toBe(0);

    // A grace window, so the sweep never races a webhook that is merely in
    // flight. Zero here means "reconcile everything", which is what a test
    // wants and an operator does not.
    const settled = await reconcilePendingCheckouts(h.ctx, 0);

    expect(settled).toBe(1);
    const after = await getOrder(orderId);
    expect(after?.status).toBe('paid');
    expect(after?.entitlement_granted_at).not.toBeNull();
    expect((await balanceOf(user.id)).available).toBe(5);
  });

  it('grants once even if the webhook turns up afterwards', async () => {
    const user: TestUser = await h.createUser();
    const orderId = await payWithoutTellingUs(user);

    await reconcilePendingCheckouts(h.ctx, 0);
    // A late delivery, or simply a second sweep. Either way the business key
    // on `entitlement_batches (user, source, source_ref)` has to hold.
    await reconcilePendingCheckouts(h.ctx, 0);
    await reconcilePendingCheckouts(h.ctx, 0);

    expect((await balanceOf(user.id)).available).toBe(5);
    expect((await getOrder(orderId))?.status).toBe('paid');
  });

  it('leaves an order alone while it is still inside the grace window', async () => {
    const user: TestUser = await h.createUser();
    const orderId = await payWithoutTellingUs(user);

    // Paid seconds ago; a webhook may well be on its way.
    const settled = await reconcilePendingCheckouts(h.ctx, 600);

    expect(settled).toBe(0);
    expect((await getOrder(orderId))?.status).toBe('pending');
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('cancels an order whose session expired unpaid, and grants nothing', async () => {
    const user: TestUser = await h.createUser();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: user.authHeader,
      payload: { priceKey: 'drop_5', idempotencyKey: 'idem_expired' } as never,
    });
    const body = res.json() as { orderId: string; checkoutUrl: string };
    sim.settle(new URL(body.checkoutUrl).searchParams.get('session_id')!, 'failed');

    await reconcilePendingCheckouts(h.ctx, 0);

    expect((await getOrder(body.orderId))?.status).toBe('canceled');
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('does not touch an order that is genuinely still open at the provider', async () => {
    const user: TestUser = await h.createUser();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: user.authHeader,
      payload: { priceKey: 'drop_5', idempotencyKey: 'idem_open' } as never,
    });
    const body = res.json() as { orderId: string };

    const settled = await reconcilePendingCheckouts(h.ctx, 0);

    expect(settled).toBe(0);
    expect((await getOrder(body.orderId))?.status).toBe('pending');
  });
});
