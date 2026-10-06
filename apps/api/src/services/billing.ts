import { AppError, type EntitlementsView, type OrderView, type ProductView } from '@yuha/contracts';
import {
  getProductVersion,
  attachCheckoutSession,
  findOrderByIdempotencyKey,
  getActiveProduct,
  getActiveSubscription,
  getOrderForUser,
  getUser,
  grantUnits,
  insertOrder,
  listActiveProducts,
  listBatches,
  getBalance,
  setCancelAtPeriodEnd,
  getSubscriptionForUser,
  trackEvent,
  withTx,
  type ProductRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';

export function toProductView(row: ProductRow, available: boolean): ProductView {
  return {
    priceKey: row.price_key as ProductView['priceKey'],
    priceVersion: row.version,
    kind: row.kind,
    displayName: row.display_name,
    amountMinor: row.amount_minor,
    currency: row.currency as ProductView['currency'],
    taxIncluded: true,
    units: row.units,
    validityDays: row.validity_days,
    autoRenew: row.auto_renew,
    available,
  };
}

export async function listProducts(ctx: AppContext): Promise<ProductView[]> {
  const features = await ctx.features();
  const rows = await listActiveProducts();
  return rows.map((r) =>
    // Subscriptions are fully built but stay closed to the public until the
    // repeat-purchase threshold is met (§7).
    toProductView(r, r.kind === 'subscription' ? features.subscriptionsEnabled : true),
  );
}

/**
 * Creates a checkout session.
 *
 * PAY-01: amount, currency and Stripe price id are read from the server-side
 * catalogue by price key. Nothing about the money comes from the client, so a
 * tampered request cannot change what is charged.
 */
/**
 * §9: one active payment channel per order.
 *
 * The stablecoin path refuses an order the card path has claimed; this is the
 * other direction, and it has to exist here too or an order could carry a live
 * Stripe session and a live on-chain intent at once. If both then actually
 * settled, the second becomes a duplicate-payment refund — and the entitlement
 * must still be granted exactly once, which `entitlement_batches`'
 * (user, source, source_ref) uniqueness already guarantees.
 */
export function assertNotStablecoinClaimed(order: { payment_method: string | null }): void {
  if (order.payment_method === 'stablecoin') {
    throw new AppError(
      'CONFLICT',
      'this order is being paid in stablecoin; cancel that payment before paying by card',
    );
  }
}

export async function createCheckout(
  ctx: AppContext,
  params: {
    userId: string;
    priceKey: string;
    idempotencyKey: string;
    successPath?: string;
    cancelPath?: string;
  },
): Promise<{ orderId: string; checkoutUrl: string; simulated: boolean }> {
  const features = await ctx.features();
  const product = await getActiveProduct(params.priceKey);
  if (!product || !product.active) throw new AppError('NOT_FOUND', 'unknown product');
  if (product.kind === 'subscription' && !features.subscriptionsEnabled) {
    throw new AppError('SUBSCRIPTIONS_DISABLED', 'subscriptions are not open yet');
  }

  const user = await getUser(params.userId);
  if (!user) throw new AppError('UNAUTHENTICATED', 'user not found');
  if (!user.age_confirmed_at) {
    // Sales and generation are limited to confirmed 18+ users (§07 of the design doc).
    throw new AppError('AGE_NOT_CONFIRMED', 'age confirmation is required before purchase');
  }

  // Replaying the same key returns the same order — a double-clicked buy button
  // cannot create two orders or two Stripe sessions.
  const existing = await findOrderByIdempotencyKey(params.userId, params.idempotencyKey);
  /*
   * An idempotency key is scoped to (user, key) by `orders_idempotency_uk` and
   * nothing checked that the order it replays is for the thing being bought.
   * So a key first used for a DROP pack, reused later on a different purchase,
   * resumed that *same order row*: the Stripe session was built for the new
   * product while `orders.price_key` still named the old one, and
   * `handleCheckoutCompleted` resolves what to hand over from the order. Money
   * taken for one thing, the other thing delivered — and the amount-mismatch
   * guard cannot catch the pairing that matters, because `drop_5` and
   * `market_license` are both 980 jpy in the seeded catalogue.
   *
   * Stripe's own 24-hour idempotency window hides this while it lasts; after
   * that the key is free again.
   */
  if (existing && (existing.price_key !== product.price_key || existing.price_version !== product.version)) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'this idempotency key already belongs to an order for a different product',
      { existingPriceKey: existing.price_key, requestedPriceKey: product.price_key },
    );
  }
  if (existing) {
    assertNotStablecoinClaimed(existing);
    if (existing.stripe_checkout_session_id) {
      const session = await ctx.payments.retrieveCheckoutSession(existing.stripe_checkout_session_id);
      if (session && session.status === 'open') {
        return {
          orderId: existing.id,
          checkoutUrl: (existing.metadata['checkout_url'] as string) ?? '',
          simulated: !ctx.payments.realCharges,
        };
      }
    }
    if (existing.status === 'paid') throw new AppError('CONFLICT', 'this order has already been paid');
  }

  const activeSub = await getActiveSubscription(params.userId);

  /*
   * A second subscription is a duplicate charge, not an upgrade.
   *
   * `activeSub` was read only to reuse the Stripe customer, so a subscriber
   * who pressed a different plan's button got a second live subscription and
   * two monthly invoices. Stripe creates it happily; nothing downstream
   * merges them.
   *
   * Placed after the idempotency replay above and before `insertOrder`, so a
   * genuinely in-flight session can still be resumed while a new purchase is
   * refused before anything is written. The first draft of this sat below
   * `insertOrder` with a comment claiming no order row was created — the test
   * that counts orders is what caught it.
   *
   * Changing plan or stopping goes through the existing management flow at
   * /settings/billing, which is what `SUBSCRIPTION_ALREADY_ACTIVE` points at.
   * One-time packs are unaffected: buying credits while subscribed is normal.
   */
  if (product.kind === 'subscription' && activeSub) {
    throw new AppError(
      'SUBSCRIPTION_ALREADY_ACTIVE',
      'this account already has an active subscription; change or cancel it from billing',
      { currentPriceKey: activeSub.price_key, status: activeSub.status },
    );
  }

  const order =
    existing ??
    (await insertOrder({
      userId: params.userId,
      priceKey: product.price_key,
      priceVersion: product.version,
      kind: product.kind,
      amountMinor: product.amount_minor,
      currency: product.currency,
      idempotencyKey: params.idempotencyKey,
      metadata: { units: product.units, validity_days: product.validity_days },
    }));

  const session = await ctx.payments.createCheckout({
    orderId: order.id,
    userId: params.userId,
    userEmail: user.email,
    priceKey: product.price_key,
    priceVersion: product.version,
    amountMinor: product.amount_minor,
    currency: product.currency,
    stripePriceId: product.stripe_price_id,
    kind: product.kind,
    successUrl: `${ctx.config.PUBLIC_WEB_URL}${params.successPath ?? '/checkout/complete'}?order_id=${order.id}`,
    cancelUrl: `${ctx.config.PUBLIC_WEB_URL}${params.cancelPath ?? '/pricing'}`,
    idempotencyKey: `${params.userId}:${params.idempotencyKey}`,
    existingCustomerId: activeSub?.stripe_customer_id ?? null,
  });

  await attachCheckoutSession({
    orderId: order.id,
    sessionId: session.sessionId,
    customerId: session.customerId,
  });

  await trackEvent({
    name: 'checkout_started',
    userRef: params.userId,
    props: { price_key: product.price_key, kind: product.kind },
    priceVersion: product.version,
    runMode: ctx.config.mode,
    isInternal: ctx.config.isDemo,
  });

  return { orderId: order.id, checkoutUrl: session.url, simulated: session.simulated };
}

/**
 * Order view for the success page.
 *
 * PAY-02: the browser landing on the success URL is not evidence of payment.
 * This reads server state only, and an unconfirmed order reports `pending` with
 * no entitlement granted.
 */
export async function getOrderView(userId: string, orderId: string): Promise<OrderView> {
  const order = await getOrderForUser(orderId, userId);
  if (!order) throw new AppError('NOT_FOUND', 'order not found');
  // The catalogue row as it was at purchase time, keyed on (key, version).
  const product = await getProductVersion(order.price_key, order.price_version);
  return {
    orderId: order.id,
    priceKey: order.price_key,
    displayName: product?.display_name ?? null,
    priceVersion: order.price_version,
    kind: order.kind,
    amountMinor: order.amount_minor,
    currency: order.currency,
    status: order.status,
    entitlementGranted: order.entitlement_granted_at !== null,
    createdAt: order.created_at.toISOString(),
    paidAt: order.paid_at?.toISOString() ?? null,
    receiptUrl: order.receipt_url,
  };
}

export async function getEntitlements(userId: string): Promise<EntitlementsView> {
  const [balance, batches, subscription] = await Promise.all([
    getBalance(userId),
    listBatches(userId),
    getActiveSubscription(userId),
  ]);

  return {
    availableUnits: balance.available,
    reservedUnits: balance.reserved,
    batches: batches.map((b) => ({
      batchId: b.id,
      source: b.source,
      grantedUnits: b.granted_units,
      reservedUnits: b.reserved_units,
      consumedUnits: b.consumed_units,
      availableUnits: b.granted_units - b.reserved_units - b.consumed_units,
      effectiveFrom: b.effective_from.toISOString(),
      expiresAt: b.expires_at?.toISOString() ?? null,
      productKey: b.product_key,
    })),
    subscription: subscription
      ? {
          subscriptionId: subscription.id,
          status: subscription.status,
          currentPeriodStart: subscription.current_period_start?.toISOString() ?? null,
          currentPeriodEnd: subscription.current_period_end?.toISOString() ?? null,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          endsAtJst: subscription.current_period_end ? toJst(subscription.current_period_end) : null,
        }
      : null,
  };
}

/** UTC instants are stored; JST is a presentation concern (§10 / UI-11). */
export function toJst(d: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/**
 * Cancels renewal at period end (PAY-08).
 *
 * The server call happens first; success is only reported after the payment
 * provider confirms. If the call fails, the subscription is left untouched and
 * the caller sees an error — the UI must not show "cancelled" optimistically.
 */
export async function cancelSubscription(
  ctx: AppContext,
  params: { userId: string; subscriptionId: string; idempotencyKey: string },
): Promise<{ subscriptionId: string; cancelAtPeriodEnd: boolean; effectiveAt: string | null }> {
  const sub = await getSubscriptionForUser(params.subscriptionId, params.userId);
  if (!sub) throw new AppError('SUBSCRIPTION_NOT_FOUND', 'subscription not found');

  // Idempotent: already cancelled is a success, not an error.
  if (sub.cancel_at_period_end) {
    return {
      subscriptionId: sub.id,
      cancelAtPeriodEnd: true,
      effectiveAt: sub.current_period_end?.toISOString() ?? null,
    };
  }

  const result = await ctx.payments.cancelSubscriptionAtPeriodEnd(
    sub.stripe_subscription_id,
    `${params.userId}:${params.idempotencyKey}`,
  );
  if (!result.cancelAtPeriodEnd) {
    throw new AppError('INTERNAL_ERROR', 'the payment provider did not confirm the cancellation');
  }

  await setCancelAtPeriodEnd({ subscriptionId: sub.id, cancelAtPeriodEnd: true });
  await trackEvent({
    name: 'subscription_cancelled',
    userRef: params.userId,
    runMode: ctx.config.mode,
    isInternal: ctx.config.isDemo,
  });

  return {
    subscriptionId: sub.id,
    cancelAtPeriodEnd: true,
    effectiveAt: (result.effectiveAt ?? sub.current_period_end)?.toISOString() ?? null,
  };
}

/** Grants the free-trial batch, if the operator has enabled it (§7: at most 2). */
/**
 * Whether a new account would actually receive the trial.
 *
 * The pricing page renders the free card from `runtime.features
 * .freeTrialEnabled`, which was only `FEATURE_FREE_TRIAL_ENABLED` — while the
 * grant below has a second condition. In production with a provider that has
 * no commercial-delivery clearance the page said "{n} welcome credits —
 * included with your account" and new accounts received nothing. One
 * predicate now, read by both, so the page cannot advertise a grant that will
 * not happen.
 */
export async function freeTrialAvailable(ctx: AppContext): Promise<boolean> {
  const features = await ctx.features();
  if (!features.freeTrialEnabled) return false;
  const caps = ctx.music.capabilities();
  if (!caps.commercialDeliveryPermitted && ctx.config.mode === 'production') return false;
  return true;
}

export async function grantTrialIfEligible(ctx: AppContext, userId: string): Promise<boolean> {
  if (!(await freeTrialAvailable(ctx))) return false;

  return withTx(async (tx) => {
    const res = await grantUnits(
      {
        userId,
        source: 'promo_trial',
        // One trial per account, enforced by the unique batch reference.
        sourceRef: `trial:${userId}`,
        units: ctx.config.FREE_TRIAL_UNITS,
        expiresAt: new Date(Date.now() + 30 * 86400_000),
        reason: 'free_trial_grant',
      },
      tx,
    );
    return res.created;
  });
}
