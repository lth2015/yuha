import type { RuntimeInfo } from '@yuha/contracts';

/**
 * Where a buy button goes, decided once for every page that has one.
 *
 * Three pages start a purchase — the pricing grid, the confirmation screen and
 * a song's licence button — and each used to decide on its own. When card
 * payment could not complete (simulated payments outside the demo, as on
 * yuha.studio), all three still sent the buyer to the card path, and each
 * ended at "this page is for demo mode only". The answer is a property of the
 * deployment and the product, so it is computed in one place.
 *
 *   card        → the card checkout (Stripe, or the demo's simulation)
 *   stablecoin  → the only channel that can complete here
 *   closed      → nothing can; say so on the button instead of leading anywhere
 */
export type PurchaseRoute = 'card' | 'stablecoin' | 'closed';

export function purchaseRoute(p: { cardPaymentsEnabled: boolean; stablecoinOffered: boolean }): PurchaseRoute {
  if (p.cardPaymentsEnabled) return 'card';
  return p.stablecoinOffered ? 'stablecoin' : 'closed';
}

/**
 * Only what the quote endpoint accepts: `QUOTABLE_PRODUCTS` on the server is
 * DROP and Licence. A wallet offer on a subscription is a button the next
 * request refuses.
 */
export function stablecoinOfferedFor(runtime: RuntimeInfo | null | undefined, priceKey: string): boolean {
  return (
    !!runtime?.stablecoin.enabled &&
    runtime.stablecoin.tokens.length > 0 &&
    (priceKey === 'drop_5' || priceKey === 'market_license')
  );
}

/**
 * While the runtime descriptor is still loading, assume cards work: the API
 * refuses with CARD_PAYMENTS_CLOSED before writing anything if they do not,
 * and that error has its own message.
 */
export function cardPaymentsEnabled(runtime: RuntimeInfo | null | undefined): boolean {
  return runtime?.features.cardPaymentsEnabled !== false;
}
