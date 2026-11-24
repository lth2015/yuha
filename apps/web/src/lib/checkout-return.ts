/**
 * Where a buyer is sent back to after paying.
 *
 * Checkout can leave the site entirely (Stripe's hosted page), so the origin
 * is parked in localStorage rather than in router state or a query string.
 * Its own module so the pricing page can set it without pulling the checkout
 * pages into the first download (App.tsx loads those on demand).
 */
export const CHECKOUT_RETURN_KEY = 'yuha.checkout-return';
