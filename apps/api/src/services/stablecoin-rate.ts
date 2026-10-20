import { AppError } from '@yuha/contracts';
import { rateUsable, type RateObservation } from '@yuha/providers';
import type { AppContext } from '../context.js';

/**
 * The USD/JPY rate a USDC quote may be computed from, or a refusal.
 *
 * Both sources are read on every quote. A quote is rare — one per purchase
 * attempt — and a cached rate is exactly the "silently frozen feed" this
 * check exists to catch, so there is no cache to go stale between the read
 * and the price.
 *
 * Refused (SERVICE_DISABLED, with the reason) when either source cannot be
 * read, when the primary was read too long ago, when the reference's own
 * publication is too old, or when the two disagree by more than the
 * configured basis points. There is no fallback rate: the failure mode of
 * guessing is charging somebody the wrong amount for a product priced in yen.
 */
export interface UsdcRate {
  /** The rate priced from — the primary. */
  chosen: RateObservation;
  /** The independent reading it was checked against, kept for the record. */
  reference: RateObservation;
  divergenceBps: number;
}

/** The primary is read moments before pricing; a minute is generous. */
const PRIMARY_MAX_AGE_SECONDS = 60;

export async function usdcJpyRate(ctx: AppContext, nowMs: () => number = Date.now): Promise<UsdcRate> {
  const [primary, reference] = await Promise.allSettled([ctx.fx.primary(), ctx.fx.reference()]);
  const p = primary.status === 'fulfilled' ? primary.value : null;
  const r = reference.status === 'fulfilled' ? reference.value : null;

  const verdict = rateUsable({
    primary: p,
    secondary: r,
    nowMs: nowMs(),
    maxAgeSeconds: PRIMARY_MAX_AGE_SECONDS,
    maxDivergenceBps: ctx.config.STABLECOIN_RATE_MAX_DIVERGENCE_BPS,
    maxSourceAgeSeconds: ctx.config.STABLECOIN_RATE_REFERENCE_MAX_AGE_HOURS * 3600,
  });
  if (!verdict.usable || !r) {
    const reason = verdict.usable ? 'unconfirmed' : verdict.reason;
    throw new AppError('SERVICE_DISABLED', 'USDC cannot be priced right now — please try again shortly, or pay in JPYC or by card', {
      reason,
      // Which side failed, without the response bodies: enough for an operator
      // to know where to look, nothing a caller could use.
      primary: primary.status === 'rejected' ? String((primary.reason as Error)?.message ?? 'failed') : 'ok',
      reference: reference.status === 'rejected' ? String((reference.reason as Error)?.message ?? 'failed') : 'ok',
    });
  }
  return { chosen: verdict.chosen, reference: r, divergenceBps: verdict.divergenceBps };
}
