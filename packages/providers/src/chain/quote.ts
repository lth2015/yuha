import type { TokenSpec } from './tokens.js';

/**
 * How many atomic units a JPY price costs, in integers end to end.
 *
 * No floating point: a JPYC amount is eighteen decimals wide, eleven digits
 * past what a double holds exactly, and being one atomic unit short is an
 * underpayment that ends in manual review. Rates arrive as decimal strings and
 * are kept as a scaled integer, so '149.873219' is 149873219 at scale 6 and
 * every digit survives the division.
 */
export interface DecimalRate {
  /** The rate's digits with the point removed. */
  readonly scaled: bigint;
  /** How many digits were after the point. */
  readonly scale: number;
  /** Exactly as the source gave it, for the accounting record. */
  readonly text: string;
}

/**
 * Plain decimal only. Scientific notation is rejected rather than interpreted,
 * because a feed that starts emitting `1e2` has changed its format and should
 * stop the quote, not be guessed at.
 */
export function parseDecimalRate(text: string): DecimalRate {
  if (typeof text !== 'string' || !/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`rate: expected a plain decimal number, got ${JSON.stringify(text)}`);
  }
  const [whole, frac = ''] = text.split('.');
  const scaled = BigInt(`${whole}${frac}`);
  if (scaled <= 0n) throw new Error('rate: must be greater than zero');
  return { scaled, scale: frac.length, text };
}

export interface QuoteInput {
  /** Tax-inclusive JPY list price, whole yen, as the catalogue stores it. */
  priceJpy: number;
  token: TokenSpec;
  /** JPY per one whole token. Null is only valid for a 1:1 quoted currency. */
  rate: DecimalRate | null;
}

export interface QuotedAmount {
  amountAtomic: bigint;
  /** True when the division was not exact and the amount was rounded up. */
  rounded: boolean;
}

export function quoteAmountAtomic(input: QuoteInput): QuotedAmount {
  if (!Number.isInteger(input.priceJpy) || input.priceJpy <= 0) {
    throw new Error('quote: price must be a positive whole number of yen');
  }
  const unit = 10n ** BigInt(input.token.decimals);

  // JPYC: one token per yen is YUHA's pricing policy, and nothing else enters
  // into it. Deliberately not a rate of 1.0 through the same path — that would
  // make a rate source able to break a quote that does not depend on one, and
  // it is not a claim that the token is redeemable at par on demand.
  if (input.token.key === 'jpyc') {
    return { amountAtomic: BigInt(input.priceJpy) * unit, rounded: false };
  }

  if (!input.rate) {
    throw new Error(`quote: ${input.token.key} needs a rate; there is no fallback`);
  }

  // ceil(price * 10^decimals / rate), with the rate's scale folded in so the
  // whole thing is one integer division:
  //   price * 10^decimals * 10^scale / scaled
  const numerator = BigInt(input.priceJpy) * unit * 10n ** BigInt(input.rate.scale);
  const amountAtomic = (numerator + input.rate.scaled - 1n) / input.rate.scaled;
  return { amountAtomic, rounded: numerator % input.rate.scaled !== 0n };
}

export interface RateObservation {
  rate: DecimalRate;
  provider: string;
  /** When we read it, not when the source says it was computed. Both are kept. */
  observedAtMs: number;
  sourceTimestampMs?: number;
}

export type RateRefusal = 'stale' | 'divergent' | 'unconfirmed';

export type RateVerdict =
  | { usable: true; chosen: RateObservation; divergenceBps: number }
  | { usable: false; reason: RateRefusal };

/**
 * Whether a rate may be quoted from at all.
 *
 * Two independent sources that agree, both recent. A single source is refused
 * outright — not downgraded, not used with a warning — because a feed that has
 * silently frozen or depegged looks exactly like a working one from inside,
 * and the failure mode of guessing is charging a customer the wrong amount for
 * a product priced in yen.
 */
export function rateUsable(params: {
  primary: RateObservation | null;
  secondary: RateObservation | null;
  nowMs: number;
  maxAgeSeconds: number;
  maxDivergenceBps: number;
}): RateVerdict {
  const { primary, secondary, nowMs, maxAgeSeconds, maxDivergenceBps } = params;
  if (!primary || !secondary) return { usable: false, reason: 'unconfirmed' };

  const maxAgeMs = maxAgeSeconds * 1000;
  if (nowMs - primary.observedAtMs > maxAgeMs || nowMs - secondary.observedAtMs > maxAgeMs) {
    return { usable: false, reason: 'stale' };
  }

  // Compared on a common scale, in integers, in basis points of the primary.
  const scale = Math.max(primary.rate.scale, secondary.rate.scale);
  const a = primary.rate.scaled * 10n ** BigInt(scale - primary.rate.scale);
  const b = secondary.rate.scaled * 10n ** BigInt(scale - secondary.rate.scale);
  const diff = a > b ? a - b : b - a;
  const divergenceBps = Number((diff * 10_000n) / a);
  if (divergenceBps > maxDivergenceBps) return { usable: false, reason: 'divergent' };

  return { usable: true, chosen: primary, divergenceBps };
}
