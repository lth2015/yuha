import { z } from 'zod';
import { EntitlementSource, OrderKind, OrderStatus, SubscriptionStatus } from './enums.js';

/**
 * Product keys are server-side identifiers. PAY-01: the client sends a key, and
 * the amount, currency and Stripe price id are resolved from the versioned
 * server catalogue. A client-supplied amount is never trusted.
 */
export const ProductKey = z.enum(['drop_5', 'pro_monthly', 'premier_monthly', 'market_license']);
export type ProductKey = z.infer<typeof ProductKey>;

export const productView = z.object({
  priceKey: ProductKey,
  priceVersion: z.number().int().positive(),
  kind: OrderKind,
  displayName: z.string(),
  /** Tax-inclusive amount in minor units, stored as an integer (§10 heritage). */
  amountMinor: z.number().int().nonnegative(),
  currency: z.enum(['usd', 'jpy']),
  taxIncluded: z.literal(true),
  units: z.number().int().positive(),
  validityDays: z.number().int().positive().nullable(),
  autoRenew: z.boolean(),
  available: z.boolean(),
});
export type ProductView = z.infer<typeof productView>;

export const entitlementBatchView = z.object({
  batchId: z.string().uuid(),
  source: EntitlementSource,
  grantedUnits: z.number().int(),
  reservedUnits: z.number().int(),
  consumedUnits: z.number().int(),
  availableUnits: z.number().int(),
  effectiveFrom: z.string(),
  expiresAt: z.string().nullable(),
  productKey: z.string().nullable(),
});

export const entitlementsView = z.object({
  availableUnits: z.number().int(),
  reservedUnits: z.number().int(),
  batches: z.array(entitlementBatchView),
  subscription: z
    .object({
      subscriptionId: z.string().uuid(),
      status: SubscriptionStatus,
      currentPeriodStart: z.string().nullable(),
      currentPeriodEnd: z.string().nullable(),
      cancelAtPeriodEnd: z.boolean(),
      /** Exact JST instant shown to the user (UI-11). */
      endsAtJst: z.string().nullable(),
    })
    .nullable(),
});
export type EntitlementsView = z.infer<typeof entitlementsView>;

export const createCheckoutRequest = z.object({
  priceKey: ProductKey,
  /** Client-generated, but scoped per user so replay cannot cross accounts. */
  idempotencyKey: z.string().min(8).max(128),
  successPath: z.string().max(200).optional(),
  cancelPath: z.string().max(200).optional(),
});
export type CreateCheckoutRequest = z.infer<typeof createCheckoutRequest>;

export const createCheckoutResponse = z.object({
  orderId: z.string().uuid(),
  checkoutUrl: z.string(),
  /** demo mode returns a simulated checkout that never touches a real card. */
  simulated: z.boolean(),
});

export const orderView = z.object({
  orderId: z.string().uuid(),
  priceKey: z.string(),
  /** The catalogue's name at purchase time — a receipt must not be rewritten
   * by a later rename or reprice. Null for orders whose catalogue row is gone. */
  displayName: z.string().nullable(),
 
  priceVersion: z.number().int(),
  kind: OrderKind,
  amountMinor: z.number().int(),
  currency: z.string(),
  status: OrderStatus,
  /**
   * PAY-02: entitlement grant is driven by the server-verified payment, not by
   * the browser landing on the success page.
   */
  entitlementGranted: z.boolean(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
  receiptUrl: z.string().nullable(),
});
export type OrderView = z.infer<typeof orderView>;

export const cancelSubscriptionRequest = z.object({
  subscriptionId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
});

export const cancelSubscriptionResponse = z.object({
  subscriptionId: z.string().uuid(),
  cancelAtPeriodEnd: z.boolean(),
  /** ISO instant; the UI renders it in JST. Only set once the server confirmed. */
  effectiveAt: z.string().nullable(),
});
