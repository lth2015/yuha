import type { PaymentMethodView } from '@yuha/contracts';
import type { AppConfig } from '../config.js';
import { acceptingStablecoinTokens } from './stablecoin-tokens.js';
import type { FeatureFlags } from '../config.js';
import type { TokenSpec } from '@yuha/providers';

/**
 * How a product may be paid for. The one place that decides it.
 *
 * docs/PAYMENTS_DESIGN.md is the rule; this is the rule as code. Every surface
 * that offers a purchase — the pricing grid, the confirmation screen, a song's
 * licence button, and the quote endpoint that refuses what is not offered —
 * reads the answer from here, so no page can show a way to pay that the
 * server would refuse, and no two pages can disagree.
 *
 * The answer is the intersection of two things, and only these two:
 *
 *   what the deployment has open   card (Stripe, or the demo's simulation)
 *                                  and each enabled stablecoin
 *   what the product kind allows   a subscription renews automatically, which
 *                                  only a card can do; a stablecoin buyer
 *                                  tops up with a one-time pack instead
 *
 * Nothing is decided per product key. A new one-time product is payable in
 * every open channel the day it is added; a new channel is offered on every
 * product its kind allows.
 */
export interface PaymentRails {
  card: boolean;
  stablecoins: Array<TokenSpec['key']>;
}

/**
 * From the runtime switches, not config alone: a currency an operator has
 * paused (NETX) stops being offered on the next request, without a deploy.
 */
export function paymentRails(config: AppConfig, features: FeatureFlags): PaymentRails {
  return {
    card: features.cardPaymentsEnabled,
    stablecoins: acceptingStablecoinTokens(config, features).map((t) => t.key),
  };
}

/** Whether a product of this kind can be paid for in stablecoin at all. */
export function stablecoinAllowedFor(kind: 'one_time' | 'subscription'): boolean {
  return kind === 'one_time';
}

/**
 * Card is always listed, open or closed, because it is the channel every
 * product has; a closed card says why. A stablecoin is listed only when the
 * deployment has it on — advertising a currency nobody can pay in is noise —
 * and on a subscription it is listed as unavailable with the reason, so the
 * buyer learns where to go instead of wondering why it is missing.
 */
export function paymentMethodsFor(kind: 'one_time' | 'subscription', rails: PaymentRails): PaymentMethodView[] {
  const methods: PaymentMethodView[] = [
    { method: 'card', available: rails.card, reason: rails.card ? null : 'card_closed' },
  ];
  for (const key of rails.stablecoins) {
    const allowed = stablecoinAllowedFor(kind);
    methods.push({ method: key, available: allowed, reason: allowed ? null : 'no_auto_renewal' });
  }
  return methods;
}
