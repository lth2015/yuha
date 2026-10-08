import { AppError } from '@yuha/contracts';
import {
  decideOrderReview,
  disputeCountForUser,
  getOrder,
  getOrderReview,
  getUser,
  holdOrderForReview,
  listOpenOrderReviews,
  purchaseActivitySince,
  writeAuditLog,
  type OrderRow,
  type Tx,
  type UserRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';
import { fulfilPaidOrder } from './fulfilment.js';

/**
 * Holding a paid card order while a person looks at it.
 *
 * `docs/FRAUD_PREVENTION.md`'s measure ⑥ was ticked for the stablecoin channel
 * and absent for the card one — the channel carrying every payment today. The
 * asymmetry was an artefact rather than a decision: on-chain payments arrive
 * with amounts and timings that can disagree with a quote, so they needed a
 * queue, while a card payment either succeeds or does not.
 *
 * What a card payment can still be is somebody else's card, and the thing that
 * cannot be undone is not the payment but the DELIVERY. A chargeback takes the
 * money back; nothing takes back a song that has been downloaded. So this
 * holds delivery, never the payment: Stripe has already taken it and its own
 * screening has already had its say.
 *
 * Deliberately narrow, for a reason worth stating plainly: a hold on a
 * legitimate purchase is a customer who paid and received nothing, which at
 * this scale is the worse failure. Every signal is our own data, every
 * threshold is configuration, and the defaults hold almost nothing.
 */

export type RiskReason = 'new_account_high_value' | 'prior_dispute' | 'order_velocity';

export interface RiskThresholds {
  /** How young an account is still "new", in minutes. 0 disables the signal. */
  newAccountMinutes: number;
  /** The value, in minor units, that makes a new account's order worth a look. */
  newAccountValueMinor: number;
  /** Orders started in the rolling day that make an account worth a look. 0 disables. */
  velocityOrders: number;
}

export interface RiskFacts {
  amountMinor: number;
  /** How long the account has existed, in milliseconds, at the moment of payment. */
  accountAgeMs: number;
  ordersStartedInWindow: number;
  priorDisputes: number;
}

/**
 * Which signals fired. A pure function, so each one can be tested on its own
 * and the thresholds can be argued about without a database.
 *
 * Returned sorted and deduplicated, because the array is stored on the review
 * row and read back months later: an operator comparing two holds should not
 * have to notice that the same two reasons arrived in a different order.
 */
export function cardOrderRiskReasons(facts: RiskFacts, limits: RiskThresholds): RiskReason[] {
  const reasons: RiskReason[] = [];

  /*
   * A brand-new account spending real money in its first hour.
   *
   * Both halves are needed. Age alone describes every genuine first purchase,
   * which is most purchases; value alone describes a good customer. The pair
   * is what a card tester's successful attempt looks like, and what a
   * returning customer never does.
   */
  if (
    limits.newAccountMinutes > 0 &&
    facts.accountAgeMs < limits.newAccountMinutes * 60_000 &&
    facts.amountMinor >= limits.newAccountValueMinor
  ) {
    reasons.push('new_account_high_value');
  }

  /*
   * This account has had a chargeback before. Not a judgement — disputes
   * happen to honest people and we may have lost one we should have won — but
   * it is the one piece of history that predicts the next one, and it costs a
   * person thirty seconds to look.
   */
  if (facts.priorDisputes > 0) reasons.push('prior_dispute');

  /*
   * Many orders started in a day, while still under the purchase cap. The cap
   * stops the fortieth order; this notices the tenth, which is where a human
   * would have started wondering.
   */
  if (limits.velocityOrders > 0 && facts.ordersStartedInWindow >= limits.velocityOrders) {
    reasons.push('order_velocity');
  }

  return [...new Set(reasons)].sort();
}

function thresholdsFrom(ctx: AppContext): RiskThresholds {
  return {
    newAccountMinutes: ctx.config.CARD_REVIEW_NEW_ACCOUNT_MINUTES,
    newAccountValueMinor: ctx.config.CARD_REVIEW_NEW_ACCOUNT_VALUE_MINOR,
    velocityOrders: ctx.config.CARD_REVIEW_VELOCITY_ORDERS,
  };
}

/**
 * Assesses a card order that has just been marked paid, and holds it if any
 * signal fired.
 *
 * Called inside the same transaction that marked the order paid, and BEFORE
 * delivery is attempted: the review row has to exist by the time
 * `grantEntitlementForOrder` looks for it, or the hold is a note written after
 * the goods have gone.
 *
 * Returns the reasons, so the caller can report them; an empty array means
 * nothing was held and delivery proceeds exactly as before.
 */
export async function reviewPaidCardOrder(
  ctx: AppContext,
  params: { order: OrderRow; user: UserRow },
  tx: Tx,
): Promise<RiskReason[]> {
  if (!ctx.config.CARD_REVIEW_ENABLED) return [];
  // On-chain payments are final — there is no chargeback to protect against —
  // so the signals here, which are all about card fraud, do not apply.
  if (params.order.payment_method === 'stablecoin') return [];

  const since = new Date(Date.now() - 86_400_000);
  const [activity, priorDisputes] = await Promise.all([
    purchaseActivitySince({ userId: params.order.user_id, since }, tx),
    disputeCountForUser(params.order.user_id, tx),
  ]);

  const reasons = cardOrderRiskReasons(
    {
      amountMinor: params.order.amount_minor,
      accountAgeMs: Date.now() - params.user.created_at.getTime(),
      ordersStartedInWindow: activity.createdCount,
      priorDisputes,
    },
    thresholdsFrom(ctx),
  );
  if (reasons.length === 0) return [];

  await holdOrderForReview(
    {
      orderId: params.order.id,
      userId: params.order.user_id,
      reasons,
      amountMinor: params.order.amount_minor,
      currency: params.order.currency,
    },
    tx,
  );
  return reasons;
}

/* ------------------------------------------------------- the console side */

export interface HeldOrderItem {
  reviewId: string;
  orderId: string;
  userId: string;
  userEmail: string | null;
  priceKey: string;
  amountMinor: number;
  currency: string;
  reasons: string[];
  heldAt: string;
  paidAt: string | null;
}

/** Card orders waiting for a person, oldest first. */
export async function heldOrderQueue(): Promise<HeldOrderItem[]> {
  const reviews = await listOpenOrderReviews();
  const out: HeldOrderItem[] = [];
  for (const r of reviews) {
    const order = await getOrder(r.order_id);
    const user = await getUser(r.user_id);
    out.push({
      reviewId: r.id,
      orderId: r.order_id,
      userId: r.user_id,
      userEmail: user?.email ?? null,
      priceKey: order?.price_key ?? '',
      amountMinor: r.amount_minor,
      currency: r.currency,
      /*
       * Read back from the row rather than recomputed. The thresholds are
       * configuration and will move; the reason an order was held in March has
       * to still read as it did in March.
       */
      reasons: Array.isArray(r.reasons) ? r.reasons : [],
      heldAt: r.held_at.toISOString(),
      paidAt: order?.paid_at?.toISOString() ?? null,
    });
  }
  return out;
}

export type HeldOrderDecision = 'release' | 'refuse';

/**
 * Releases a held order, or refuses it.
 *
 * `release` hands over what was bought, through the same `fulfilPaidOrder`
 * both channels and the recovery sweep use — so the exactly-once guarantees
 * are the ones already in place, not a second delivery path written for the
 * console.
 *
 * `refuse` delivers nothing and does NOT refund: the refund happens in Stripe,
 * by a person, and the refund webhook is what records it here. Saying so is
 * better than a button that implies it has been done — the same reason this
 * codebase refuses to draft an on-chain refund.
 */
export async function decideHeldOrder(params: {
  reviewId: string;
  decision: HeldOrderDecision;
  reason: string;
  actorId: string;
  actorRole: string;
}): Promise<{ reviewId: string; decision: HeldOrderDecision; delivered: boolean }> {
  if (!params.reason.trim()) throw new AppError('VALIDATION_FAILED', 'a reason is required');

  const review = await getOrderReview(params.reviewId);
  if (!review) throw new AppError('NOT_FOUND', 'no such review');
  if (review.decided_at) throw new AppError('CONFLICT', 'that order has already been decided');

  if (
    !(await decideOrderReview({
      id: review.id,
      decision: params.decision,
      actorId: params.actorId,
      reason: params.reason.trim(),
    }))
  ) {
    // Two operators in the same instant: only one UPDATE can match.
    throw new AppError('CONFLICT', 'that order has already been decided');
  }

  /*
   * Delivery happens after the decision is recorded, not before: if the grant
   * throws, the review must not be left open with the goods already handed
   * over. The reverse order would also let a retry deliver twice — which
   * `entitlement_batches` would refuse, but relying on that is how a guarantee
   * gets credited to the wrong layer.
   */
  const delivered = params.decision === 'release' ? await fulfilPaidOrder(review.order_id) : 'nothing_to_do';

  await writeAuditLog({
    actorId: params.actorId,
    actorRole: params.actorRole,
    action: `card_order.${params.decision}`,
    subjectType: 'order',
    subjectId: review.order_id,
    reason: params.reason.trim(),
    before: { held: true, reasons: review.reasons },
    after: { decision: params.decision, delivery: delivered },
  });

  return { reviewId: review.id, decision: params.decision, delivered: delivered === 'delivered' };
}
