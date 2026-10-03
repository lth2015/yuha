import type { PoolConnection } from 'mysql2/promise';
import type { OrderKind, OrderStatus, SubscriptionStatus } from '@yuha/contracts';
import { execute, newId, query, queryOne, toJson } from './pool.js';

export interface ProductRow {
  price_key: string;
  version: number;
  kind: OrderKind;
  display_name: string;
  amount_minor: number;
  currency: string;
  tax_included: boolean;
  units: number;
  validity_days: number | null;
  auto_renew: boolean;
  /** How often it bills. NULL for one_time, which does not bill again. */
  billing_interval: BillingInterval | null;
  stripe_price_id: string | null;
  active: boolean;
}

export type BillingInterval = 'month' | 'year';

/**
 * How long to call a subscription period when nothing authoritative says.
 *
 * Only reached when Stripe's own period end is missing — a moved invoice
 * shape, a reconstructed event — and the alternative is a batch that never
 * expires. It errs long on purpose: a batch living a few days past its period
 * is a bounded error in the customer's favour, where ending early takes
 * something they paid for. The next invoice grants the next period under its
 * own key regardless, so the error never compounds.
 *
 * This was a flat 31 days, correct only because every plan in the catalogue is
 * monthly. An unknown cadence still lands there rather than producing NaN and
 * an Invalid Date on the grant path — a value out of the database is a string,
 * and this runs where a subscriber is waiting for credits.
 */
export function inferredPeriodDays(interval: string | null | undefined): number {
  return interval === 'year' ? 366 : 31;
}

const PRODUCT_COLUMNS = `
  price_key, version, kind, display_name, amount_minor, currency, tax_included,
  units, validity_days, auto_renew, billing_interval, stripe_price_id, active
`;

/** Current sellable version of a product. Existing orders keep their own version (UI-10). */
export async function getActiveProduct(
  priceKey: string,
  tx?: PoolConnection,
): Promise<ProductRow | undefined> {
  return queryOne<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM product_catalog
      WHERE price_key = ? AND active = 1
      ORDER BY version DESC LIMIT 1`,
    [priceKey],
    tx,
  );
}

export async function getProductVersion(
  priceKey: string,
  version: number,
  tx?: PoolConnection,
): Promise<ProductRow | undefined> {
  return queryOne<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM product_catalog WHERE price_key = ? AND version = ?`,
    [priceKey, version],
    tx,
  );
}

export async function listActiveProducts(): Promise<ProductRow[]> {
  // MySQL has no DISTINCT ON; a window function picks the newest active version.
  return query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY price_key ORDER BY version DESC) AS rn
         FROM product_catalog WHERE active = 1
     ) ranked
     WHERE rn = 1
     ORDER BY price_key`,
  );
}

/**
 * Writes a catalogue version, refusing to change what a version means.
 *
 * `amount_minor`, `currency`, `units` and `validity_days` are deliberately
 * not in the UPDATE list: a version is the frozen commercial terms an order
 * was placed against. `stripe_price_id` *is* updated, though, and that is the
 * hole — Stripe Prices are immutable, so raising a price means pointing at a
 * new Price object, and re-running the seed with the same version number left
 * `product_catalog` saying 980 beside a Stripe Price of 1280.
 *
 * Every checkout for that key then charged the new amount and
 * `handleCheckoutCompleted` threw on the amount-mismatch guard — *before* its
 * transaction, so `markOrderPaid` never ran: the order stayed `pending` with
 * the money taken and nothing granted, for every buyer, until somebody
 * noticed. The guard is right to refuse; the catalogue should not have been
 * able to disagree with the provider in the first place.
 *
 * So this now refuses rather than silently repointing. Changing what a
 * customer is charged means a new version, which is what versions are for.
 */
export async function upsertProduct(p: ProductRow, tx?: PoolConnection): Promise<void> {
  const existing = await queryOne<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM product_catalog WHERE price_key = ? AND version = ?`,
    [p.price_key, p.version],
    tx,
  );
  if (existing) {
    const changed: string[] = [];
    if (Number(existing.amount_minor) !== Number(p.amount_minor)) {
      changed.push(`amount_minor ${existing.amount_minor} -> ${p.amount_minor}`);
    }
    if (existing.currency !== p.currency) changed.push(`currency ${existing.currency} -> ${p.currency}`);
    if (Number(existing.units) !== Number(p.units)) changed.push(`units ${existing.units} -> ${p.units}`);
    if ((existing.validity_days ?? null) !== (p.validity_days ?? null)) {
      changed.push(`validity_days ${existing.validity_days} -> ${p.validity_days}`);
    }
    /*
     * Cadence is a commercial term, and for a subscription it is the one that
     * decides what the price buys. It was in neither this comparison nor the
     * UPDATE below when the column was added, so moving a plan from monthly to
     * annual under the same version would have been accepted silently and then
     * ignored — the row keeping its old interval while the seed said otherwise,
     * and `handleInvoicePaid` granting the length nobody meant.
     */
    if ((existing.billing_interval ?? null) !== (p.billing_interval ?? null)) {
      changed.push(`billing_interval ${existing.billing_interval} -> ${p.billing_interval}`);
    }
    if (changed.length) {
      throw new Error(
        `${p.price_key} version ${p.version} already exists with different commercial terms ` +
          `(${changed.join('; ')}). A version is what an order was placed against, so it cannot ` +
          `be redefined — add the next version instead.`,
      );
    }
  }
  await execute(
    `INSERT INTO product_catalog
       (price_key, version, kind, display_name, amount_minor, currency, tax_included,
        units, validity_days, auto_renew, billing_interval, stripe_price_id, active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       display_name = VALUES(display_name),
       stripe_price_id = VALUES(stripe_price_id),
       active = VALUES(active)`,
    [
      p.price_key,
      p.version,
      p.kind,
      p.display_name,
      p.amount_minor,
      p.currency,
      p.tax_included ? 1 : 0,
      p.units,
      p.validity_days,
      p.auto_renew ? 1 : 0,
      p.billing_interval,
      p.stripe_price_id,
      p.active ? 1 : 0,
    ],
    tx,
  );
}

// -------------------------------------------------------------------- orders

export interface OrderRow {
  id: string;
  user_id: string;
  price_key: string;
  price_version: number;
  kind: OrderKind;
  amount_minor: number;
  currency: string;
  status: OrderStatus;
  idempotency_key: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_customer_id: string | null;
  entitlement_granted_at: Date | null;
  paid_at: Date | null;
  receipt_url: string | null;
  refunded_amount_minor: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const ORDER_COLUMNS = `
  id, user_id, price_key, price_version, kind, amount_minor, currency, status,
  idempotency_key, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
  entitlement_granted_at, paid_at, receipt_url, refunded_amount_minor, metadata, created_at, updated_at
`;

export async function findOrderByIdempotencyKey(
  userId: string,
  key: string,
  tx?: PoolConnection,
): Promise<OrderRow | undefined> {
  return queryOne<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id = ? AND idempotency_key = ?`,
    [userId, key],
    tx,
  );
}

export async function insertOrder(
  params: {
    userId: string;
    priceKey: string;
    priceVersion: number;
    kind: OrderKind;
    amountMinor: number;
    currency?: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
  tx?: PoolConnection,
): Promise<OrderRow> {
  const id = newId();
  await execute(
    `INSERT INTO orders (id, user_id, price_key, price_version, kind, amount_minor, currency, idempotency_key, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.userId,
      params.priceKey,
      params.priceVersion,
      params.kind,
      params.amountMinor,
      params.currency ?? 'usd',
      params.idempotencyKey,
      toJson(params.metadata ?? {}),
    ],
    tx,
  );
  return (await getOrder(id, tx))!;
}

export async function getOrderForUser(
  id: string,
  userId: string,
  tx?: PoolConnection,
): Promise<OrderRow | undefined> {
  return queryOne<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ? AND user_id = ?`,
    [id, userId],
    tx,
  );
}

export async function getOrder(id: string, tx?: PoolConnection): Promise<OrderRow | undefined> {
  return queryOne<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`, [id], tx);
}

export async function findOrderBySession(
  sessionId: string,
  tx?: PoolConnection,
): Promise<OrderRow | undefined> {
  return queryOne<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE stripe_checkout_session_id = ?`,
    [sessionId],
    tx,
  );
}

export async function listOrders(
  userId: string,
  limit = 50,
): Promise<Array<OrderRow & { display_name: string | null }>> {
  // Joined on (price_key, version): the catalogue row as it was when bought,
  // so renaming or repricing a plan never rewrites an existing receipt.
  return query<OrderRow & { display_name: string | null }>(
    `SELECT ${ORDER_COLUMNS.split(',')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => `o.${c}`)
      .join(', ')},
            pc.display_name
       FROM orders o
       LEFT JOIN product_catalog pc
              ON pc.price_key = o.price_key AND pc.version = o.price_version
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
      LIMIT ?`,
    [userId, limit],
  );
}

export async function attachCheckoutSession(
  params: { orderId: string; sessionId: string; customerId?: string | null },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE orders SET stripe_checkout_session_id = ?,
                       stripe_customer_id = COALESCE(?, stripe_customer_id),
                       updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?`,
    [params.sessionId, params.customerId ?? null, params.orderId],
    tx,
  );
}

/**
 * Marks an order paid. Idempotent: returns `changed: false` if it was already
 * paid, so a duplicated `checkout.session.completed` grants nothing extra.
 * Callers must read `changed`, not `order` — `order` is a plain re-read and is
 * always truthy for an order that exists.
 *
 * `canceled` is accepted alongside `pending` and `failed`. An async payment
 * (konbini, bank transfer) can succeed after its checkout session expired and
 * `checkout.session.expired` canceled the order, and then the money has
 * genuinely arrived: refusing the transition left the goods granted against an
 * order reading `canceled` with `paid_at` null. A `paid` or `refunded` order is
 * still never touched.
 */
export async function markOrderPaid(
  params: {
    orderId: string;
    paymentIntentId?: string | null;
    receiptUrl?: string | null;
    customerId?: string | null;
  },
  tx: PoolConnection,
): Promise<{ order: OrderRow | undefined; changed: boolean }> {
  const res = await execute(
    `UPDATE orders SET status = 'paid',
                       paid_at = COALESCE(paid_at, UTC_TIMESTAMP(3)),
                       stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
                       receipt_url = COALESCE(?, receipt_url),
                       stripe_customer_id = COALESCE(?, stripe_customer_id),
                       updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND status IN ('pending', 'failed', 'canceled')`,
    [
      params.paymentIntentId ?? null,
      params.receiptUrl ?? null,
      params.customerId ?? null,
      params.orderId,
    ],
    tx,
  );
  const order = await getOrder(params.orderId, tx);
  return { order, changed: res.affectedRows > 0 };
}

export async function markEntitlementGranted(orderId: string, tx: PoolConnection): Promise<void> {
  await execute(
    `UPDATE orders SET entitlement_granted_at = COALESCE(entitlement_granted_at, UTC_TIMESTAMP(3)),
                       updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?`,
    [orderId],
    tx,
  );
}

export async function setOrderStatus(
  params: { orderId: string; status: OrderStatus; refundedAmountMinor?: number },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE orders SET status = ?,
                       refunded_amount_minor = COALESCE(?, refunded_amount_minor),
                       updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?`,
    [params.status, params.refundedAmountMinor ?? null, params.orderId],
    tx,
  );
}

/**
 * Orders still `pending` whose checkout session is old enough that a webhook
 * should have arrived by now.
 *
 * `listUngrantedPaidOrders` below cannot see these: it starts from
 * `status = 'paid'`, and an order only reaches `paid` because an event told us
 * so. When the event is the thing that went missing, the order sits at
 * `pending` with the money already taken, and every count built on "paid but
 * ungranted" reads zero. Found that way against the sandbox with the listener
 * stopped.
 *
 * `olderThanSeconds` is a grace window, not a nicety: without it the sweep
 * races deliveries that are merely in flight and calls Stripe for every
 * checkout anyone has open.
 */
export async function listStalePendingCheckouts(
  olderThanSeconds: number,
  limit = 50,
): Promise<OrderRow[]> {
  return query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders
      WHERE status = 'pending'
        AND stripe_checkout_session_id IS NOT NULL
        AND created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
      ORDER BY created_at
      LIMIT ?`,
    [olderThanSeconds, limit],
  );
}

/** Orders that were charged but whose entitlement never landed — PAY-11 recovery. */
export async function listUngrantedPaidOrders(limit = 100): Promise<OrderRow[]> {
  return query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders
      WHERE status = 'paid' AND entitlement_granted_at IS NULL
      ORDER BY paid_at
      LIMIT ?`,
    [limit],
  );
}

// ------------------------------------------------------------------ payments

export async function recordPayment(
  params: {
    orderId?: string | null;
    userId: string;
    kind: 'payment' | 'refund' | 'dispute' | 'fee';
    stripeObjectId: string;
    /**
     * The invoice this payment settled, when it settled one.
     *
     * A refund of a subscription period has to find the batch it granted, and
     * the batch's business key is `<subscription>:<invoice>`. A `refund.created`
     * carries only a charge, so without this there is no hop from the refund to
     * the period — which is how a refunded subscription kept its credits.
     */
    stripeInvoiceId?: string | null;
    amountMinor: number;
    feeMinor?: number;
    netMinor?: number;
    status: string;
    payoutId?: string | null;
    occurredAt: Date;
    raw?: Record<string, unknown>;
  },
  tx?: PoolConnection,
): Promise<{ inserted: boolean }> {
  const res = await execute(
    `INSERT IGNORE INTO payments
       (id, order_id, user_id, kind, stripe_object_id, stripe_invoice_id, amount_minor,
        fee_minor, net_minor, status, payout_id, occurred_at, raw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      newId(),
      params.orderId ?? null,
      params.userId,
      params.kind,
      params.stripeObjectId,
      params.stripeInvoiceId ?? null,
      params.amountMinor,
      params.feeMinor ?? 0,
      params.netMinor ?? 0,
      params.status,
      params.payoutId ?? null,
      params.occurredAt,
      toJson(params.raw ?? {}),
    ],
    tx,
  );
  return { inserted: res.affectedRows > 0 };
}

export async function listPayments(orderId: string): Promise<
  Array<{
    kind: string;
    stripe_object_id: string;
    amount_minor: number;
    fee_minor: number;
    net_minor: number;
    status: string;
    occurred_at: Date;
  }>
> {
  return query(
    `SELECT kind, stripe_object_id, amount_minor, fee_minor, net_minor, status, occurred_at
       FROM payments WHERE order_id = ? ORDER BY occurred_at`,
    [orderId],
  );
}

// ------------------------------------------------------------- subscriptions

export interface SubscriptionRow {
  id: string;
  user_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  price_key: string;
  price_version: number;
  status: SubscriptionStatus;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  latest_invoice_id: string | null;
  last_event_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SUB_COLUMNS = `
  id, user_id, stripe_subscription_id, stripe_customer_id, price_key, price_version,
  status, current_period_start, current_period_end, cancel_at_period_end, canceled_at,
  latest_invoice_id, last_event_at, created_at, updated_at
`;

/**
 * Upserts subscription state from a webhook.
 *
 * PAY-05: `last_event_at` is a monotonic guard — an event older than the state
 * we already stored is ignored rather than overwriting newer status. MySQL has
 * no conditional DO UPDATE, so the guard is expressed with IF() over each
 * column: when the incoming event is stale, every column keeps its old value.
 */
export async function upsertSubscription(
  params: {
    userId: string;
    stripeSubscriptionId: string;
    stripeCustomerId: string;
    priceKey: string;
    priceVersion: number;
    status: SubscriptionStatus;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    canceledAt?: Date | null;
    latestInvoiceId?: string | null;
    eventAt: Date;
  },
  tx: PoolConnection,
): Promise<{ subscription: SubscriptionRow; applied: boolean }> {
  // Read the stored watermark inside the same transaction, so the reported
  // `applied` flag reflects whether THIS event won rather than merely whether
  // some event has been applied. The SQL guard below is still the enforcement.
  const before = await findSubscriptionByStripeId(params.stripeSubscriptionId, tx);
  const willApply =
    !before || before.last_event_at === null || before.last_event_at <= params.eventAt;

  const fresh = 'subscriptions.last_event_at IS NULL OR subscriptions.last_event_at <= VALUES(last_event_at)';
  await execute(
    `INSERT INTO subscriptions
       (id, user_id, stripe_subscription_id, stripe_customer_id, price_key, price_version, status,
        current_period_start, current_period_end, cancel_at_period_end, canceled_at,
        latest_invoice_id, last_event_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       status               = IF(${fresh}, VALUES(status),               subscriptions.status),
       current_period_start = IF(${fresh}, VALUES(current_period_start), subscriptions.current_period_start),
       current_period_end   = IF(${fresh}, VALUES(current_period_end),   subscriptions.current_period_end),
       cancel_at_period_end = IF(${fresh}, VALUES(cancel_at_period_end), subscriptions.cancel_at_period_end),
       canceled_at          = IF(${fresh}, COALESCE(VALUES(canceled_at), subscriptions.canceled_at),
                                           subscriptions.canceled_at),
       latest_invoice_id    = IF(${fresh}, COALESCE(VALUES(latest_invoice_id), subscriptions.latest_invoice_id),
                                           subscriptions.latest_invoice_id),
       updated_at           = IF(${fresh}, UTC_TIMESTAMP(3), subscriptions.updated_at),
       last_event_at        = IF(${fresh}, VALUES(last_event_at), subscriptions.last_event_at)`,
    [
      newId(),
      params.userId,
      params.stripeSubscriptionId,
      params.stripeCustomerId,
      params.priceKey,
      params.priceVersion,
      params.status,
      params.currentPeriodStart,
      params.currentPeriodEnd,
      params.cancelAtPeriodEnd ? 1 : 0,
      params.canceledAt ?? null,
      params.latestInvoiceId ?? null,
      params.eventAt,
    ],
    tx,
  );

  const current = (await findSubscriptionByStripeId(params.stripeSubscriptionId, tx))!;
  return { subscription: current, applied: willApply };
}

export async function getSubscriptionForUser(
  id: string,
  userId: string,
  tx?: PoolConnection,
): Promise<SubscriptionRow | undefined> {
  return queryOne<SubscriptionRow>(
    `SELECT ${SUB_COLUMNS} FROM subscriptions WHERE id = ? AND user_id = ?`,
    [id, userId],
    tx,
  );
}

export async function getActiveSubscription(
  userId: string,
  tx?: PoolConnection,
): Promise<SubscriptionRow | undefined> {
  return queryOne<SubscriptionRow>(
    `SELECT ${SUB_COLUMNS} FROM subscriptions
      WHERE user_id = ? AND status IN ('active','trialing','past_due')
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
    tx,
  );
}

export async function findSubscriptionByStripeId(
  stripeId: string,
  tx?: PoolConnection,
): Promise<SubscriptionRow | undefined> {
  return queryOne<SubscriptionRow>(
    `SELECT ${SUB_COLUMNS} FROM subscriptions WHERE stripe_subscription_id = ?`,
    [stripeId],
    tx,
  );
}

export async function setCancelAtPeriodEnd(
  params: { subscriptionId: string; cancelAtPeriodEnd: boolean },
  tx?: PoolConnection,
): Promise<SubscriptionRow | undefined> {
  await execute(
    `UPDATE subscriptions SET cancel_at_period_end = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
    [params.cancelAtPeriodEnd ? 1 : 0, params.subscriptionId],
    tx,
  );
  return queryOne<SubscriptionRow>(
    `SELECT ${SUB_COLUMNS} FROM subscriptions WHERE id = ?`,
    [params.subscriptionId],
    tx,
  );
}
