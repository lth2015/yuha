/**
 * Refunding a subscription period takes the credits back with the money.
 *
 * It did not. Two independent reasons, either one enough on its own:
 *
 *   - `handleRefund` found the order by `stripe_payment_intent_id`, which a
 *     `mode: 'subscription'` checkout never has; and
 *   - it then filtered batches to `source = 'one_time_order'`, so a
 *     `subscription_period` batch was revoked by nothing, anywhere.
 *
 * Pay ¥1,980, generate nothing, refund on day two: money back, credits kept.
 *
 * And a third that the open item did not name — a renewal has no order at all.
 * Orders are created by the checkout that opens a subscription; month two
 * arrives as an invoice and nothing else, so a revocation keyed on an order
 * could not reach it even once the first two were fixed. The link that does
 * survive is the invoice: the batch's business key is `<sub>:<invoice>`, and
 * the payment row for that period now records which invoice it paid.
 *
 * The proportional maths is the one-time rule, unchanged and for the same
 * reason: a partial refund takes back a floored share, so rounding leaves the
 * subscriber holding slightly more than the surviving payment strictly buys
 * rather than taking songs they still paid for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processWebhookEvent, reconcilePendingCheckouts } from '@yuha/api';
import {
  claimWebhookEvents,
  getActiveProduct,
  query,
  recordWebhookEvent,
  withTx,
} from '@yuha/db';
import { SimulatedPaymentsAdapter } from '@yuha/providers';
import { balanceOf, createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let sim: SimulatedPaymentsAdapter;
let planUnits: number;
const PERIOD_MINOR = 198_000;

beforeAll(async () => {
  h = await createHarness({ FEATURE_SUBSCRIPTIONS_ENABLED: 'true' });
  sim = h.ctx.payments as SimulatedPaymentsAdapter;
  planUnits = (await getActiveProduct('pro_monthly'))!.units;
});
beforeEach(async () => { await resetData(); });
afterAll(async () => { await h?.close(); await teardown(); });

const drain = async () => {
  const events = await withTx(async (tx) => claimWebhookEvents(20, tx));
  for (const ev of events) await processWebhookEvent(h.ctx, ev);
  return events.length;
};

async function subscribe(user: TestUser) {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/checkout', headers: user.authHeader,
    payload: { priceKey: 'pro_monthly', idempotencyKey: `idem_${Math.random().toString(36).slice(2)}` } as never,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { orderId: string; checkoutUrl: string };
  const sessionId = new URL(body.checkoutUrl).searchParams.get('session_id')!;
  const session = sim.settle(sessionId, 'paid')!;
  await reconcilePendingCheckouts(h.ctx, 0);
  return { orderId: body.orderId, subscriptionId: session.subscriptionId! };
}

/** One paid period, delivered the way Stripe delivers it. */
async function invoicePaid(user: TestUser, subscriptionId: string, tag: string) {
  const invoiceId = `in_${tag}`;
  await recordWebhookEvent({
    provider: 'stripe', eventId: `evt_inv_${tag}`, eventType: 'invoice.paid',
    signatureVerified: true,
    payload: {
      id: `evt_inv_${tag}`, type: 'invoice.paid', created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: invoiceId, object: 'invoice', status: 'paid', paid: true,
        amount_paid: PERIOD_MINOR,
        charge: `ch_${tag}`,
        parent: { type: 'subscription_details', subscription_details: {
          subscription: subscriptionId,
          metadata: { user_id: user.id, price_key: 'pro_monthly' },
        } },
      } },
    },
  });
  expect(await drain()).toBe(1);
  return { invoiceId, chargeId: `ch_${tag}` };
}

/** `charge.refunded`: the cumulative total sits on the charge. */
async function refundCharge(chargeId: string, invoiceId: string, cumulativeMinor: number, tag: string) {
  await recordWebhookEvent({
    provider: 'stripe', eventId: `evt_ref_${tag}`, eventType: 'charge.refunded',
    signatureVerified: true,
    payload: {
      id: `evt_ref_${tag}`, type: 'charge.refunded', created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: chargeId, object: 'charge', invoice: invoiceId,
        amount: PERIOD_MINOR, amount_refunded: cumulativeMinor,
      } },
    },
  });
  await drain();
}

/** `refund.created`: one refund's amount, and no invoice on the object. */
async function refundCreated(chargeId: string, amountMinor: number, tag: string) {
  await recordWebhookEvent({
    provider: 'stripe', eventId: `evt_rc_${tag}`, eventType: 'refund.created',
    signatureVerified: true,
    payload: {
      id: `evt_rc_${tag}`, type: 'refund.created', created: Math.floor(Date.now() / 1000),
      data: { object: { id: `re_${tag}`, object: 'refund', charge: chargeId, amount: amountMinor } },
    },
  });
  await drain();
}

describe('refunding a subscription period', () => {
  it('takes every unused credit back when the whole period is refunded', async () => {
    const user = await h.createUser();
    const { subscriptionId } = await subscribe(user);
    const { invoiceId, chargeId } = await invoicePaid(user, subscriptionId, 'full');
    expect((await balanceOf(user.id)).available).toBe(planUnits);

    await refundCharge(chargeId, invoiceId, PERIOD_MINOR, 'full');
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('takes a floored share when only part of the period is refunded', async () => {
    const user = await h.createUser();
    const { subscriptionId } = await subscribe(user);
    const { invoiceId, chargeId } = await invoicePaid(user, subscriptionId, 'part');

    // Half the money back, so half the credits — rounded in the subscriber's
    // favour, the same rule the one-time packs use.
    await refundCharge(chargeId, invoiceId, PERIOD_MINOR / 2, 'part');
    const kept = (await balanceOf(user.id)).available;
    expect(kept).toBe(planUnits - Math.floor((planUnits * (PERIOD_MINOR / 2)) / PERIOD_MINOR));
    expect(kept).toBeGreaterThan(0);
  });

  it('reaches a renewal, which has no order at all', async () => {
    // Orders are created by the checkout that opens a subscription. Month two
    // is an invoice and nothing else, so anything keyed on an order could not
    // touch it even once the other two faults were fixed.
    const user = await h.createUser();
    const { subscriptionId } = await subscribe(user);
    await invoicePaid(user, subscriptionId, 'm1');
    const second = await invoicePaid(user, subscriptionId, 'm2');
    expect((await balanceOf(user.id)).available).toBe(planUnits * 2);

    await refundCharge(second.chargeId, second.invoiceId, PERIOD_MINOR, 'm2');
    // Only the refunded month goes; the month that was paid for stays.
    expect((await balanceOf(user.id)).available).toBe(planUnits);
  });

  it('works from a refund.created, which does not carry the invoice', async () => {
    // The Refund object has a charge and no invoice, so the link has to come
    // from the payment row written when the period was granted.
    const user = await h.createUser();
    const { subscriptionId } = await subscribe(user);
    const { chargeId } = await invoicePaid(user, subscriptionId, 'rc');

    await refundCreated(chargeId, PERIOD_MINOR, 'rc');
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('never takes a credit that was already spent', async () => {
    const user = await h.createUser();
    const { subscriptionId } = await subscribe(user);
    const { invoiceId, chargeId } = await invoicePaid(user, subscriptionId, 'spent');

    // Spend one, then refund everything. The spent song was delivered; only
    // what is left can be taken.
    await withTx(async (tx) => {
      const b = await query<{ id: string }>(
        `SELECT id FROM entitlement_batches WHERE user_id = ? AND source = 'subscription_period'`,
        [user.id], tx,
      );
      await query(`UPDATE entitlement_batches SET consumed_units = 1 WHERE id = ?`, [b[0]!.id], tx);
    });

    await refundCharge(chargeId, invoiceId, PERIOD_MINOR, 'spent');
    const rows = await query<{ granted_units: number; consumed_units: number }>(
      `SELECT granted_units, consumed_units FROM entitlement_batches
        WHERE user_id = ? AND source = 'subscription_period'`,
      [user.id],
    );
    expect(rows[0]!.consumed_units).toBe(1);
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('is idempotent: the same refund delivered twice revokes once', async () => {
    const user = await h.createUser();
    const { subscriptionId } = await subscribe(user);
    const { invoiceId, chargeId } = await invoicePaid(user, subscriptionId, 'dup');

    await refundCharge(chargeId, invoiceId, PERIOD_MINOR / 2, 'dup');
    const afterFirst = (await balanceOf(user.id)).available;
    await refundCharge(chargeId, invoiceId, PERIOD_MINOR / 2, 'dup2');
    expect((await balanceOf(user.id)).available).toBe(afterFirst);
  });
});
