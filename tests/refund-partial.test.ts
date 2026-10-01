/**
 * A partial refund must not take back everything.
 *
 * Found against the sandbox: a ¥300 refund on a ¥980 DROP revoked **all five**
 * credits. The buyer was returned 30% of their money and lost 100% of what they
 * bought — ¥680 out of pocket with nothing to show. The order was even written
 * as `partially_refunded`, so the system knew; `revokeUnusedUnits` simply
 * revoked every unused unit in the batch and never looked at the amount.
 *
 * Rounding goes the customer's way. `floor(units × refunded ÷ paid)` can leave
 * them holding slightly more than the surviving payment strictly buys, which is
 * the correct direction for an error whose other side is taking songs from
 * somebody who still paid for them.
 *
 * The cumulative `amount_refunded` on the charge is what drives this, not the
 * amount of a single refund, so two partial refunds settle at the total rather
 * than each computing its own share of the original.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processWebhookEvent } from '@yuha/api';
import { claimWebhookEvents, getOrder, recordWebhookEvent, withTx } from '@yuha/db';
import { SimulatedPaymentsAdapter } from '@yuha/providers';
import { createHarness, resetData, teardown, balanceOf, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let sim: SimulatedPaymentsAdapter;
/** The catalogue's own numbers, so the fixture can change without lying. */
let paid: number;
let units: number;

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

async function drainWebhooks(): Promise<void> {
  const events = await withTx(async (tx) => claimWebhookEvents(20, tx));
  for (const ev of events) await processWebhookEvent(h.ctx, ev);
}

/** Buys a DROP and settles it, the ordinary way, through the real pipeline. */
async function buyAndPay(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/checkout',
    headers: user.authHeader,
    payload: { priceKey: 'drop_5', idempotencyKey: `idem_${Math.random().toString(36).slice(2)}` } as never,
  });
  const body = res.json() as { orderId: string; checkoutUrl: string };
  const sessionId = new URL(body.checkoutUrl).searchParams.get('session_id')!;
  await h.app.inject({
    method: 'POST',
    url: '/v1/dev/simulate-payment',
    headers: user.authHeader,
    payload: { sessionId, outcome: 'paid' } as never,
  });
  await drainWebhooks();

  const order = (await getOrder(body.orderId))!;
  paid = order.amount_minor;
  units = (order.metadata['units'] as number) ?? 5;
  return body.orderId;
}

/** `charge.refunded` carries the running total on the charge, not one refund. */
async function refundTo(orderId: string, cumulativeMinor: number, tag: string): Promise<void> {
  const order = (await getOrder(orderId))!;
  await recordWebhookEvent({
    provider: 'stripe',
    eventId: `evt_refund_${tag}`,
    eventType: 'charge.refunded',
    signatureVerified: true,
    payload: {
      id: `evt_refund_${tag}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_${tag}`,
          object: 'charge',
          payment_intent: order.stripe_payment_intent_id,
          amount: order.amount_minor,
          amount_refunded: cumulativeMinor,
          metadata: { order_id: orderId },
        },
      },
    },
  });
  await drainWebhooks();
}

/**
 * `refund.created` carries ONE refund's amount, not the running total. Both
 * events describe the same money and Stripe sends both.
 */
async function refundCreated(orderId: string, amountMinor: number, tag: string): Promise<void> {
  const order = (await getOrder(orderId))!;
  await recordWebhookEvent({
    provider: 'stripe',
    eventId: `evt_refobj_${tag}`,
    eventType: 'refund.created',
    signatureVerified: true,
    payload: {
      id: `evt_refobj_${tag}`,
      type: 'refund.created',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `re_${tag}`,
          object: 'refund',
          charge: `ch_${tag}`,
          payment_intent: order.stripe_payment_intent_id,
          amount: amountMinor,
          metadata: { order_id: orderId },
        },
      },
    },
  });
  await drainWebhooks();
}

/** The same refund as a Charge event, with its `refunds` list expanded. */
async function chargeRefundedWithList(
  orderId: string,
  refunds: Array<{ id: string; amount: number }>,
  tag: string,
): Promise<void> {
  const order = (await getOrder(orderId))!;
  await recordWebhookEvent({
    provider: 'stripe',
    eventId: `evt_chlist_${tag}`,
    eventType: 'charge.refunded',
    signatureVerified: true,
    payload: {
      id: `evt_chlist_${tag}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_${tag}`,
          object: 'charge',
          payment_intent: order.stripe_payment_intent_id,
          amount: order.amount_minor,
          amount_refunded: refunds.reduce((a, r) => a + r.amount, 0),
          refunds: { object: 'list', data: refunds.map((r) => ({ id: r.id, amount: r.amount })) },
          metadata: { order_id: orderId },
        },
      },
    },
  });
  await drainWebhooks();
}

describe('partial refunds', () => {
  it('revokes in proportion to the money returned, not the whole batch', async () => {
    const user: TestUser = await h.createUser();
    const orderId = await buyAndPay(user);
    expect((await balanceOf(user.id)).available).toBe(units);

    // Roughly a third back.
    const refunded = Math.round(paid * 0.3);
    await refundTo(orderId, refunded, 'third');

    const expectedRevoked = Math.floor((units * refunded) / paid);
    expect(expectedRevoked).toBeLessThan(units); // the test would be vacuous otherwise
    expect((await balanceOf(user.id)).available).toBe(units - expectedRevoked);
    expect((await getOrder(orderId))?.status).toBe('partially_refunded');
  });

  it('settles on the cumulative total when a second partial refund follows', async () => {
    const user: TestUser = await h.createUser();
    const orderId = await buyAndPay(user);

    await refundTo(orderId, Math.round(paid * 0.3), 'first');
    // The charge's running total, which is what Stripe sends.
    await refundTo(orderId, Math.round(paid * 0.6), 'second');

    const cumulative = Math.round(paid * 0.6);
    const expectedRevoked = Math.floor((units * cumulative) / paid);
    expect((await balanceOf(user.id)).available).toBe(units - expectedRevoked);
  });

  it('still takes everything back on a full refund', async () => {
    const user: TestUser = await h.createUser();
    const orderId = await buyAndPay(user);

    await refundTo(orderId, paid, 'full');

    expect((await balanceOf(user.id)).available).toBe(0);
    expect((await getOrder(orderId))?.status).toBe('refunded');
  });

  /*
   * `charge.refunded` and `refund.created` do not mean the same thing by
   * `amount` — cumulative on the Charge, this-one-refund on the Refund — and
   * both arrive for the same money. The handler read them through one `??`
   * and recorded whichever landed under `obj['id'] ?? chargeId`, which is
   * `re_…` for one and `ch_…` for the other: two rows against a UNIQUE
   * (kind, stripe_object_id), so GET /v1/orders/:id/payments showed the
   * refund twice and the second event settled the revocation against a
   * number that might be one refund or the running total.
   */
  it('records one refund once, however many events describe it', async () => {
    const user: TestUser = await h.createUser();
    const orderId = await buyAndPay(user);
    const half = Math.round(paid * 0.5);

    await refundCreated(orderId, half, 'dual');
    await chargeRefundedWithList(orderId, [{ id: 're_dual', amount: half }], 'dual');

    const rows = await withTx(async (tx) =>
      tx.query(
        `SELECT stripe_object_id, amount_minor FROM payments
          WHERE order_id = ? AND kind = 'refund' ORDER BY stripe_object_id`,
        [orderId],
      ),
    );
    const payments = (rows as unknown as [Array<{ stripe_object_id: string; amount_minor: number }>])[0];
    expect(payments.map((p) => p.stripe_object_id)).toEqual(['re_dual']);
    expect(payments[0]!.amount_minor).toBe(-half);

    const expectedRevoked = Math.floor((units * half) / paid);
    expect((await balanceOf(user.id)).available).toBe(units - expectedRevoked);
    expect((await getOrder(orderId))?.refunded_amount_minor).toBe(half);
  });

  /*
   * Two ¥490 refunds on a ¥980 pack, settled by the per-refund events alone.
   * Taking `refund.created`'s `amount` as the running total made the second
   * one a no-op: every yen back, three of five credits kept.
   */
  it('settles on the total when only the per-refund events arrive', async () => {
    const user: TestUser = await h.createUser();
    const orderId = await buyAndPay(user);
    const half = Math.floor(paid / 2);

    await refundCreated(orderId, half, 'h1');
    await refundCreated(orderId, paid - half, 'h2');

    expect((await balanceOf(user.id)).available).toBe(0);
    expect((await getOrder(orderId))?.status).toBe('refunded');
    expect((await getOrder(orderId))?.refunded_amount_minor).toBe(paid);
  });

  /*
   * A Charge event whose `refunds` list is not expanded cannot be enumerated.
   * The cumulative figure it carries is still authoritative, so the shortfall
   * is recorded rather than dropped — and recorded under a key stable enough
   * that a redelivery changes nothing.
   */
  it('still settles from a charge whose refund list is not expanded', async () => {
    const user: TestUser = await h.createUser();
    const orderId = await buyAndPay(user);

    await refundTo(orderId, paid, 'bare');
    await refundTo(orderId, paid, 'bare');

    expect((await balanceOf(user.id)).available).toBe(0);
    expect((await getOrder(orderId))?.refunded_amount_minor).toBe(paid);
    const rows = await withTx(async (tx) =>
      tx.query(
        `SELECT COALESCE(-SUM(amount_minor), 0) AS total FROM payments
          WHERE order_id = ? AND kind = 'refund'`,
        [orderId],
      ),
    );
    expect(Number((rows as unknown as [Array<{ total: number }>])[0][0]!.total)).toBe(paid);
  });

  it('never revokes twice for the same refund', async () => {
    const user: TestUser = await h.createUser();
    const orderId = await buyAndPay(user);

    await refundTo(orderId, Math.round(paid * 0.3), 'dup');
    const after = (await balanceOf(user.id)).available;
    // Same refund object id arriving again — a redelivery, not a new refund.
    await refundTo(orderId, Math.round(paid * 0.3), 'dup');

    expect((await balanceOf(user.id)).available).toBe(after);
  });
});
