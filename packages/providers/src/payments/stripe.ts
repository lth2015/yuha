import Stripe from 'stripe';
import type {
  CheckoutParams,
  CheckoutSession,
  PaymentsAdapter,
  VerifiedWebhook,
} from './types.js';

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  /** Guard: a live key must never be used outside production mode. */
  expectLiveMode: boolean;
  /**
   * Overrides the SDK's pinned API version. Needed by accounts with Managed
   * Payments, which requires 2025-03-31.basil or greater. Unset means the
   * SDK's own default, so nothing changes for accounts that do not need it.
   */
  apiVersion?: string;
}

/**
 * Stripe adapter.
 *
 * Card data never reaches our servers — Checkout is hosted, so PAN and CVC are
 * entered on Stripe's page (PAY-12/SEC design §07). Amount, currency and price
 * id come from our catalogue, so tampering with the client changes nothing
 * about what is charged (PAY-01).
 */
export class StripePaymentsAdapter implements PaymentsAdapter {
  readonly kind = 'stripe';
  readonly realCharges = true;
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(opts: StripeOptions) {
    const isLive = opts.secretKey.startsWith('sk_live_');
    if (isLive && !opts.expectLiveMode) {
      throw new Error('a live Stripe secret key was supplied outside production mode');
    }
    if (!isLive && opts.expectLiveMode) {
      throw new Error('production mode requires a live Stripe secret key, not a test key');
    }
    /*
     * The API version is configurable and defaults to the SDK's own.
     *
     * An account with Managed Payments enabled refuses a Checkout Session on
     * the version this SDK pins by default:
     *
     *   "Managed Payments is not supported on API version 2025-02-24.acacia.
     *    Update your API version, or set the API Version of this request to
     *    2025-03-31.basil or greater."
     *
     * Only a live call finds that. Pinning per-client is the route Stripe's
     * own message points at and needs no SDK upgrade, so the default is left
     * alone and an account that needs a newer version asks for one.
     *
     * The cost of setting it: this SDK's types were generated against its own
     * version, so responses from a newer one are not type-checked. Everything
     * this adapter reads — session id, url, customer, and the webhook event
     * envelope — is long-standing, but that is an argument for care, not a
     * guarantee.
     */
    this.stripe = new Stripe(opts.secretKey, {
      maxNetworkRetries: 2,
      timeout: 20_000,
      ...(opts.apiVersion ? { apiVersion: opts.apiVersion as Stripe.LatestApiVersion } : {}),
    });
    this.webhookSecret = opts.webhookSecret;
  }

  async createCheckout(params: CheckoutParams): Promise<CheckoutSession> {
    if (!params.stripePriceId) {
      throw new Error(`product ${params.priceKey} has no Stripe price id configured`);
    }
    const oneTime = params.kind !== 'subscription';
    // Wallets are enabled on the Stripe account, not listed here.
    //
    // Passing `payment_method_types` pins the session to exactly that list and
    // opts out of the account's automatic payment methods — so listing
    // ['card','alipay','wechat_pay'] would have *removed* Apple Pay, Google
    // Pay, Link and, for a Japanese account, konbini. A change meant to add
    // two methods would have dropped several. Stripe already filters
    // automatic methods by mode and currency, and will not offer Alipay or
    // WeChat Pay on a subscription because both are single-use.
    //
    // STRIPE_WALLETS_ENABLED therefore never reaches this adapter at all: it
    // drives only what the pricing page claims we accept. A parameter that
    // changed nothing would just be another surface that looks like it does.
    //
    // Not even payment_method_options: it was left behind carrying a
    // wechat_pay `client` for a session that no longer names wechat_pay, and
    // whether Stripe accepts options for an unlisted method could not be
    // checked from here. If it rejects them, every one-time checkout would
    // fail the moment the flag was switched on — the opposite of adding a way
    // to pay. Checkout's hosted page is a web surface, so there is nothing
    // here it needs telling.

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: oneTime ? 'payment' : 'subscription',
        line_items: [{ price: params.stripePriceId, quantity: 1 }],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        client_reference_id: params.orderId,
        ...(params.existingCustomerId
          ? { customer: params.existingCustomerId }
          : { customer_email: params.userEmail }),
        // Carried back on every related webhook so the event can be matched to
        // our own order without trusting anything the browser reports.
        metadata: {
          order_id: params.orderId,
          user_id: params.userId,
          price_key: params.priceKey,
          price_version: String(params.priceVersion),
        },
        ...(oneTime
          ? {
              payment_intent_data: {
                metadata: { order_id: params.orderId, user_id: params.userId },
              },
            }
          : {
              subscription_data: {
                metadata: {
                  order_id: params.orderId,
                  user_id: params.userId,
                  price_key: params.priceKey,
                  price_version: String(params.priceVersion),
                },
              },
            }),
      },
      // Stripe-side idempotency, on top of our own order uniqueness.
      { idempotencyKey: `checkout:${params.idempotencyKey}` },
    );
    return {
      sessionId: session.id,
      url: session.url ?? '',
      customerId: typeof session.customer === 'string' ? session.customer : null,
      simulated: false,
    };
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): VerifiedWebhook {
    if (!signatureHeader) return { verified: false, event: null, error: 'missing Stripe-Signature header' };
    try {
      const event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
      return {
        verified: true,
        event: {
          id: event.id,
          type: event.type,
          createdAt: new Date(event.created * 1000),
          raw: event as unknown as Record<string, unknown>,
        },
      };
    } catch (err) {
      return { verified: false, event: null, error: (err as Error).message };
    }
  }

  async retrieveCheckoutSession(sessionId: string) {
    try {
      const s = await this.stripe.checkout.sessions.retrieve(sessionId);
      return {
        status: s.status ?? 'unknown',
        paymentStatus: s.payment_status ?? 'unknown',
        paymentIntentId: typeof s.payment_intent === 'string' ? s.payment_intent : null,
        subscriptionId: typeof s.subscription === 'string' ? s.subscription : null,
        customerId: typeof s.customer === 'string' ? s.customer : null,
        amountTotal: s.amount_total ?? null,
        currency: s.currency ?? null,
      };
    } catch {
      return null;
    }
  }

  async retrieveSubscription(subscriptionId: string) {
    try {
      const s = (await this.stripe.subscriptions.retrieve(subscriptionId)) as Stripe.Subscription & {
        current_period_start?: number;
        current_period_end?: number;
      };
      const item = s.items?.data?.[0] as
        | (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number })
        | undefined;
      /*
       * The period lives on the item now.
       *
       * 2026-08-26.dahlia removed `current_period_start` / `current_period_end`
       * from the Subscription object and put them on each subscription item.
       * Reading only the top level returned null for both, so a paid
       * subscription was stored with no period at all and the entitlement
       * batch had nothing to expire against. The top level is still read first
       * for accounts pinned to an older version.
       */
      const periodStart = s.current_period_start ?? item?.current_period_start;
      const periodEnd = s.current_period_end ?? item?.current_period_end;
      return {
        status: s.status,
        currentPeriodStart: periodStart ? new Date(periodStart * 1000) : null,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
        cancelAtPeriodEnd: s.cancel_at_period_end,
        canceledAt: s.canceled_at ? new Date(s.canceled_at * 1000) : null,
        customerId: typeof s.customer === 'string' ? s.customer : '',
        priceId: item?.price?.id ?? null,
        latestInvoiceId: typeof s.latest_invoice === 'string' ? s.latest_invoice : null,
      };
    } catch {
      return null;
    }
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string, idempotencyKey: string) {
    const s = (await this.stripe.subscriptions.update(
      subscriptionId,
      { cancel_at_period_end: true },
      { idempotencyKey: `cancel:${idempotencyKey}` },
    )) as Stripe.Subscription & { current_period_end?: number };
    // Same move as in `retrieveSubscription`: without the item fallback the
    // cancellation reports no effective date, and the UI has nothing to put in
    // "usable until".
    const item = s.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
    const periodEnd = s.current_period_end ?? item?.current_period_end;
    return {
      cancelAtPeriodEnd: s.cancel_at_period_end,
      effectiveAt: periodEnd ? new Date(periodEnd * 1000) : null,
    };
  }

  /**
   * Reads a configured Price back, so somebody can check it is the one they
   * meant.
   *
   * The product is expanded because the useful error is "that id is CREATOR,
   * and you put it in the STUDIO slot", not "amount 1980 != 3980". Our
   * environment variable names come from internal price keys
   * (STRIPE_PRICE_ID_PRO_MONTHLY) and the dashboard shows marketing names
   * (CREATOR), so the two are easy to pair up wrongly and the name is what
   * makes the mismatch obvious.
   */
  async retrievePrice(priceId: string) {
    try {
      const p = await this.stripe.prices.retrieve(priceId, { expand: ['product'] });
      const product = p.product;
      return {
        id: p.id,
        active: p.active,
        // `unit_amount` is null for tiered or metered Prices, which this
        // catalogue cannot express. Reported as null and treated as a
        // mismatch rather than skipped.
        amountMinor: p.unit_amount ?? null,
        currency: p.currency,
        interval: p.recurring?.interval ?? null,
        intervalCount: p.recurring?.interval_count ?? null,
        taxBehavior: p.tax_behavior ?? null,
        billingScheme: p.billing_scheme ?? null,
        usageType: p.recurring?.usage_type ?? null,
        productId: typeof product === 'string' ? product : (product?.id ?? null),
        productName:
          typeof product === 'string' || !product || product.deleted ? null : product.name,
        /*
         * Unknown rather than false when the product was not expanded — a
         * caller must be able to tell "Stripe says this product is archived"
         * from "we did not ask".
         */
        productActive:
          typeof product === 'string' || !product
            ? null
            : product.deleted
              ? false
              : product.active,
      };
    } catch (err) {
      /*
       * `null` means "Stripe says there is no such Price", and nothing else.
       *
       * A bare `catch { return null }` turned a network error, an expired key,
       * a 429 and a Stripe outage into the same answer — which the caller
       * renders as "wrong account, wrong mode, or a deleted Price" and the
       * seed then exits on, telling an operator to fix four ids that are
       * perfectly correct. Only `invalid_request_error` is actually about the
       * id; everything else is rethrown so the caller can say it could not
       * check rather than inventing a diagnosis.
       */
      if ((err as { type?: string }).type === 'StripeInvalidRequestError') return null;
      throw err;
    }
  }

  async retrieveBalanceTransaction(id: string) {
    try {
      const bt = await this.stripe.balanceTransactions.retrieve(id);
      return {
        amount: bt.amount,
        fee: bt.fee,
        net: bt.net,
        currency: bt.currency,
        payoutId: typeof bt.source === 'string' ? null : null,
      };
    } catch {
      return null;
    }
  }
}
