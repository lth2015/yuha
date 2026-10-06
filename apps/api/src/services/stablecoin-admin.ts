import { AppError } from '@yuha/contracts';
import {
  getOrder,
  listStablecoinAccounting,
  listStablecoinReviews,
  listUnattributedTransfers,
  markOrderPaid,
  resolveReview,
  withTx,
  writeAuditLog,
  type AccountingRow,
} from '@yuha/db';
import { toDisplayAddress } from '@yuha/providers';
import { fulfilStablecoinOrder } from './stablecoin-settle.js';

/**
 * What an operator can do about a payment the system would not decide alone.
 *
 * Short, over, late and unattributed money all land in review rather than
 * being guessed at, and every resolution here is a deliberate act with a
 * reason attached and an audit row behind it.
 */

export async function stablecoinReviewQueue(): Promise<{
  payments: Awaited<ReturnType<typeof listStablecoinReviews>>;
  unattributed: Array<{ txHash: string; from: string; amountAtomic: string; blockNumber: string }>;
}> {
  const [payments, orphans] = await Promise.all([listStablecoinReviews(), listUnattributedTransfers()]);
  return {
    payments,
    unattributed: orphans.map((o) => ({
      txHash: o.tx_hash,
      from: toDisplayAddress(o.from_address),
      amountAtomic: o.amount_atomic,
      blockNumber: String(o.block_number),
    })),
  };
}

export type ReviewDecision = 'accept_as_paid' | 'reject';

export async function decideStablecoinReview(
  params: { intentId: string; decision: ReviewDecision; reason: string; actorId: string; actorRole: string },
): Promise<{ intentId: string; decision: ReviewDecision; orderId: string | null }> {
  if (!params.reason.trim()) {
    // Same rule the rest of the console follows: a privileged action without
    // a stated reason is refused, because the audit row is the point.
    throw new AppError('VALIDATION_FAILED', 'a reason is required');
  }

  const orderId = await withTx(async (tx) => {
    const queue = await listStablecoinReviews(500);
    const item = queue.find((q) => q.intent_id === params.intentId);
    if (!item) throw new AppError('NOT_FOUND', 'no payment in review with that id');

    if (params.decision === 'reject') {
      await resolveReview({ intentId: params.intentId, state: 'cancelled' }, tx);
      return null;
    }

    /*
     * Accepting a short or late payment delivers goods for money that did not
     * match the quote. That is a judgement a person is allowed to make — a
     * customer who underpaid by a hundredth of a yen should not be stuck — and
     * it is exactly why it is not automatic, why it needs a reason, and why
     * the audit row below names who did it.
     */
    /*
     * `resolveReview` only matches a row still in review, and this checks that
     * it did. Sequentially the lookup above already refuses a second decision,
     * so deleting this breaks no test — which was verified. What it guards is
     * two operators deciding in the same instant, where both reads see
     * 'review' and only this UPDATE can be the one that wins; that
     * interleaving could not be produced in the test environment, so this is
     * reasoned rather than demonstrated, and said so here instead of being
     * left to look proven.
     */
    if (!(await resolveReview({ intentId: params.intentId, state: 'confirmed' }, tx))) {
      throw new AppError('CONFLICT', 'that payment was already resolved');
    }
    await markOrderPaid(
      { orderId: item.order_id, paymentIntentId: null, receiptUrl: null, customerId: null },
      tx,
    );
    return item.order_id;
  });

  // Outside the transaction and independently idempotent, the same way a
  // scanned settlement hands over: `entitlement_batches` is unique on
  // (user, source, order id).
  if (orderId) await fulfilStablecoinOrder(orderId);

  await writeAuditLog({
    actorId: params.actorId,
    actorRole: params.actorRole,
    action: `stablecoin_payment.${params.decision}`,
    subjectType: 'stablecoin_intent',
    subjectId: params.intentId,
    reason: params.reason,
    before: { state: 'review' },
    after: { state: params.decision === 'reject' ? 'cancelled' : 'confirmed', orderId },
  });

  return { intentId: params.intentId, decision: params.decision, orderId };
}

/** A line per settled payment, with the dates kept apart. */
export async function stablecoinAccountingCsv(params: { from: Date; to: Date }): Promise<string> {
  const rows = await listStablecoinAccounting(params);
  const header = [
    'order_id',
    'sku',
    'track_id',
    'contract_price_jpy',
    'token',
    'chain_id',
    'token_contract',
    'received_atomic',
    'payer',
    'receiver',
    'tx_hash',
    'log_index',
    'block_time_utc',
    'payment_received_at_utc',
    'service_delivered_at_utc',
    // Deliberately absent: a revenue_recognised column. §13 leaves that policy
    // to the tax accountant, per SKU, and a column here would decide it.
    'quote_rate',
    'quote_rate_provider',
    'quote_rate_observed_at_utc',
  ];
  const lines = [header.join(',')];
  for (const r of rows as AccountingRow[]) {
    lines.push(
      [
        r.order_id,
        r.price_key,
        r.track_id ?? '',
        String(r.price_jpy),
        r.token_key,
        String(r.chain_id),
        r.token_address,
        r.received_atomic,
        r.payer,
        r.receiver,
        r.tx_hash,
        String(r.log_index),
        iso(r.block_time),
        iso(r.payment_received_at),
        iso(r.service_delivered_at),
        r.rate_text ?? '',
        r.rate_provider ?? '',
        iso(r.rate_observed_at),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}

function iso(d: Date | null): string {
  return d ? d.toISOString() : '';
}

/** Quoted only when it has to be, and quotes doubled, as RFC 4180 wants. */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
