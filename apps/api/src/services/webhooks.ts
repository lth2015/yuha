import type { SubscriptionStatus } from '@yuha/contracts';
import {
  finishWebhookEvent,
  getActiveProduct,
  getOrder,
  getProductVersion,
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
  type WebhookEventRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';

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
        await handleDispute(ctx, event);
        break;
      default:
        await finishWebhookEvent({ id: row.id, status: 'ignored', error: null });
        return;
    }
    await finishWebhookEvent({ id: row.id, status: 'processed', error: null });
  } catch (err) {
    await finishWebhookEvent({ id: row.id, status: 'failed', error: (err as Error).message });
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
    const { order: updated } = await markOrderPaid(
      {
        orderId: order.id,
        paymentIntentId: live?.paymentIntentId ?? (session['payment_intent'] as string | null),
        receiptUrl: (session['receipt_url'] as string | null) ?? null,
        customerId: live?.customerId ?? (session['customer'] as string | null),
      },
      tx,
    );
    if (!updated) return;

    const product = await getProductVersion(updated.price_key, updated.price_version, tx);
    if (!product) throw new Error(`unknown product version ${updated.price_key}@${updated.price_version}`);

    // A subscription's first period is granted by invoice.paid, keyed on the
    // invoice, so the checkout event must not also grant one (PAY-06).
    if (product.price_key === 'market_license') {
      // Market sale: no credits — the buyer receives a per-track license and
      // the creator accrues their share, both idempotent on the order id.
      const trackId = (updated.metadata['track_id'] as string | undefined) ?? null;
      const creatorId = (updated.metadata['creator_id'] as string | undefined) ?? null;
      if (!trackId || !creatorId) {
        throw new Error(`market license order ${updated.id} is missing track/creator metadata`);
      }
      await grantLicense(
        {
          trackId,
          buyerId: updated.user_id,
          creatorId,
          orderId: updated.id,
          pricePaid: updated.amount_minor,
          currency: updated.currency,
        },
        tx,
      );
      await markEntitlementGranted(updated.id, tx);
    } else if (product.kind === 'one_time') {
      await grantUnits(
        {
          userId: updated.user_id,
          source: 'one_time_order',
          sourceRef: updated.id,
          units: product.units,
          productKey: product.price_key,
          priceVersion: product.version,
          expiresAt: product.validity_days
            ? new Date(Date.now() + product.validity_days * 86400_000)
            : null,
          reason: `order_paid:${updated.id}`,
        },
        tx,
      );
      await markEntitlementGranted(updated.id, tx);
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
  const periodStart =
    live?.currentPeriodStart ?? sub?.current_period_start ?? numberToDate(invoice['period_start']);
  const invoiceEnd = numberToDate(invoice['period_end']);
  const periodEnd =
    live?.currentPeriodEnd ??
    sub?.current_period_end ??
    (invoiceEnd && periodStart && invoiceEnd.getTime() > periodStart.getTime() ? invoiceEnd : null);
  const invoiceId = String(invoice['id'] ?? '');

  const priceKey = sub?.price_key ?? invoiceMeta(invoice, 'price_key') ?? 'creator_monthly';
  const product =
    (sub ? await getProductVersion(priceKey, sub.price_version) : null) ?? (await getActiveProduct(priceKey));
  if (!product) throw new Error(`unknown subscription product ${priceKey}`);

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
        effectiveFrom: periodStart ?? new Date(),
        expiresAt: periodEnd,
        reason: `subscription_invoice_paid:${invoiceId}`,
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
        props: { invoice_id: invoiceId },
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
  const subscriptionId = invoice['subscription'];
  if (typeof subscriptionId !== 'string') return;
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
async function handleRefund(ctx: AppContext, event: StripeEventLike): Promise<void> {
  const obj = event.data.object;
  const chargeId = String(obj['charge'] ?? obj['id'] ?? '');
  const paymentIntent = obj['payment_intent'];
  const amount = Number(obj['amount_refunded'] ?? obj['amount'] ?? 0);
  if (!chargeId) return;

  const orders = await query<{ id: string; user_id: string; amount_minor: number }>(
    `SELECT id, user_id, amount_minor FROM orders
      WHERE stripe_payment_intent_id = ? OR id = ?
      LIMIT 1`,
    [typeof paymentIntent === 'string' ? paymentIntent : '', metaString(obj, 'order_id') ?? null],
  );
  const order = orders[0];
  if (!order) return;

  await withTx(async (tx) => {
    const { inserted } = await recordPayment(
      {
        orderId: order.id,
        userId: order.user_id,
        kind: 'refund',
        stripeObjectId: String(obj['id'] ?? chargeId),
        amountMinor: -Math.abs(amount),
        status: 'succeeded',
        occurredAt: new Date(event.created * 1000),
      },
      tx,
    );
    // Refunds are idempotent by the refund object id.
    if (!inserted) return;

    const batches = await query<{ id: string }>(
      `SELECT id FROM entitlement_batches
        WHERE user_id = ? AND source = 'one_time_order' AND source_ref = ?`,
      [order.user_id, order.id],
      tx,
    );
    for (const b of batches) {
      const res = await revokeUnusedUnits(
        { userId: order.user_id, batchId: b.id, reason: `refund:${order.id}` },
        tx,
      );
      if (res.remainingReserved > 0 || res.remainingConsumed > 0) {
        // Already-fulfilled or in-flight units are flagged for a human, not
        // clawed back automatically.
        await trackEvent(
          {
            name: 'refund_partial_fulfilment',
            userRef: order.user_id,
            props: {
              order_id: order.id,
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

    await setOrderStatus(
      {
        orderId: order.id,
        status: Math.abs(amount) >= order.amount_minor ? 'refunded' : 'partially_refunded',
        refundedAmountMinor: Math.abs(amount),
      },
      tx,
    );
  });
}

async function handleDispute(ctx: AppContext, event: StripeEventLike): Promise<void> {
  const obj = event.data.object;
  const paymentIntent = obj['payment_intent'];
  const orders = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM orders WHERE stripe_payment_intent_id = ? LIMIT 1`,
    [typeof paymentIntent === 'string' ? paymentIntent : ''],
  );
  const order = orders[0];
  if (!order) return;
  await recordPayment({
    orderId: order.id,
    userId: order.user_id,
    kind: 'dispute',
    stripeObjectId: String(obj['id'] ?? ''),
    amountMinor: -Number(obj['amount'] ?? 0),
    status: String(obj['status'] ?? 'needs_response'),
    occurredAt: new Date(event.created * 1000),
  });
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
  }

  return settled;
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
    const product = await getProductVersion(order.price_key, order.price_version);
    if (!product || product.kind !== 'one_time') continue;
    await withTx(async (tx) => {
      const res = await grantUnits(
        {
          userId: order.user_id,
          source: 'one_time_order',
          sourceRef: order.id,
          units: product.units,
          productKey: product.price_key,
          priceVersion: product.version,
          expiresAt: product.validity_days ? new Date(Date.now() + product.validity_days * 86400_000) : null,
          reason: `order_recovery:${order.id}`,
        },
        tx,
      );
      await markEntitlementGranted(order.id, tx);
      if (res.created) repaired += 1;
    });
  }
  return repaired;
}
