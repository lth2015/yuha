import { describeError, type SubscriptionStatus } from '@yuha/contracts';
import type { OrderRow, Tx } from '@yuha/db';
import {
  finishWebhookEvent,
  getActiveProduct,
  getOrder,
  getUser,
  getProductVersion,
  inferredPeriodDays,
  grantLicense,
  grantUnits,
  findOrderBySession,
  findSubscriptionByStripeId,
  listStalePendingCheckouts,
  listUngrantedPaidOrders,
  markEntitlementGranted,
  markOrderPaid,
  recordPayment,
  revokeUnusedUnits,
  setOrderStatus,
  trackEvent,
  upsertSubscription,
  withTx,
  query,
  queryOne,
  type WebhookEventRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';
import { fulfilPaidOrder, grantEntitlementForOrder } from './fulfilment.js';
import { reviewPaidCardOrder } from './order-review.js';

/**
 * Stripe webhook processing (PROJECT_TASK.md §7).
 *
 * Two independent idempotency layers, as PAY-05 requires:
 *   1. `webhook_events.event_id` — the same event delivered twice is stored once;
 *   2. business-object keys — `entitlement_batches (user, source, source_ref)`
 *      and `orders.status` transitions — so two *different* events describing
 *      the same payment still grant only once.
 *
 * Ordering is not assumed. Where an event could be stale, the current object is
 * re-read from the provider and the newer state wins.
 */

type StripeEventLike = {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
};

function asEvent(row: WebhookEventRow): StripeEventLike {
  return row.payload as unknown as StripeEventLike;
}

export async function processWebhookEvent(ctx: AppContext, row: WebhookEventRow): Promise<void> {
  if (!row.signature_verified) {
    // Should be unreachable — unverified events are never claimed for processing.
    await finishWebhookEvent({ id: row.id, status: 'ignored', error: 'signature not verified' });
    return;
  }

  const event = asEvent(row);
  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutCompleted(ctx, event);
        break;
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired':
        await handleCheckoutFailed(ctx, event);
        break;
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        await handleInvoicePaid(ctx, event);
        break;
      case 'invoice.payment_failed':
        await handleInvoiceFailed(ctx, event);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscriptionChanged(ctx, event);
        break;
      case 'charge.refunded':
      case 'refund.created':
        await handleRefund(ctx, event);
        break;
      case 'charge.dispute.created':
      case 'charge.dispute.closed':
        // `closed` was not routed at all, so the moment the money actually
        // moved — we lose, Stripe takes it back — nothing happened: no
        // revocation, and not even the operator signal, which fires on
        // `created`.
        await handleDispute(ctx, event);
        break;
      default:
        await finishWebhookEvent({ id: row.id, status: 'ignored', error: null });
        return;
    }
    await finishWebhookEvent({ id: row.id, status: 'processed', error: null });
  } catch (err) {
    await finishWebhookEvent({ id: row.id, status: 'failed', error: describeError(err) });
    throw err;
  }
}

function metaString(obj: Record<string, unknown>, key: string): string | null {
  const meta = obj['metadata'] as Record<string, unknown> | undefined;
  const v = meta?.[key];
  return typeof v === 'string' ? v : null;
}

/**
 * Where a subscription invoice keeps the things we need.
 *
 * On 2026-08-26.dahlia an Invoice has no top-level `subscription` and no
 * top-level `metadata`; both sit under `parent.subscription_details`. We read
 * `invoice['subscription']` and bailed on the first line of `handleInvoicePaid`
 * for every subscription invoice ever delivered — a paid CREATOR subscription
 * granted nothing, and the event was still marked processed.
 *
 * Both shapes are accepted. The old one is not dead code: events sit in
 * `webhook_events` and can be replayed long after the account's API version
 * moves, and a Stripe account pinned to an older version still sends it.
 */
function invoiceSubscription(invoice: Record<string, unknown>): string | null {
  const direct = invoice['subscription'];
  if (typeof direct === 'string') return direct;
  const details = subscriptionDetails(invoice);
  const nested = details?.['subscription'];
  return typeof nested === 'string' ? nested : null;
}

function invoiceMeta(invoice: Record<string, unknown>, key: string): string | null {
  return metaString(invoice, key) ?? metaString(subscriptionDetails(invoice) ?? {}, key);
}

function subscriptionDetails(invoice: Record<string, unknown>): Record<string, unknown> | null {
  const parent = invoice['parent'] as Record<string, unknown> | undefined;
  const details = parent?.['subscription_details'];
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : null;
}

/**
 * The current period, which also moved: a Subscription no longer carries
 * `current_period_start` / `current_period_end`, its items do. The invoice's
 * own `period_start` / `period_end` are not a substitute — on a first invoice
 * they are the same instant, so a batch dated from them expires as it is
 * created and the subscriber's credits vanish immediately.
 */
function subscriptionPeriod(sub: Record<string, unknown>): { start: Date | null; end: Date | null } {
  const items = (sub['items'] as { data?: Array<Record<string, unknown>> } | undefined)?.data?.[0];
  const start = sub['current_period_start'] ?? items?.['current_period_start'];
  const end = sub['current_period_end'] ?? items?.['current_period_end'];
  return { start: numberToDate(start), end: numberToDate(end) };
}

/**
 * One-time purchase completed.
 *
 * PAY-03: the amount, currency and paid status are re-verified against the
 * provider's own object before a single credit is granted. The grant is keyed
 * on the order id, so a replay grants nothing further.
 */
async function handleCheckoutCompleted(ctx: AppContext, event: StripeEventLike): Promise<void> {
  const session = event.data.object;
  const sessionId = String(session['id'] ?? '');
  const orderId = metaString(session, 'order_id') ?? (session['client_reference_id'] as string | null);

  const order = orderId ? await getOrder(orderId) : await findOrderBySession(sessionId);
  if (!order) return; // not one of ours

  // Re-read the authoritative object rather than trusting the event payload,
  // which may be stale if events arrived out of order.
  const live = await ctx.payments.retrieveCheckoutSession(sessionId);
  const paymentStatus = live?.paymentStatus ?? String(session['payment_status'] ?? '');
  if (paymentStatus !== 'paid') return;

  const amountTotal = live?.amountTotal ?? (session['amount_total'] as number | null);
  const currency = (live?.currency ?? session['currency']) as string | undefined;
  if (amountTotal !== null && amountTotal !== undefined && amountTotal !== order.amount_minor) {
    throw new Error(
      `amount mismatch for order ${order.id}: charged ${amountTotal}, catalogue says ${order.amount_minor}`,
    );
  }
  if (currency && currency.toLowerCase() !== order.currency.toLowerCase()) {
    throw new Error(`currency mismatch for order ${order.id}: ${currency} vs ${order.currency}`);
  }

  await withTx(async (tx) => {
    const { order: updated, changed } = await markOrderPaid(
      {
        orderId: order.id,
        paymentIntentId: live?.paymentIntentId ?? (session['payment_intent'] as string | null),
        receiptUrl: (session['receipt_url'] as string | null) ?? null,
        customerId: live?.customerId ?? (session['customer'] as string | null),
      },
      tx,
    );
    /*
     * `markOrderPaid` documents itself as the idempotency point — "returns
     * `changed: false` if it was already paid, so a duplicated
     * `checkout.session.completed` grants nothing extra" — and the guard here
     * read `order`, which is a plain re-read and therefore always truthy. The
     * stated protection did not exist; what saved it was that every grant
     * below is independently idempotent on its own business key.
     *
     * It is not purely cosmetic. Before `markOrderPaid` accepted `canceled`,
     * an async-payment checkout whose session expired first was granted on an
     * order still reading `canceled` with `paid_at` null and no receipt — the
     * goods delivered against a record saying the sale never happened.
     */
    if (!updated || !changed) return;

    // The same code the stablecoin channel runs. Exactly-once lives on the
    // business key — the order id — not on the event that got us here, which
    // is what makes a card payment and an on-chain payment for one order
    // deliver once between them.
    /*
     * Assessed before delivery is attempted, in this same transaction.
     *
     * The review row has to exist by the time `grantEntitlementForOrder` looks
     * for it, or the hold is a note written after the goods have gone. ⑥ in
     * docs/FRAUD_PREVENTION.md; what is held is delivery and never the
     * payment, because a chargeback can take money back and nothing takes back
     * a downloaded song.
     */
    const buyer = await getUser(updated.user_id, tx);
    const held = buyer ? await reviewPaidCardOrder(ctx, { order: updated, user: buyer }, tx) : [];

    const granted = await grantEntitlementForOrder(updated, tx);
    if (!granted.delivered && granted.reason === 'held_for_review') {
      /*
       * Expected, and not an error: the payment happened and is recorded
       * below, and the order stays paid-and-undelivered until a person
       * decides. Throwing here would make Stripe retry an event whose outcome
       * is already correct.
       */
      await trackEvent({
        name: 'card_order_held_for_review',
        userRef: updated.user_id,
        props: { order_id: updated.id, reasons: held, amount_minor: updated.amount_minor },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch(() => undefined);
    } else if (!granted.delivered) {
      /*
       * Paid for something the buyer already holds. The order deliberately
       * stays ungranted so the recovery sweep and the console keep showing it,
       * and this throws rather than returning, so the payment row below is not
       * written as if the sale completed. Stripe retries the event; the state
       * it finds is the same, and a person has to refund one of the two
       * orders. The silent version — marking it delivered anyway — is what
       * this replaces.
       */
      throw new Error(`order ${updated.id} paid for an entitlement already held (${granted.reason})`);
    }

    const pi = live?.paymentIntentId ?? (session['payment_intent'] as string | null);
    if (pi) {
      await recordPayment(
        {
          orderId: updated.id,
          userId: updated.user_id,
          kind: 'payment',
          stripeObjectId: pi,
          amountMinor: order.amount_minor,
          status: 'succeeded',
          occurredAt: new Date(event.created * 1000),
        },
        tx,
      );
    }

    await trackEvent(
      {
        name: 'payment_succeeded',
        userRef: updated.user_id,
        props: { price_key: updated.price_key, kind: updated.kind },
        priceVersion: updated.price_version,
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      },
      tx,
    );
  });
}

async function handleCheckoutFailed(ctx: AppContext, event: StripeEventLike): Promise<void> {
  const session = event.data.object;
  const orderId = metaString(session, 'order_id') ?? (session['client_reference_id'] as string | null);
  const order = orderId ? await getOrder(orderId) : await findOrderBySession(String(session['id'] ?? ''));
  if (!order || order.status === 'paid') return; // never downgrade a paid order
  await setOrderStatus({
    orderId: order.id,
    status: event.type === 'checkout.session.expired' ? 'canceled' : 'failed',
  });
}

/**
 * Subscription period paid (PAY-06).
 *
 * The grant reference is the invoice id plus the period, so multiple events
 * describing the same invoice grant exactly one period of credits, and a
 * genuine renewal (a new invoice) grants the next period.
 */
async function handleInvoicePaid(ctx: AppContext, event: StripeEventLike): Promise<void> {
  const invoice = event.data.object;
  const subscriptionId = invoiceSubscription(invoice);
  if (!subscriptionId) return;
  if (invoice['paid'] !== true && invoice['status'] !== 'paid') return;

  const sub = await findSubscriptionByStripeId(subscriptionId);
  const userId = sub?.user_id ?? invoiceMeta(invoice, 'user_id');
  if (!userId) return;

  const live = await ctx.payments.retrieveSubscription(subscriptionId);
  /*
   * Order of preference for the period, worst case last.
   *
   * The live subscription is authoritative. Our own stored row is next,
   * because `customer.subscription.created` may already have written a correct
   * period even when this invoice cannot be resolved live. The invoice's own
   * dates are the floor: on a first invoice `period_start === period_end`, so
   * a batch dated from them expires the instant it is granted.
   */
  const line = invoiceLinePeriod(invoice);
  const periodStart =
    live?.currentPeriodStart ??
    sub?.current_period_start ??
    line.start ??
    numberToDate(invoice['period_start']);
  const invoiceEnd = numberToDate(invoice['period_end']);
  /*
   * A fifth source, and the reason there is one.
   *
   * `expiresAt: null` means *never expires* to `grantUnits`, and
   * `expireBatches` only touches rows where `expires_at IS NOT NULL`. So when
   * all of the sources above were absent this granted a permanent batch:
   * pay for one month, cancel, keep the credits for good — against §11 / UI-10
   * and against the comment below that claims this code enforces it. All of
   * them can be absent at once, and the shape tests in
   * `tests/stripe-invoice-shape.test.ts` are exactly that case:
   * `retrieveSubscription` swallows every provider error and returns null,
   * `customer.subscription.created` may not have been processed yet, and on a
   * first invoice `period_start === period_end`.
   *
   * Refusing to grant is the wrong repair — that is the bug those tests were
   * written for, where a paid subscription delivered nothing. So the grant
   * happens, with an end that is inferred rather than unbounded: every plan in
   * the catalogue is monthly, and a batch that lives a few days too long is a
   * bounded error where a batch that never expires is not. The next invoice
   * grants the next period under its own key regardless, so the inference
   * never compounds. It is flagged, because an operator should be able to see
   * that a period was guessed.
   *
   * The length of the inferred period comes from the product's own
   * `billing_interval`, not from a constant and not from the price key's
   * spelling. It was a flat 31 days, which was right only because every plan
   * in the catalogue happens to be monthly — an annual plan would have been
   * granted a month and the subscriber would have lost eleven.
   */
  const authoritativeEnd =
    live?.currentPeriodEnd ??
    sub?.current_period_end ??
    line.end ??
    (invoiceEnd && periodStart && invoiceEnd.getTime() > periodStart.getTime() ? invoiceEnd : null);
  const effectiveStart = periodStart ?? new Date();
  const periodInferred = authoritativeEnd === null;
  const invoiceId = String(invoice['id'] ?? '');

  // Looked up before the period is computed, not after: the period now depends
  // on what the catalogue says this plan's cadence is.
  const priceKey = sub?.price_key ?? invoiceMeta(invoice, 'price_key') ?? 'creator_monthly';
  const product =
    (sub ? await getProductVersion(priceKey, sub.price_version) : null) ?? (await getActiveProduct(priceKey));
  if (!product) throw new Error(`unknown subscription product ${priceKey}`);

  const periodEnd =
    authoritativeEnd ??
    new Date(effectiveStart.getTime() + inferredPeriodDays(product.billing_interval) * 86400_000);

  await withTx(async (tx) => {
    if (live) {
      await upsertSubscription(
        {
          userId,
          stripeSubscriptionId: subscriptionId,
          stripeCustomerId: live.customerId,
          priceKey: product.price_key,
          priceVersion: product.version,
          status: live.status as SubscriptionStatus,
          currentPeriodStart: live.currentPeriodStart,
          currentPeriodEnd: live.currentPeriodEnd,
          cancelAtPeriodEnd: live.cancelAtPeriodEnd,
          canceledAt: live.canceledAt,
          latestInvoiceId: invoiceId,
          eventAt: new Date(event.created * 1000),
        },
        tx,
      );
    }

    // §11 / UI-10: unused units do not carry over, so each period is its own
    // batch with its own expiry rather than a top-up of a shared balance.
    await grantUnits(
      {
        userId,
        source: 'subscription_period',
        sourceRef: `${subscriptionId}:${invoiceId}`,
        units: product.units,
        productKey: product.price_key,
        priceVersion: product.version,
        effectiveFrom: effectiveStart,
        expiresAt: periodEnd,
        reason: periodInferred
          ? `subscription_invoice_paid:${invoiceId}:inferred_period`
          : `subscription_invoice_paid:${invoiceId}`,
      },
      tx,
    );

    /*
     * The order that opened this subscription has now been fulfilled.
     *
     * `handleCheckoutCompleted` deliberately does not grant for subscriptions
     * — the invoice does, and granting in both places would double it (PAY-06)
     * — but nothing then recorded that the order was satisfied, so
     * `entitlement_granted_at` stayed null forever. Two things read that:
     * the billing page, which showed a delivered ¥1,980 subscription as
     * 「処理中」 next to the 15 credits it had already handed over, and
     * `listUngrantedPaidOrders`, which backs the UngrantedPaidOrders alarm
     * (`infra/terraform/monitoring.tf:158`, fires above zero). The alarm has no
     * publisher yet, so it would have gone permanently red the day someone
     * wired one up, for every subscriber the product ever had.
     *
     * `markEntitlementGranted` COALESCEs, so a renewal invoice carrying the
     * same order id in its metadata leaves the original timestamp alone.
     */
    const orderId = invoiceMeta(invoice, 'order_id');
    if (orderId) await markEntitlementGranted(orderId, tx);

    const charge = invoice['charge'];
    if (typeof charge === 'string') {
      await recordPayment(
        {
          userId,
          kind: 'payment',
          stripeObjectId: charge,
          // The hop a refund needs. A `refund.created` carries a charge and no
          // invoice, and the batch this grant creates is keyed on the invoice,
          // so without this there is no route from the refund to the period.
          stripeInvoiceId: invoiceId || null,
          amountMinor: Number(invoice['amount_paid'] ?? 0),
          status: 'succeeded',
          occurredAt: new Date(event.created * 1000),
        },
        tx,
      );
    }

    await trackEvent(
      {
        name: 'subscription_period_granted',
        userRef: userId,
        props: {
          invoice_id: invoiceId,
          // True means no source knew when this period ends and the expiry
          // below is a 31-day inference. Worth looking at: it means the
          // subscription lookup failed or arrived out of order.
          period_inferred: periodInferred,
          expires_at: periodEnd.toISOString(),
        },
        priceVersion: product.version,
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      },
      tx,
    );
  });
}

/**
 * PAY-07: a failed renewal grants nothing and revokes nothing. Existing valid
 * entitlements stay; the user is prompted to update their card.
 */
async function handleInvoiceFailed(ctx: AppContext, event: StripeEventLike): Promise<void> {
  const invoice = event.data.object;
  // Not `invoice['subscription']`: on 2026-08-26.dahlia that field is gone and
  // the id is under `parent.subscription_details`. This is the same read whose
  // failure is recorded above `invoiceSubscription`, left in place here — so
  // every `invoice.payment_failed` returned on this line and a subscriber whose
  // card had stopped working still read `active` in GET /v1/entitlements.
  const subscriptionId = invoiceSubscription(invoice);
  if (!subscriptionId) return;
  const sub = await findSubscriptionByStripeId(subscriptionId);
  if (!sub) return;

  const live = await ctx.payments.retrieveSubscription(subscriptionId);
  if (!live) return;

  await withTx(async (tx) => {
    await upsertSubscription(
      {
        userId: sub.user_id,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: live.customerId,
        priceKey: sub.price_key,
        priceVersion: sub.price_version,
        status: live.status as SubscriptionStatus,
        currentPeriodStart: live.currentPeriodStart,
        currentPeriodEnd: live.currentPeriodEnd,
        cancelAtPeriodEnd: live.cancelAtPeriodEnd,
        canceledAt: live.canceledAt,
        eventAt: new Date(event.created * 1000),
      },
      tx,
    );
    await trackEvent(
      {
        name: 'subscription_payment_failed',
        userRef: sub.user_id,
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      },
      tx,
    );
  });
}

async function handleSubscriptionChanged(ctx: AppContext, event: StripeEventLike): Promise<void> {
  const obj = event.data.object;
  const subscriptionId = String(obj['id'] ?? '');
  if (!subscriptionId) return;

  const existing = await findSubscriptionByStripeId(subscriptionId);
  const userId = existing?.user_id ?? metaString(obj, 'user_id');
  if (!userId) return;

  // Re-read: `customer.subscription.updated` events regularly arrive out of
  // order, and `last_event_at` alone cannot repair a stale payload.
  const live = await ctx.payments.retrieveSubscription(subscriptionId);
  const priceKey = existing?.price_key ?? metaString(obj, 'price_key') ?? 'creator_monthly';
  const product = await getActiveProduct(priceKey);

  await withTx(async (tx) => {
    await upsertSubscription(
      {
        userId,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: live?.customerId ?? String(obj['customer'] ?? ''),
        priceKey,
        priceVersion: existing?.price_version ?? product?.version ?? 1,
        status: (live?.status ?? String(obj['status'] ?? 'incomplete')) as SubscriptionStatus,
        // The payload's own period, read from wherever this API version keeps
        // it, so a subscription still gets dated when the live re-read fails.
        currentPeriodStart: live?.currentPeriodStart ?? subscriptionPeriod(obj).start,
        currentPeriodEnd: live?.currentPeriodEnd ?? subscriptionPeriod(obj).end,
        cancelAtPeriodEnd: live?.cancelAtPeriodEnd ?? obj['cancel_at_period_end'] === true,
        canceledAt: live?.canceledAt ?? numberToDate(obj['canceled_at']),
        eventAt: new Date(event.created * 1000),
      },
      tx,
    );
  });
}

/**
 * Refund (PAY-09).
 *
 * Only units that are neither reserved nor already consumed are pulled back, so
 * a refund cannot cancel work already delivered and cannot drive a balance
 * negative. What remains reserved or consumed is reported for manual handling
 * rather than force-revoked.
 */
/**
 * What a refund is a refund of, and who is owed the reversal.
 *
 * Two subjects, because there are two kinds of thing to sell:
 *
 *  - a one-time pack, found by its order, which is how it has always worked;
 *  - a subscription period, found by its invoice, which is the only key that
 *    survives. `mode: 'subscription'` never sets `stripe_payment_intent_id`, so
 *    the old lookup missed the first month, and a renewal has no order at all,
 *    so no order-keyed lookup could ever have reached month two.
 *
 * The invoice is read off the Charge where Stripe puts it, and otherwise from
 * the payment row written when the period was granted: a `refund.created`
 * carries a charge and no invoice, which is the hop `payments.stripe_invoice_id`
 * exists for.
 *
 * `amountMinor` is what was paid for the thing being refunded — the order total
 * or the invoice total — because the proportional revocation is a share of it.
 */
type RefundSubject = {
  userId: string;
  amountMinor: number;
  /** Set for a one-time pack; a renewal genuinely has none. */
  order: { id: string; user_id: string; amount_minor: number } | null;
  /** Set for a subscription period. */
  invoiceId: string | null;
};

async function refundSubject(
  obj: Record<string, unknown>,
  chargeId: string,
  paymentIntent: unknown,
): Promise<RefundSubject | null> {
  // The Charge carries its invoice; the Refund does not, so fall back to what
  // we wrote down when we granted the period.
  let invoiceId = typeof obj['invoice'] === 'string' ? obj['invoice'] : null;
  let paid: { user_id: string; amount_minor: number; stripe_invoice_id: string | null } | undefined;
  if (chargeId) {
    const rows = await query<{ user_id: string; amount_minor: number; stripe_invoice_id: string | null }>(
      `SELECT user_id, amount_minor, stripe_invoice_id FROM payments
        WHERE stripe_object_id = ? AND kind = 'payment' LIMIT 1`,
      [chargeId],
    );
    paid = rows[0];
    invoiceId ??= paid?.stripe_invoice_id ?? null;
  }

  const orders = await query<{ id: string; user_id: string; amount_minor: number }>(
    `SELECT id, user_id, amount_minor FROM orders
      WHERE stripe_payment_intent_id = ? OR id = ?
      LIMIT 1`,
    [typeof paymentIntent === 'string' ? paymentIntent : '', metaString(obj, 'order_id') ?? null],
  );
  const order = orders[0] ?? null;

  /*
   * The invoice wins when both are known, and that is not arbitrary: the
   * subscription's first month has an order *and* an invoice, but the grant it
   * produced is a `subscription_period` batch keyed on the invoice. Revoking
   * against the order would look for a `one_time_order` batch that does not
   * exist and quietly take nothing — which is the original bug wearing the
   * fix's clothes.
   */
  if (invoiceId) {
    /*
     * The batch, not the payment row, is who this belongs to.
     *
     * Asking Stripe was the mistake. `handleInvoicePaid` writes the payment row
     * only when the invoice carries a top-level `charge`, and the captured
     * dahlia payload has no such field — so for a renewal there was no payment
     * row, no order either, and `refundSubject` returned null. `handleRefund`
     * then returned on its first check: no revocation, no row, no telemetry. A
     * refunded renewal kept every credit and left no trace.
     *
     * The batch is our own record and its business key already contains the
     * invoice. It knows the owner, and it knows the product version it was
     * granted at, which is what the period cost — so the proportional share can
     * be computed without Stripe telling us anything.
     */
    const batch = await queryOne<{ user_id: string; product_key: string | null; price_version: number | null }>(
      `SELECT user_id, product_key, price_version FROM entitlement_batches
        WHERE source = 'subscription_period' AND SUBSTRING_INDEX(source_ref, ':', -1) = ?
        LIMIT 1`,
      [invoiceId],
    );
    const userId = batch?.user_id ?? paid?.user_id ?? order?.user_id;
    if (!userId) return null;

    let amountMinor = paid?.amount_minor ?? 0;
    if (!amountMinor && batch?.product_key && batch.price_version !== null) {
      const product = await getProductVersion(batch.product_key, batch.price_version);
      amountMinor = product?.amount_minor ?? 0;
    }
    return { userId, amountMinor: amountMinor || (order?.amount_minor ?? 0), order, invoiceId };
  }
  if (!order) return null;
  return { userId: order.user_id, amountMinor: order.amount_minor, order, invoiceId: null };
}

/**
 * Take back what the money no longer pays for.
 *
 * Shared by a refund and by a dispute we lost, because they are the same event
 * seen from two directions: the money has gone back and the goods it bought
 * have to go with it. Keeping one copy is the point — the refund path was fixed
 * for subscriptions and renewals, and a second copy in the dispute handler
 * would have been the old bug, still there, under a different name.
 */
async function reverseEntitlements(
  ctx: AppContext,
  params: { subject: RefundSubject; reversedMinor: number; reasonTag: 'refund' | 'dispute_lost' },
  tx: Tx,
): Promise<void> {
  /*
   * The batch this refund reverses.
   *
   * A subscription period's business key is `<subscription>:<invoice>`, so it
   * is matched on the invoice half — the subscription id is not on a refund
   * event and does not need to be, because an invoice belongs to exactly one.
   * `SUBSTRING_INDEX` rather than a LIKE, so an invoice id that happens to
   * contain a wildcard character cannot match a different subscriber's batch.
   */
  const batches = params.subject.invoiceId
    ? await query<{ id: string; granted_units: number }>(
        `SELECT id, granted_units FROM entitlement_batches
          WHERE user_id = ? AND source = 'subscription_period'
            AND SUBSTRING_INDEX(source_ref, ':', -1) = ?`,
        [params.subject.userId, params.subject.invoiceId],
        tx,
      )
    : await query<{ id: string; granted_units: number }>(
        `SELECT id, granted_units FROM entitlement_batches
          WHERE user_id = ? AND source = 'one_time_order' AND source_ref = ?`,
        [params.subject.order!.user_id, params.subject.order!.id],
        tx,
      );
  for (const b of batches) {
    /*
     * How much of the pack the refund actually paid back.
     *
     * This used to revoke every unused unit regardless of params.reversedMinor, so a ¥300
     * refund on a ¥980 DROP took back all five songs: 30% of the money
     * returned and 100% of the goods gone, leaving the buyer ¥680 down with
     * nothing. The order was already being written as `partially_refunded`,
     * so the distinction existed everywhere except here.
     *
     * `params.reversedMinor` is the cumulative `amount_refunded` from the charge where
     * Stripe sends one, so two partial refunds settle against the running
     * total rather than each taking its own share of the original.
     *
     * The batch's `granted_units` shrinks as units are revoked, so the
     * original size is recovered from the ledger — the ledger is the record,
     * and reconstructing from it is what keeps a second partial refund from
     * measuring against an already-reduced pack.
     */
    const prior = await queryOne<{ revoked: number }>(
      `SELECT COALESCE(SUM(units), 0) AS revoked FROM ledger_entries
        WHERE batch_id = ? AND entry_type = 'revoke'`,
      [b.id],
      tx,
    );
    const alreadyRevoked = Number(prior?.revoked ?? 0);
    const originalUnits = b.granted_units + alreadyRevoked;
  
    let maxUnits: number | undefined;
    // The price of the thing refunded: an order total, or an invoice total
    // for a subscription period. The rule is the same either way.
    const paidForIt = params.subject.amountMinor;
    if (paidForIt > 0 && params.reversedMinor > 0 && params.reversedMinor < paidForIt) {
      // Floored, so rounding leaves the buyer holding slightly more than the
      // surviving payment strictly buys. The other direction takes songs from
      // someone who still paid for them.
      const target = Math.floor((originalUnits * params.reversedMinor) / paidForIt);
      maxUnits = Math.max(0, target - alreadyRevoked);
    }
  
    const res = await revokeUnusedUnits(
      {
        userId: params.subject.userId,
        batchId: b.id,
        reason: `${params.reasonTag}:${params.subject.invoiceId ?? params.subject.order!.id}`,
        maxUnits,
      },
      tx,
    );
    if (res.remainingReserved > 0 || res.remainingConsumed > 0) {
      // Already-fulfilled or in-flight units are flagged for a human, not
      // clawed back automatically.
      await trackEvent(
        {
          name: `${params.reasonTag}_partial_fulfilment`,
          userRef: params.subject.userId,
          props: {
            order_id: params.subject.order?.id ?? null,
            invoice_id: params.subject.invoiceId,
            reserved: res.remainingReserved,
            consumed: res.remainingConsumed,
          },
          runMode: ctx.config.mode,
          isInternal: ctx.config.isDemo,
        },
        tx,
      );
    }
  }
}

async function handleRefund(ctx: AppContext, event: StripeEventLike): Promise<void> {
  const obj = event.data.object;
  const chargeId = String(obj['charge'] ?? obj['id'] ?? '');
  const paymentIntent = obj['payment_intent'];
  if (!chargeId) return;

  /*
   * `charge.refunded` and `refund.created` do not mean the same thing by
   * `amount`, and both were being read through one `?? `.
   *
   * On a Charge, `amount_refunded` is the **cumulative** total ever refunded.
   * On a Refund, `amount` is **that one refund**. Both arrive for the same
   * money, and the old code took whichever landed, recorded it under
   * `obj['id'] ?? chargeId` — `re_…` for one event and `ch_…` for the other,
   * two distinct values against a UNIQUE (kind, stripe_object_id) — and so
   * wrote the same refund to `payments` twice while settling the revocation
   * against a number that might be one refund or the running total.
   *
   * Two ¥490 refunds on a ¥980 DROP: the second `refund.created` says 490,
   * `target = floor(5 × 490 / 980) = 2`, two units already revoked, so
   * nothing more is taken — the customer has every yen back and keeps three
   * of five credits, and GET /v1/orders/:id/payments shows the refund twice.
   *
   * So: one `payments` row per Stripe Refund object, keyed by the refund id
   * whichever event carries it, and the cumulative figure read back from
   * those rows rather than from the event. A Charge event whose `refunds`
   * are not expanded cannot be enumerated, so the difference it reports is
   * recorded under a key derived from the charge and that total — stable, so
   * a redelivery is still a no-op.
   */
  const fromRefundObject = event.type.startsWith('refund.');
  const chargeCumulative = Math.abs(Number(obj['amount_refunded'] ?? 0)) || 0;
  const enumerated: Array<{ id: string; amount: number }> = [];
  if (fromRefundObject) {
    const id = String(obj['id'] ?? '');
    if (id) enumerated.push({ id, amount: Math.abs(Number(obj['amount'] ?? 0)) });
  } else {
    const list = (obj['refunds'] as { data?: Array<Record<string, unknown>> } | undefined)?.data;
    for (const r of list ?? []) {
      const id = String(r['id'] ?? '');
      if (id) enumerated.push({ id, amount: Math.abs(Number(r['amount'] ?? 0)) });
    }
  }

  /*
   * What this refund is a refund OF.
   *
   * A one-time pack is found by its order. A subscription period cannot be: a
   * `mode: 'subscription'` checkout never sets `stripe_payment_intent_id`, and
   * a renewal has no order at all — orders are created by the checkout that
   * opens the subscription, and month two arrives as an invoice and nothing
   * else. So the subject is the invoice, which is what the batch's business key
   * `<subscription>:<invoice>` is built from.
   *
   * The invoice comes off the Charge where Stripe puts it, and otherwise from
   * the payment row written when the period was granted — a `refund.created`
   * carries a charge and no invoice.
   */
  const subject = await refundSubject(obj, chargeId, paymentIntent);
  if (!subject) {
    /*
     * Money left and we cannot say whose it was. Whatever the cause — an order
     * we never saw, a payload shape that moved again — the one thing that must
     * not happen is for it to pass in silence, which is what `return` alone did.
     */
    await trackEvent({
      name: 'refund_unattributed',
      userRef: null,
      props: {
        charge_id: chargeId || null,
        invoice_id: typeof obj['invoice'] === 'string' ? obj['invoice'] : null,
        amount_minor: chargeCumulative || enumerated.reduce((a, r) => a + r.amount, 0),
      },
      runMode: ctx.config.mode,
      isInternal: ctx.config.isDemo,
    }).catch(() => undefined);
    return;
  }
  const order = subject.order;

  await withTx(async (tx) => {
    const occurredAt = new Date(event.created * 1000);
    let wroteSomething = false;
    for (const r of enumerated) {
      const { inserted } = await recordPayment(
        {
          orderId: order?.id ?? null,
          userId: subject.userId,
          kind: 'refund',
          stripeObjectId: r.id,
          // Carried onto the refund row so the running total can be summed per
          // subject: a renewal's rows have no order to group by.
          stripeInvoiceId: subject.invoiceId,
          amountMinor: -r.amount,
          status: 'succeeded',
          occurredAt,
        },
        tx,
      );
      wroteSomething = wroteSomething || inserted;
    }

    const recordedSoFar = async (): Promise<number> => {
      // Grouped by whichever key this subject has. A renewal's refunds have no
      // order id, so summing by order would read zero and revoke nothing.
      const row = subject.invoiceId
        ? await queryOne<{ refunded: number }>(
            `SELECT COALESCE(-SUM(amount_minor), 0) AS refunded FROM payments
              WHERE stripe_invoice_id = ? AND kind = 'refund' AND status = 'succeeded'`,
            [subject.invoiceId],
            tx,
          )
        : await queryOne<{ refunded: number }>(
            `SELECT COALESCE(-SUM(amount_minor), 0) AS refunded FROM payments
              WHERE order_id = ? AND kind = 'refund' AND status = 'succeeded'`,
            [order!.id],
            tx,
          );
      return Number(row?.refunded ?? 0);
    };

    let recorded = await recordedSoFar();
    if (chargeCumulative > recorded) {
      // A refund whose own event we never saw, or a Charge payload with the
      // refund list collapsed to ids. The charge's cumulative figure is
      // authoritative, so the shortfall is recorded under a key built from it.
      const { inserted } = await recordPayment(
        {
          orderId: order?.id ?? null,
          userId: subject.userId,
          kind: 'refund',
          stripeObjectId: `${chargeId}:cumulative:${chargeCumulative}`,
          stripeInvoiceId: subject.invoiceId,
          amountMinor: -(chargeCumulative - recorded),
          status: 'succeeded',
          occurredAt,
        },
        tx,
      );
      wroteSomething = wroteSomething || inserted;
      recorded = await recordedSoFar();
    }

    // Nothing new: a redelivery of an event already settled.
    if (!wroteSomething) return;
    const amount = Math.max(recorded, chargeCumulative);

    await reverseEntitlements(
      ctx,
      { subject, reversedMinor: amount, reasonTag: 'refund' },
      tx,
    );

    // Only a one-time pack has an order to mark. A renewal has none, and the
    // order that opened a subscription is not what this refund was against —
    // marking it `refunded` because month seven came back would misreport the
    // purchase that is still perfectly good.
    if (order && !subject.invoiceId) {
      await setOrderStatus(
        {
          orderId: order.id,
          status: amount >= order.amount_minor ? 'refunded' : 'partially_refunded',
          refundedAmountMinor: amount,
        },
        tx,
      );
    }
  });
}

/**
 * A chargeback, and the one moment it costs something.
 *
 * A dispute being *opened* revokes nothing on purpose. We may still win, and
 * taking someone's credits while that is undecided punishes a customer who
 * turns out to be owed nothing. An operator is told, because a dispute is the
 * money movement most likely to need a human.
 *
 * A dispute being *lost* is a refund by another name — the money has gone back
 * and the goods it bought go with it — so it reverses entitlements through the
 * same function a refund does. One copy: the refund path was taught about
 * subscriptions and renewals, and a second copy here would have been the old
 * bug still sitting there under a different name.
 *
 * It also used to find the order by `stripe_payment_intent_id` alone, which a
 * subscription checkout never has, so a disputed subscription produced no row
 * and no signal whatsoever. `refundSubject` is what the refund path uses, and
 * it reaches a renewal that has no order at all.
 */
async function handleDispute(ctx: AppContext, event: StripeEventLike): Promise<void> {
  const obj = event.data.object;
  const chargeId = String(obj['charge'] ?? '');
  const subject = await refundSubject(obj, chargeId, obj['payment_intent']);
  if (!subject) {
    // Same reason as the refund path: a dispute we cannot attribute is still
    // money moving, and a bare `return` is how it passes unnoticed. A dispute
    // object carries a charge and no invoice, so this is the likelier of the
    // two to land here.
    await trackEvent({
      name: 'dispute_unattributed',
      userRef: null,
      props: {
        charge_id: chargeId || null,
        dispute_id: String(obj['id'] ?? '') || null,
        status: String(obj['status'] ?? ''),
        amount_minor: Math.abs(Number(obj['amount'] ?? 0)),
      },
      runMode: ctx.config.mode,
      isInternal: ctx.config.isDemo,
    }).catch(() => undefined);
    return;
  }

  const status = String(obj['status'] ?? 'needs_response');
  const amountMinor = Math.abs(Number(obj['amount'] ?? 0));
  const lost = event.type === 'charge.dispute.closed' && status === 'lost';

  await withTx(async (tx) => {
    const { inserted } = await recordPayment(
      {
        orderId: subject.order?.id ?? null,
        userId: subject.userId,
        kind: 'dispute',
        // Keyed on the dispute id plus its status, so the open and the close
        // are two rows: a redelivery of either is still a no-op, and the
        // revocation below runs exactly once.
        stripeObjectId: `${String(obj['id'] ?? '')}:${status}`,
        stripeInvoiceId: subject.invoiceId,
        amountMinor: -amountMinor,
        status,
        occurredAt: new Date(event.created * 1000),
      },
      tx,
    );
    if (!inserted) return;

    if (lost) {
      await reverseEntitlements(
        ctx,
        { subject, reversedMinor: amountMinor, reasonTag: 'dispute_lost' },
        tx,
      );
    }

    /*
     * Every other handler in this file emits an event; this one wrote a row and
     * said nothing, so a chargeback was the one money movement with no operator
     * signal at all. Both ends are reported: an opening needs a response, and a
     * close is when the money settled one way or the other.
     */
    await trackEvent(
      {
        name: 'payment_disputed',
        userRef: subject.userId,
        props: {
          order_id: subject.order?.id ?? null,
          invoice_id: subject.invoiceId,
          dispute_status: status,
          closed: event.type === 'charge.dispute.closed',
          entitlements_reversed: lost,
        },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      },
      tx,
    );
  });
}

/**
 * The service period from the invoice's own line item.
 *
 * On a subscription invoice this is the real period — unlike the invoice-level
 * `period_start`/`period_end`, which are degenerate on a first invoice. It is
 * read before falling back to an inference because it costs nothing and is
 * authoritative when present.
 */
function invoiceLinePeriod(invoice: Record<string, unknown>): { start: Date | null; end: Date | null } {
  const first = (invoice['lines'] as { data?: Array<Record<string, unknown>> } | undefined)?.data?.[0];
  const period = first?.['period'] as Record<string, unknown> | undefined;
  return { start: numberToDate(period?.['start']), end: numberToDate(period?.['end']) };
}

function numberToDate(v: unknown): Date | null {
  return typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000) : null;
}

/**
 * Reconciliation sweep: orders the provider settled and never told us about.
 *
 * `recoverUngrantedOrders` below starts from `status = 'paid'`, so it can only
 * repair a payment we already heard about. When the *notification* is what went
 * missing, the order stays `pending` while the money is gone, nothing counts it,
 * and the alarm built for this case (`UngrantedPaidOrders`) reads zero because
 * that is literally true. Reproduced against the sandbox by stopping
 * `stripe listen` and paying: Stripe said `complete` / `paid`, we said
 * `pending`, and every signal was green.
 *
 * Stripe retries for about three days, so reaching this state needs a longer
 * outage — or an endpoint that answers 2xx and drops the event, which is a
 * deploy bug rather than an outage. The charge has already happened in both.
 *
 * This deliberately does **not** re-implement settlement. It re-reads the
 * session from the provider and hands the existing handler an event carrying
 * only the session id: `handleCheckoutCompleted` already prefers the live
 * object over the payload for every field it needs, so one code path settles a
 * checkout whether the news arrived by webhook or by sweep. The idempotency
 * that protects a redelivered webhook — order status transitions, and the
 * business key on `entitlement_batches (user, source, source_ref)` — protects
 * this identically.
 *
 * `olderThanSeconds` keeps the sweep away from deliveries that are merely in
 * flight; the worker passes a window measured in minutes, and tests pass 0.
 */
export async function reconcilePendingCheckouts(
  ctx: AppContext,
  olderThanSeconds: number,
  limit = 50,
): Promise<number> {
  const orders = await listStalePendingCheckouts(olderThanSeconds, limit);
  let settled = 0;

  for (const order of orders) {
    const sessionId = order.stripe_checkout_session_id;
    if (!sessionId) continue;

    /*
     * One order's failure must not end the sweep.
     *
     * `handleCheckoutCompleted` throws on an amount or currency mismatch, by
     * design — it refuses to settle a charge that disagrees with the
     * catalogue. Without this try that throw propagated out of the loop and
     * out of `maintenanceLoop`'s single try, and because the query is
     * `ORDER BY created_at` the same oldest order was picked first every
     * minute: one poison order stopped the checkout sweep, the subscription
     * sweep, the retention sweep and the ledger reconciliation, for good.
     */
    try {
      const live = await ctx.payments.retrieveCheckoutSession(sessionId);
      // A provider we cannot reach is not evidence of anything. Leave the order
      // alone and let the next sweep ask again.
      if (!live) continue;

      if (live.paymentStatus === 'paid') {
        await handleCheckoutCompleted(ctx, {
          id: `reconcile:${sessionId}`,
          type: 'checkout.session.completed',
          created: Math.floor(Date.now() / 1000),
          data: { object: { id: sessionId } },
        });
        settled += 1;
      } else if (live.status === 'expired') {
        // The customer never paid and never will on this session. Closing it
        // keeps the sweep's working set from growing without bound.
        await setOrderStatus({ orderId: order.id, status: 'canceled' });
      }
    } catch (err) {
      /*
       * `.catch`, and it matters: this is a database write, and the likeliest
       * reason the block above threw is that the database is unwell. A
       * reporter that throws here would propagate out of the per-order try —
       * the error path reintroducing the exact failure the isolation exists to
       * contain — and silence the sweep for every order behind this one.
       */
      await trackEvent({
        name: 'reconcile_checkout_failed',
        userRef: order.user_id,
        props: { order_id: order.id, session_id: sessionId, error: describeError(err) },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch(() => undefined);
    }
  }

  return settled;
}

/**
 * Recovery sweep for subscriptions whose `invoice.paid` never arrived.
 *
 * A subscription's money and its goods are settled by two different events:
 * `checkout.session.completed` marks the order paid and deliberately grants
 * nothing (PAY-06 — granting in both places would double it), and `invoice.paid`
 * hands over the period's credits. Lose the second and the subscriber has paid
 * and received nothing, with no repair anywhere:
 *
 *   - `recoverUngrantedOrders` finds the order and skips it — `continue` on
 *     `product.kind !== 'one_time'`.
 *   - `reconcilePendingCheckouts` replays the checkout, which for a
 *     subscription grants nothing by design.
 *   - `subscription_period` batches are created in exactly one place in this
 *     repository, inside `handleInvoicePaid`.
 *
 * So the order sat in `listUngrantedPaidOrders` forever, which is also the
 * query behind the `UngrantedPaidOrders` alarm: it fires above zero, and with
 * no path back it would have stayed red. `a0d355d` fixed the invoice we
 * misread; this is the invoice that never comes, which `reconcile-pending`
 * proved is reachable by stopping the listener.
 *
 * Like the checkout sweep, this does **not** re-implement settlement. It grants
 * under the same business key the webhook would have used —
 * `<subscriptionId>:<latestInvoiceId>` — so a delivery that turns up late finds
 * the batch already there and changes nothing. That shared key is the whole
 * design: a recovery path that invented its own key would be a second source of
 * truth and would double-grant the day both arrived.
 *
 * The subscription row is written too. `customer.subscription.created` is lost
 * in the same outage, and without that row `getActiveSubscription` finds
 * nothing, so `SUBSCRIPTION_ALREADY_ACTIVE` never fires and the subscriber can
 * buy a second subscription.
 */
export async function reconcileUngrantedSubscriptions(ctx: AppContext, limit = 50): Promise<number> {
  const orders = await listUngrantedPaidOrders(limit);
  let repaired = 0;

  for (const order of orders) {
    // Per order, for the reason given in `reconcilePendingCheckouts`: this
    // sweep is the only repair for a lost `invoice.paid`, so one order that
    // throws must not stop it reaching the others.
    try {
      repaired += await reconcileOneSubscription(ctx, order);
    } catch (err) {
      // `.catch` for the reason given in `reconcilePendingCheckouts`: recording
      // a failure must not be able to cause one.
      await trackEvent({
        name: 'reconcile_subscription_failed',
        userRef: order.user_id,
        props: { order_id: order.id, error: describeError(err) },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch(() => undefined);
    }
  }

  return repaired;
}

async function reconcileOneSubscription(ctx: AppContext, order: OrderRow): Promise<number> {
  {
    const product = await getProductVersion(order.price_key, order.price_version);
    if (!product || product.kind !== 'subscription') return 0;

    const sessionId = order.stripe_checkout_session_id;
    if (!sessionId) return 0;

    // The order does not store the subscription id — it is created by the
    // provider when the checkout completes — so it comes from the session.
    const session = await ctx.payments.retrieveCheckoutSession(sessionId);
    const subscriptionId = session?.subscriptionId;
    if (!subscriptionId) return 0;

    const live = await ctx.payments.retrieveSubscription(subscriptionId);
    // A provider we cannot reach is not evidence of anything; the next sweep
    // asks again.
    if (!live) return 0;
    // Only a subscription that is actually running has bought a period. An
    // `incomplete` or `past_due` one has not, and guessing here would hand out
    // credits for money that never arrived.
    if (live.status !== 'active' && live.status !== 'trialing') return 0;

    const invoiceId = live.latestInvoiceId;
    // Without the invoice id there is no shared key, and a key of our own
    // invention would double-grant when the real event lands.
    if (!invoiceId) return 0;
    // A subscription batch that never expires is a different bug from one that
    // is missing: unused units are not supposed to carry over (§11 / UI-10).
    // Leaving it ungranted keeps it visible in the alarm, which is where an
    // unexplained subscription belongs.
    if (!live.currentPeriodEnd) return 0;

    // Counted after the transaction commits. Incrementing inside it would log a
    // repair that a rollback then undid.
    let granted = false;
    await withTx(async (tx) => {
      await upsertSubscription(
        {
          userId: order.user_id,
          stripeSubscriptionId: subscriptionId,
          stripeCustomerId: live.customerId,
          priceKey: order.price_key,
          priceVersion: order.price_version,
          status: live.status as SubscriptionStatus,
          currentPeriodStart: live.currentPeriodStart,
          currentPeriodEnd: live.currentPeriodEnd,
          cancelAtPeriodEnd: live.cancelAtPeriodEnd,
          canceledAt: live.canceledAt,
          latestInvoiceId: invoiceId,
          // Dated at the payment, not at the sweep. `upsertSubscription` keeps
          // the newest event, and stamping this "now" would make the real
          // events — whose `created` is back at the payment — lose to a repair
          // built from less information than they carry.
          eventAt: order.paid_at ?? order.created_at,
        },
        tx,
      );

      const res = await grantUnits(
        {
          userId: order.user_id,
          source: 'subscription_period',
          sourceRef: `${subscriptionId}:${invoiceId}`,
          units: product.units,
          productKey: product.price_key,
          priceVersion: product.version,
          effectiveFrom: live.currentPeriodStart ?? order.paid_at ?? new Date(),
          expiresAt: live.currentPeriodEnd,
          reason: `subscription_recovery:${invoiceId}`,
        },
        tx,
      );

      // Marked fulfilled whether or not this call created the batch: if it was
      // already there, the order is satisfied and only the record was missing.
      await markEntitlementGranted(order.id, tx);
      granted = res.created;
    });
    return granted ? 1 : 0;
  }
}

/**
 * Recovery sweep (PAY-11): orders that were charged but whose entitlement never
 * landed — a crash between the payment and the grant. Re-runs the grant, which
 * is idempotent, so this is safe to run repeatedly.
 */
export async function recoverUngrantedOrders(ctx: AppContext): Promise<number> {
  const orders = await listUngrantedPaidOrders(50);
  let repaired = 0;
  for (const order of orders) {
    /*
     * One order's failure must not end the sweep — the same rule the two
     * loops above state, and the one this loop did not follow.
     *
     * A stablecoin licence order was written without `creator_id`, so
     * `grantEntitlementForOrder` threw for it; with no guard here that single
     * row stopped the sweep for every other paid-but-undelivered order, card
     * and chain alike, on every run, for good. The metadata bug is fixed, and
     * this is the reason it could not have been contained.
     */
    try {
      repaired += (await recoverOneOrder(order)) ? 1 : 0;
    } catch (err) {
      /*
       * `.catch(() => undefined)` for the same reason the sibling sweep gives:
       * a reporter that throws here would propagate out of the per-order try
       * and silence the sweep for every order behind this one — the error path
       * reintroducing the failure the isolation exists to contain.
       */
      await trackEvent({
        name: 'order_recovery_failed',
        userRef: order.user_id,
        props: { order_id: order.id, price_key: order.price_key, error: describeError(err) },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      }).catch(() => undefined);
    }
  }
  return repaired;
}

async function recoverOneOrder(order: OrderRow): Promise<boolean> {
  {
    /*
     * The same `grantEntitlementForOrder` both payment channels run.
     *
     * This used to grant credits inline, filtered on `product.kind !==
     * 'one_time'` — and `market_license` IS kind 'one_time'. So a licence
     * order that reached this sweep was given one generation credit instead
     * of the licence it paid for, and then marked granted, so the licence
     * never arrived at all. Sharing the fulfilment path removes the second
     * implementation that could disagree with the first.
     *
     * It also means this sweep covers stablecoin settlements for free:
     * `listUngrantedPaidOrders` does not look at how an order was paid, and a
     * crash between confirming a payment and handing over what it bought
     * leaves exactly the row this query selects.
     */
    const product = await getProductVersion(order.price_key, order.price_version);
    if (!product) return false;
    if (product.kind !== 'one_time') return false;
    /*
     * The order is re-read inside the granting transaction, by
     * `fulfilPaidOrder`. It was trusted from the listed row instead, and the
     * list is read once for a batch of fifty: a refund arriving mid-sweep sets
     * the order to `refunded` and revokes nothing (the grant it was selected
     * for never landed), and this then granted credits against a refunded
     * order with nothing able to take them back.
     */
    return (await fulfilPaidOrder(order.id)) === 'delivered';
  }
}
