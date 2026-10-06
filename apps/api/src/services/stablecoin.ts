import { AppError } from '@yuha/contracts';
import {
  closeIntent,
  findOpenIntentForOrder,
  findOpenIntentForPayer,
  findOrderByIdempotencyKey,
  getActiveProduct,
  getOrderForUser,
  getQuote,
  getUser,
  getVerifiedWallet,
  insertOrder,
  insertQuoteWithIntent,
  markIntentPrepared,
  withTx,
  type OrderRow,
  type StablecoinIntentRow,
  type StablecoinQuoteRow,
} from '@yuha/db';
import {
  JPYC_POLYGON,
  USDC_POLYGON,
  encodeTransferCalldata,
  quoteAmountAtomic,
  toDisplayAddress,
  type TokenSpec,
} from '@yuha/providers';
import type { AppContext } from '../context.js';

/**
 * Quoting a stablecoin payment, and handing the wallet the exact transfer to
 * send.
 *
 * The URL shape here is /v1/payments/stablecoin/... rather than the
 * specification's /api/orders/:id/stablecoin-quote, for two reasons: this
 * server has only ever served /v1, and an order does not exist before the
 * quote — the card path creates the order and the Stripe session together, so
 * there was no order-without-a-session to quote against. The quote endpoint
 * therefore creates or reuses the order itself, under the same
 * (user, idempotency key) uniqueness the card path uses.
 */

const SUPPORTED: Record<string, TokenSpec> = { jpyc: JPYC_POLYGON, usdc: USDC_POLYGON };

/** DROP and Licence only. Subscriptions stay on Stripe in v1. */
const QUOTABLE_PRODUCTS = new Set(['drop_5', 'market_license']);

function tokenFor(ctx: AppContext, key: string): TokenSpec {
  if (!ctx.config.STABLECOIN_ENABLED) {
    throw new AppError('SERVICE_DISABLED', 'stablecoin payments are not available');
  }
  const token = SUPPORTED[key];
  if (!token) throw new AppError('VALIDATION_FAILED', 'unknown currency');
  if (token.chainId !== ctx.config.STABLECOIN_CHAIN_ID) {
    throw new AppError('SERVICE_DISABLED', 'that currency is not available on the configured chain');
  }
  const enabled = key === 'jpyc' ? ctx.config.STABLECOIN_JPYC_ENABLED : ctx.config.STABLECOIN_USDC_ENABLED;
  if (!enabled) throw new AppError('SERVICE_DISABLED', 'that currency is not available yet');
  return token;
}

function receiverFor(ctx: AppContext): string {
  const receiver = ctx.config.STABLECOIN_RECEIVER_ADDRESS;
  // Config validation refuses to start without it when the feature is on, so
  // this is the second line of the same defence rather than the first.
  if (!receiver) throw new AppError('SERVICE_DISABLED', 'no receiving wallet is configured');
  return receiver.toLowerCase();
}

export interface QuoteResult {
  orderId: string;
  quoteId: string;
  chainId: number;
  tokenKey: string;
  tokenAddress: string;
  /** Atomic units as a decimal string. Never a number: 18 decimals do not fit. */
  amountAtomic: string;
  priceJpy: number;
  receiver: string;
  payer: string;
  expiresAt: string;
  roundedUp: boolean;
}

function viewQuote(q: StablecoinQuoteRow): QuoteResult {
  return {
    orderId: q.order_id,
    quoteId: q.id,
    chainId: q.chain_id,
    tokenKey: q.token_key,
    tokenAddress: toDisplayAddress(q.token_address),
    amountAtomic: q.amount_atomic,
    priceJpy: Number(q.price_jpy),
    receiver: toDisplayAddress(q.receiver),
    payer: toDisplayAddress(q.payer),
    expiresAt: q.expires_at.toISOString(),
    roundedUp: q.rounded_up,
  };
}

export async function createStablecoinQuote(
  ctx: AppContext,
  params: {
    userId: string;
    priceKey: string;
    idempotencyKey: string;
    tokenKey: string;
    payer: string;
    trackId?: string;
  },
): Promise<QuoteResult> {
  const token = tokenFor(ctx, params.tokenKey);
  const receiver = receiverFor(ctx);
  const payer = params.payer.toLowerCase();

  const user = await getUser(params.userId);
  if (!user) throw new AppError('UNAUTHENTICATED', 'user not found');
  if (!user.age_confirmed_at) throw new AppError('AGE_NOT_CONFIRMED', 'age confirmation is required before purchase');

  // The payer must have proved control of this wallet. Everything downstream
  // treats it as established, so this is where "the client said so" stops.
  const wallet = await getVerifiedWallet({ userId: params.userId, chainId: token.chainId, address: payer });
  if (!wallet) throw new AppError('VALIDATION_FAILED', 'prove control of that wallet first');

  if (!QUOTABLE_PRODUCTS.has(params.priceKey)) {
    throw new AppError('VALIDATION_FAILED', 'that product cannot be paid for in stablecoin yet');
  }
  const product = await getActiveProduct(params.priceKey);
  if (!product || !product.active) throw new AppError('NOT_FOUND', 'that product is not available');
  if (product.currency !== 'jpy') {
    // Quoting is defined against a JPY list price; a catalogue in another
    // currency would need its own conversion policy, not a silent one.
    throw new AppError('SERVICE_DISABLED', 'stablecoin quoting is defined for JPY prices only');
  }

  const existing = await findOrderByIdempotencyKey(params.userId, params.idempotencyKey);
  if (existing) {
    // Same guard the card path has, and for the same reason: `drop_5` and
    // `market_license` are both 980 JPY, so an amount check cannot catch a key
    // reused across the two.
    if (existing.price_key !== product.price_key || existing.price_version !== product.version) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 'this idempotency key already belongs to a different order');
    }
    if (params.trackId && existing.metadata['track_id'] !== params.trackId) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 'this idempotency key already belongs to a different song');
    }
    if (existing.status === 'paid') throw new AppError('CONFLICT', 'this order has already been paid');
    assertNotCardClaimed(existing);
  }

  const { amountAtomic, rounded } = quoteAmountAtomic({
    priceJpy: product.amount_minor,
    token,
    // JPYC consults no rate at all. USDC is refused at config validation
    // until a provider exists, so there is no path here that needs one yet.
    rate: null,
  });

  const expiresAt = new Date(Date.now() + ctx.config.STABLECOIN_QUOTE_TTL_SECONDS * 1000);

  return withTx(async (tx) => {
    const order =
      existing ??
      (await insertOrder(
        {
          userId: params.userId,
          priceKey: product.price_key,
          priceVersion: product.version,
          kind: product.kind,
          amountMinor: product.amount_minor,
          currency: product.currency,
          idempotencyKey: params.idempotencyKey,
          metadata: {
            units: product.units,
            validity_days: product.validity_days,
            ...(params.trackId ? { track_id: params.trackId } : {}),
          },
          paymentMethod: 'stablecoin',
        },
        tx,
      ));

    /*
     * A re-quote for the SAME order supersedes the old one: the previous
     * intent is closed so it stops holding the wallet's slot, and its quote
     * row stays, because a superseded price is part of the record of what the
     * customer was shown.
     *
     * An open intent for a DIFFERENT order is a conflict. One wallet, one
     * payment at a time — if two were open, a transfer arriving with the
     * matching amount would be ambiguous between them, and nothing else in
     * this design can disambiguate it.
     */
    const openForPayer = await findOpenIntentForPayer({ chainId: token.chainId, payer }, tx);
    if (openForPayer) {
      if (openForPayer.order_id !== order.id) {
        throw new AppError(
          'CONFLICT',
          'this wallet already has a payment waiting — finish or cancel it before starting another',
          { orderId: openForPayer.order_id },
        );
      }
      await closeIntent({ intentId: openForPayer.id, state: 'cancelled' }, tx);
    }

    const { quote } = await insertQuoteWithIntent(
      {
        orderId: order.id,
        userId: params.userId,
        tokenKey: token.key,
        chainId: token.chainId,
        tokenAddress: token.address,
        tokenDecimals: token.decimals,
        receiver,
        payer,
        priceJpy: product.amount_minor,
        amountAtomic: amountAtomic.toString(),
        rateText: null,
        rateProvider: null,
        rateSourceAt: null,
        rateObservedAt: null,
        roundedUp: rounded,
        // Phase C replaces this with the chain head at quote time. Zero means
        // "look from the beginning", which is correct but slow — and it is
        // honest, where a made-up height would make the scanner skip a real
        // payment.
        startBlock: 0n,
        configVersion: ctx.config.STABLECOIN_CONFIG_VERSION,
        expiresAt,
      },
      tx,
    );
    return viewQuote(quote);
  });
}

/**
 * An order already in the card channel must not also be quoted in stablecoin.
 *
 * §9: one active channel per order. A Stripe session id is the stronger
 * evidence — it means a checkout really was opened — and `payment_method`
 * covers the case where it was set without one.
 */
function assertNotCardClaimed(order: OrderRow): void {
  if (order.stripe_checkout_session_id || order.payment_method === 'card') {
    throw new AppError('CONFLICT', 'this order is already being paid by card');
  }
}

export interface PreparedTransfer {
  chainId: number;
  /** The token contract. The transfer goes to the receiver inside the calldata. */
  to: string;
  data: string;
  value: '0';
  amountAtomic: string;
  receiver: string;
  expiresAt: string;
  /**
   * What the account's transaction count was, when we can read it. Null until
   * the RPC client exists — and null is honest: this is evidence recorded
   * about a payment, never a reservation, because a nonce in someone else's
   * wallet cannot be reserved. See docs/STABLECOIN_V1_PLAN.md §1.
   */
  predictedNonce: number | null;
}

export async function prepareStablecoinPayment(
  ctx: AppContext,
  params: { userId: string; orderId: string },
): Promise<PreparedTransfer> {
  if (!ctx.config.STABLECOIN_ENABLED) {
    throw new AppError('SERVICE_DISABLED', 'stablecoin payments are not available');
  }
  const order = await getOrderForUser(params.orderId, params.userId);
  if (!order) throw new AppError('NOT_FOUND', 'order not found');
  if (order.status === 'paid') throw new AppError('CONFLICT', 'this order has already been paid');

  const intent = await findOpenIntentForOrder(params.orderId);
  if (!intent) throw new AppError('NOT_FOUND', 'no live quote for this order — ask for a new one');
  const quote = await getQuote(intent.quote_id);
  if (!quote) throw new AppError('NOT_FOUND', 'quote not found');
  if (quote.expires_at.getTime() <= Date.now()) {
    throw new AppError('CONFLICT', 'that quote has expired — ask for a new one');
  }

  // Built from the stored quote, not from anything in the request: the amount,
  // the receiver and the token are the server's, and the wallet is handed
  // calldata it can check rather than fields it has to assemble.
  const data = encodeTransferCalldata(quote.receiver, BigInt(quote.amount_atomic));
  await markIntentPrepared({ intentId: intent.id, predictedNonce: null });

  return {
    chainId: quote.chain_id,
    to: toDisplayAddress(quote.token_address),
    data,
    value: '0',
    amountAtomic: quote.amount_atomic,
    receiver: toDisplayAddress(quote.receiver),
    expiresAt: quote.expires_at.toISOString(),
    predictedNonce: null,
  };
}

export interface PaymentStatus {
  orderId: string;
  orderStatus: string;
  paymentMethod: string | null;
  intent: { state: string; expiresAt: string | null } | null;
}

export async function stablecoinPaymentStatus(
  params: { userId: string; orderId: string },
): Promise<PaymentStatus> {
  const order = await getOrderForUser(params.orderId, params.userId);
  if (!order) throw new AppError('NOT_FOUND', 'order not found');
  const intent: StablecoinIntentRow | undefined = await findOpenIntentForOrder(params.orderId);
  const quote = intent ? await getQuote(intent.quote_id) : undefined;
  return {
    orderId: order.id,
    orderStatus: order.status,
    paymentMethod: order.payment_method,
    intent: intent ? { state: intent.state, expiresAt: quote?.expires_at.toISOString() ?? null } : null,
  };
}
