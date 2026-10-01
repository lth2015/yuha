/**
 * The shape Stripe actually sends, not the shape we assumed.
 *
 * A real ¥1,980 CREATOR subscription was paid against the sandbox on
 * 2026-09-28. Stripe accepted the card, `customer.subscription.created` and
 * `invoice.paid` were both delivered and both returned 200 — and the buyer
 * received **zero** credits. No `subscription_period` batch, no grant in the
 * ledger, `orders.entitlement_granted_at` left null.
 *
 * On API version 2026-08-26.dahlia the Invoice object no longer carries a
 * top-level `subscription`, and the Subscription object no longer carries
 * `current_period_start` / `current_period_end`. Both moved:
 *
 *   invoice.subscription  → invoice.parent.subscription_details.subscription
 *   invoice.metadata      → invoice.parent.subscription_details.metadata
 *   sub.current_period_*  → sub.items.data[0].current_period_*
 *
 * `handleInvoicePaid` opens with `if (typeof subscriptionId !== 'string')
 * return;`, so every subscription invoice was silently discarded on its first
 * line. Nothing threw, nothing retried, and the event was marked processed.
 *
 * The existing payment tests could not have caught this: they drive the
 * simulated adapter, whose fixtures are built from the same assumption the
 * production code makes. A simulator agrees with the belief it was written
 * from. Only bytes from Stripe disagree — so the payloads below are trimmed
 * copies of ones taken off the wire, and must stay that way.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processWebhookEvent } from '@yuha/api';
import {
  claimWebhookEvents,
  getActiveProduct,
  getOrder,
  insertOrder,
  markOrderPaid,
  recordWebhookEvent,
  upsertSubscription,
  withTx,
} from '@yuha/db';
import { createHarness, resetData, teardown, balanceOf, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
/*
 * Read from the catalogue rather than written here. The harness seeds
 * `pro_monthly` with its own synthetic numbers (100 songs, 999 usd) which do
 * not match the shipped catalogue (15 songs, 1980 jpy); asserting a literal
 * would only pin the fixture, and the claim under test is that the grant is
 * the product's size, whatever that is.
 */
let planUnits: number;

beforeAll(async () => {
  h = await createHarness({ FEATURE_SUBSCRIPTIONS_ENABLED: 'true' });
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

async function drainWebhooks(): Promise<number> {
  const events = await withTx(async (tx) => claimWebhookEvents(20, tx));
  for (const ev of events) await processWebhookEvent(h.ctx, ev);
  return events.length;
}

const SUB_ID = 'sub_1UKcWZCMBoZEqZqs5pCYMbGl';
const PERIOD_START = 1790594108;
const PERIOD_END = 1793186108;

/**
 * invoice.paid as 2026-08-26.dahlia sends it. Note there is no top-level
 * `subscription` and no top-level `metadata` — that is the whole point.
 */
function invoicePaid(opts: { userId: string; orderId: string; invoiceId: string }) {
  return {
    id: `evt_${opts.invoiceId}`,
    type: 'invoice.paid',
    created: PERIOD_START,
    data: {
      object: {
        id: opts.invoiceId,
        object: 'invoice',
        status: 'paid',
        paid: true,
        amount_paid: 1980,
        currency: 'jpy',
        // Degenerate on the first invoice — start equals end. Reading the
        // period from here alone yields a batch that expires the moment it is
        // created, which is why the subscription item is the real source.
        period_start: PERIOD_START,
        period_end: PERIOD_START,
        parent: {
          type: 'subscription_details',
          quote_details: null,
          subscription_details: {
            subscription: SUB_ID,
            metadata: {
              user_id: opts.userId,
              order_id: opts.orderId,
              price_key: 'pro_monthly',
              price_version: '2',
            },
          },
        },
      },
    },
  };
}

describe('Stripe invoice/subscription shape (2026-08-26.dahlia)', () => {
  /*
   * The ordering that actually occurred: Stripe delivered invoice.paid one
   * second BEFORE customer.subscription.created, so our subscriptions table
   * was still empty when the grant had to be decided. Everything the handler
   * needs must therefore come out of the invoice's own metadata.
   */
  it('grants the period when invoice.paid arrives before we know the subscription', async () => {
    const user: TestUser = await h.createUser();
    expect((await balanceOf(user.id)).available).toBe(0);

    await recordWebhookEvent({
      provider: 'stripe',
      eventId: 'evt_shape_out_of_order',
      eventType: 'invoice.paid',
      signatureVerified: true,
      payload: invoicePaid({ userId: user.id, orderId: 'ord_x', invoiceId: 'in_shape_1' }),
    });

    expect(await drainWebhooks()).toBe(1);

    // Zero here is the production bug: paid, and nothing delivered.
    expect((await balanceOf(user.id)).available).toBe(planUnits);
  });

  it('grants once when invoice.paid and invoice.payment_succeeded describe the same invoice', async () => {
    const user: TestUser = await h.createUser();

    for (const [i, type] of ['invoice.paid', 'invoice.payment_succeeded'].entries()) {
      const payload = invoicePaid({ userId: user.id, orderId: 'ord_y', invoiceId: 'in_shape_2' });
      payload.type = type;
      await recordWebhookEvent({
        provider: 'stripe',
        eventId: `evt_shape_dup_${i}`,
        eventType: type,
        signatureVerified: true,
        payload,
      });
    }

    expect(await drainWebhooks()).toBe(2);
    // Two events, one billing period: `${subscriptionId}:${invoiceId}` is the
    // business key that has to absorb the second one.
    expect((await balanceOf(user.id)).available).toBe(planUnits);
  });

  /*
   * `handleCheckoutCompleted` does not grant for subscriptions (PAY-06), so
   * nothing used to record that the opening order had been satisfied. The
   * billing page read that as 「処理中」 beside the credits it had already
   * delivered, and `listUngrantedPaidOrders` — which backs the
   * UngrantedPaidOrders alarm, set to fire above zero — counted every
   * subscriber forever.
   */
  it('marks the order that opened the subscription as fulfilled', async () => {
    const user: TestUser = await h.createUser();
    const order = await insertOrder({
      userId: user.id,
      priceKey: 'pro_monthly',
      priceVersion: 1,
      kind: 'subscription',
      amountMinor: 999,
      currency: 'usd',
      idempotencyKey: 'idem_shape_order',
      metadata: {},
    });
    await withTx(async (tx) => markOrderPaid({ orderId: order.id, receiptUrl: null }, tx));

    await recordWebhookEvent({
      provider: 'stripe',
      eventId: 'evt_shape_order',
      eventType: 'invoice.paid',
      signatureVerified: true,
      payload: invoicePaid({ userId: user.id, orderId: order.id, invoiceId: 'in_shape_4' }),
    });
    await drainWebhooks();

    expect((await balanceOf(user.id)).available).toBe(planUnits);
    const after = await getOrder(order.id);
    expect(after?.entitlement_granted_at, 'order still reads as unfulfilled').not.toBeNull();
  });

  it('dates the batch from the subscription item, not from the degenerate invoice period', async () => {
    const user: TestUser = await h.createUser();
    await upsertSubscription({
      userId: user.id,
      stripeSubscriptionId: SUB_ID,
      stripeCustomerId: 'cus_shape',
      priceKey: 'pro_monthly',
      priceVersion: 2,
      status: 'active',
      currentPeriodStart: new Date(PERIOD_START * 1000),
      currentPeriodEnd: new Date(PERIOD_END * 1000),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      latestInvoiceId: null,
      eventAt: new Date(PERIOD_START * 1000),
    });

    await recordWebhookEvent({
      provider: 'stripe',
      eventId: 'evt_shape_period',
      eventType: 'invoice.paid',
      signatureVerified: true,
      payload: invoicePaid({ userId: user.id, orderId: 'ord_z', invoiceId: 'in_shape_3' }),
    });
    await drainWebhooks();

    const rows = await withTx(async (tx) =>
      tx.query(
        `SELECT expires_at FROM entitlement_batches WHERE user_id = ? AND source = 'subscription_period'`,
        [user.id],
      ),
    );
    const batch = (rows as unknown as [Array<{ expires_at: Date }>])[0][0];
    expect(batch, 'no subscription_period batch was created').toBeTruthy();
    // A month away, not the same instant the invoice was cut.
    expect(batch.expires_at.getTime()).toBeGreaterThan((PERIOD_START + 20 * 86400) * 1000);
  });

  /*
   * The case the three tests above walk straight through without looking at it.
   *
   * They assert the grant happens when nothing knows the period — no stored
   * subscription, no live one, a degenerate invoice period — and it did. With
   * `expires_at` NULL, which `grantUnits` and `getBalance` both read as *never
   * expires*: pay ¥1,980 once, cancel, keep the credits for good. §11 / UI-10
   * says unused units do not carry over, and `reconcileUngrantedSubscriptions`
   * refuses to grant for exactly this reason while this path did it silently.
   *
   * Every assertion above still passes either way, which is what let it sit
   * here. This is the one that does not.
   */
  it('never grants a period that has no end, even when no source knows the period', async () => {
    const user: TestUser = await h.createUser();

    await recordWebhookEvent({
      provider: 'stripe',
      eventId: 'evt_shape_no_period',
      eventType: 'invoice.paid',
      signatureVerified: true,
      payload: invoicePaid({ userId: user.id, orderId: 'ord_np', invoiceId: 'in_shape_5' }),
    });
    expect(await drainWebhooks()).toBe(1);

    // The credits arrive — refusing the grant would be the other bug.
    expect((await balanceOf(user.id)).available).toBe(planUnits);

    const rows = await withTx(async (tx) =>
      tx.query(
        `SELECT expires_at FROM entitlement_batches WHERE user_id = ? AND source = 'subscription_period'`,
        [user.id],
      ),
    );
    const batch = (rows as unknown as [Array<{ expires_at: Date | null }>])[0][0];
    expect(batch, 'no subscription_period batch was created').toBeTruthy();
    expect(batch!.expires_at, 'a subscription batch that never expires').not.toBeNull();
    // Bounded, and bounded to about a billing period rather than to anything.
    const start = PERIOD_START * 1000;
    expect(batch!.expires_at!.getTime()).toBeGreaterThan(start + 20 * 86400_000);
    expect(batch!.expires_at!.getTime()).toBeLessThan(start + 40 * 86400_000);
  });
});
