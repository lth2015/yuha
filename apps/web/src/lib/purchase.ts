import type { PaymentMethodKey, PaymentMethodView, ProductView, RuntimeInfo } from '@yuha/contracts';

/**
 * How a product can be paid for — read from the server, never decided here.
 *
 * docs/PAYMENTS_DESIGN.md is the rule and `apps/api/src/services/payment-methods.ts`
 * computes it into `ProductView.paymentMethods`. This file used to decide on
 * its own: a fallback chain per button ("card, else stablecoin, else closed")
 * plus a hardcoded list of the two price keys the wallet could pay for. That
 * is how the pricing grid ended up with "pay with JPYC" on one card and
 * "card payment is closed" on the two beside it — each button picking its own
 * channel, from rules the server held a different copy of.
 *
 * So the browser does three things only: list the methods it was given, say
 * whether any is available, and say why not when none is.
 */

/** A response from an API that has not rolled yet carries no methods: card only, as before. */
export function paymentMethodsOf(p: Pick<ProductView, 'paymentMethods'>): PaymentMethodView[] {
  return p.paymentMethods ?? [{ method: 'card', available: true, reason: null }];
}

export function firstAvailableMethod(p: Pick<ProductView, 'paymentMethods'>): PaymentMethodKey | null {
  return paymentMethodsOf(p).find((m) => m.available)?.method ?? null;
}

export function canBePaid(p: Pick<ProductView, 'paymentMethods'>): boolean {
  return firstAvailableMethod(p) !== null;
}

/**
 * Why nothing can pay for this, when nothing can. A subscription with only
 * stablecoins open says so (and points at top-up packs); otherwise it is the
 * card that is closed.
 */
export function unavailableReason(
  p: Pick<ProductView, 'paymentMethods'>,
): 'card_closed' | 'no_auto_renewal' | null {
  if (canBePaid(p)) return null;
  const methods = paymentMethodsOf(p);
  if (methods.some((m) => m.reason === 'no_auto_renewal')) return 'no_auto_renewal';
  return 'card_closed';
}

/** Every method open anywhere in a catalogue, for the one-line summary on the pricing page. */
export function methodsOpenAnywhere(products: Array<Pick<ProductView, 'paymentMethods'>>): PaymentMethodKey[] {
  const order: PaymentMethodKey[] = ['card', 'jpyc', 'usdc', 'netx'];
  const open = new Set(products.flatMap((p) => paymentMethodsOf(p).filter((m) => m.available).map((m) => m.method)));
  return order.filter((k) => open.has(k));
}

/**
 * While the runtime descriptor is still loading, assume cards work: the API
 * refuses with CARD_PAYMENTS_CLOSED before writing anything if they do not,
 * and that error has its own message. Used by the 特商法 page, which states
 * the accepted methods for the deployment as a whole.
 */
export function cardPaymentsEnabled(runtime: RuntimeInfo | null | undefined): boolean {
  return runtime?.features.cardPaymentsEnabled !== false;
}
