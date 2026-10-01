import type { SubscriptionStatus } from '@yuha/contracts';
import type { OrderRow } from '@yuha/db';
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
  queryOne,
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
   * An annual plan would be mis-served by this — recorded in docs/OPEN_ITEMS.md
   * rather than guessed at from the price key's spelling.
   */
  const INFERRED_PERIOD_DAYS = 31;
  const authoritativeEnd =
    live?.currentPeriodEnd ??
    sub?.current_period_end ??
    line.end ??
    (invoiceEnd && periodStart && invoiceEnd.getTime() > periodStart.getTime() ? invoiceEnd : null);
  const effectiveStart = periodStart ?? new Date();
  const periodEnd =
    authoritativeEnd ?? new Date(effectiveStart.getTime() + INFERRED_PERIOD_DAYS * 86400_000);
  const periodInferred = authoritativeEnd === null;
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

  const orders = await query<{ id: string; user_id: string; amount_minor: number }>(
    `SELECT id, user_id, amount_minor FROM orders
      WHERE stripe_payment_intent_id = ? OR id = ?
      LIMIT 1`,
    [typeof paymentIntent === 'string' ? paymentIntent : '', metaString(obj, 'order_id') ?? null],
  );
  const order = orders[0];
  if (!order) return;

  await withTx(async (tx) => {
    const occurredAt = new Date(event.created * 1000);
    let wroteSomething = false;
    for (const r of enumerated) {
      const { inserted } = await recordPayment(
        {
          orderId: order.id,
          userId: order.user_id,
          kind: 'refund',
          stripeObjectId: r.id,
          amountMinor: -r.amount,
          status: 'succeeded',
          occurredAt,
        },
        tx,
      );
      wroteSomething = wroteSomething || inserted;
    }

    const recordedSoFar = async (): Promise<number> => {
      const row = await queryOne<{ refunded: number }>(
        `SELECT COALESCE(-SUM(amount_minor), 0) AS refunded FROM payments
          WHERE order_id = ? AND kind = 'refund' AND status = 'succeeded'`,
        [order.id],
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
          orderId: order.id,
          userId: order.user_id,
          kind: 'refund',
          stripeObjectId: `${chargeId}:cumulative:${chargeCumulative}`,
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

    const batches = await query<{ id: string; granted_units: number }>(
      `SELECT id, granted_units FROM entitlement_batches
        WHERE user_id = ? AND source = 'one_time_order' AND source_ref = ?`,
      [order.user_id, order.id],
      tx,
    );
    for (const b of batches) {
      /*
       * How much of the pack the refund actually paid back.
       *
       * This used to revoke every unused unit regardless of amount, so a ¥300
       * refund on a ¥980 DROP took back all five songs: 30% of the money
       * returned and 100% of the goods gone, leaving the buyer ¥680 down with
       * nothing. The order was already being written as `partially_refunded`,
       * so the distinction existed everywhere except here.
       *
       * `amount` is the cumulative `amount_refunded` from the charge where
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
      if (order.amount_minor > 0 && amount > 0 && amount < order.amount_minor) {
        // Floored, so rounding leaves the buyer holding slightly more than the
        // surviving payment strictly buys. The other direction takes songs from
        // someone who still paid for them.
        const target = Math.floor((originalUnits * amount) / order.amount_minor);
        maxUnits = Math.max(0, target - alreadyRevoked);
      }

      const res = await revokeUnusedUnits(
        { userId: order.user_id, batchId: b.id, reason: `refund:${order.id}`, maxUnits },
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
        status: amount >= order.amount_minor ? 'refunded' : 'partially_refunded',
        refundedAmountMinor: amount,
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
  const { inserted } = await recordPayment({
    orderId: order.id,
    userId: order.user_id,
    kind: 'dispute',
    stripeObjectId: String(obj['id'] ?? ''),
    amountMinor: -Number(obj['amount'] ?? 0),
    status: String(obj['status'] ?? 'needs_response'),
    occurredAt: new Date(event.created * 1000),
  });

  /*
   * Every other handler in this file emits an event; this one wrote a row and
   * said nothing, so a chargeback — money reversed, credits kept, and unlike a
   * refund no entitlement touched anywhere — was the one money movement with
   * no operator signal at all. Whether a disputed period should be clawed back
   * is a decision for a person, which is exactly why a person has to be told.
   */
  if (inserted) {
    await trackEvent({
      name: 'payment_disputed',
      userRef: order.user_id,
      props: {
        order_id: order.id,
        dispute_status: String(obj['status'] ?? 'needs_response'),
        amount_minor: Number(obj['amount'] ?? 0),
        reason: String(obj['reason'] ?? 'unknown'),
      },
      runMode: ctx.config.mode,
      isInternal: ctx.config.isDemo,
    });
  }
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
      await trackEvent({
        name: 'reconcile_checkout_failed',
        userRef: order.user_id,
        props: { order_id: order.id, session_id: sessionId, error: (err as Error).message },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      });
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
      await trackEvent({
        name: 'reconcile_subscription_failed',
        userRef: order.user_id,
        props: { order_id: order.id, error: (err as Error).message },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      });
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
