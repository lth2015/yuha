export interface CheckoutParams {
  orderId: string;
  userId: string;
  userEmail: string;
  priceKey: string;
  priceVersion: number;
  /** Resolved server-side. PAY-01: never taken from the client. */
  amountMinor: number;
  currency: string;
  stripePriceId: string | null;
  kind: 'one_time' | 'subscription';
  successUrl: string;
  cancelUrl: string;
  /** Reused so a repeated click cannot create a second Stripe session. */
  idempotencyKey: string;
  existingCustomerId?: string | null;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
  customerId: string | null;
  /** true for the demo adapter, which never touches a card. */
  simulated: boolean;
}

/**
 * A Price as the provider holds it.
 *
 * `amountMinor` is null for a Price that is not a simple fixed amount — tiered
 * or usage-based — which is a mismatch with this catalogue rather than a
 * missing value, and the comparison says so instead of skipping it.
 */
export interface RemotePrice {
  id: string;
  active: boolean;
  amountMinor: number | null;
  currency: string;
  /** 'month' | 'year' | … for a recurring Price; null for a one-off. */
  interval: string | null;
  /**
   * How many intervals between charges. 1 for monthly; 2 is "every two
   * months", which agrees with every other field and bills half as often.
   * Null for a one-off.
   */
  intervalCount: number | null;
  /**
   * 'inclusive' | 'exclusive' | 'unspecified'. The catalogue is
   * tax-inclusive, as Japanese consumer law expects, so an `exclusive` Price
   * charges tax on top of the ¥980 the page promised.
   */
  taxBehavior: string | null;
  /** The Price's own product id: two different Prices under one product. */
  productId: string | null;
  productName: string | null;
}

/** Normalised webhook event, independent of the payment vendor. */
export interface NormalisedEvent {
  id: string;
  type: string;
  createdAt: Date;
  raw: Record<string, unknown>;
}

export interface VerifiedWebhook {
  verified: boolean;
  event: NormalisedEvent | null;
  error?: string;
}

export interface PaymentsAdapter {
  readonly kind: string;
  /** false for simulated payments — the runtime descriptor exposes this to the UI. */
  readonly realCharges: boolean;
  createCheckout(params: CheckoutParams): Promise<CheckoutSession>;
  /**
   * Verifies a webhook signature over the RAW request body (PAY-04). Passing a
   * parsed object would defeat the check, so the signature is computed on bytes.
   */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): VerifiedWebhook;
  /** PAY-05: re-reads the current object when events arrive out of order. */
  retrieveCheckoutSession(sessionId: string): Promise<{
    status: string;
    paymentStatus: string;
    paymentIntentId: string | null;
    subscriptionId: string | null;
    customerId: string | null;
    amountTotal: number | null;
    currency: string | null;
  } | null>;
  retrieveSubscription(subscriptionId: string): Promise<{
    status: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    canceledAt: Date | null;
    customerId: string;
    priceId: string | null;
    latestInvoiceId: string | null;
  } | null>;
  /** PAY-08: sets cancel-at-period-end server side and returns the real effective time. */
  cancelSubscriptionAtPeriodEnd(subscriptionId: string, idempotencyKey: string): Promise<{
    cancelAtPeriodEnd: boolean;
    effectiveAt: Date | null;
  }>;
  /**
   * What a configured Price actually says, for checking it against the
   * catalogue before anything is sold.
   *
   * Optional, because the simulated adapter has no Prices to read. A caller
   * that cannot reach this cannot verify, and must say so rather than report
   * that everything agrees.
   */
  retrievePrice?(priceId: string): Promise<RemotePrice | null>;
  /** Balance-transaction details for reconciliation (PAY-11). */
  retrieveBalanceTransaction?(id: string): Promise<{
    amount: number;
    fee: number;
    net: number;
    currency: string;
    payoutId: string | null;
  } | null>;
}
