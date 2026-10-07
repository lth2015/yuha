import { AppError } from '@yuha/contracts';
import {
  confirmIntentByDecision,
  findLatestIntentForOrder,
  getOrder,
  getOrphanTransfer,
  getStablecoinReviewItem,
  listOpenOrphanTransfers,
  listRefundsOwed,
  listStablecoinAccounting,
  listStablecoinReviews,
  markOrderPaid,
  getQuote,
  markRefundOwed,
  recordTransferEvent,
  resolveReview,
  settleOrphanDecision,
  withTx,
  writeAuditLog,
  type AccountingRow,
} from '@yuha/db';
import { sameAddress, toDisplayAddress } from '@yuha/providers';
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
  unattributed: Array<{
    id: string;
    txHash: string;
    logIndex: number;
    from: string;
    token: string;
    amountAtomic: string;
    blockNumber: string;
    reason: string;
  }>;
  refundsOwed: Array<{ txHash: string; from: string; amountAtomic: string; owedSince: string; orderId: string | null }>;
}> {
  const [payments, orphans, owed] = await Promise.all([
    listStablecoinReviews(),
    listOpenOrphanTransfers(),
    listRefundsOwed(),
  ]);
  return {
    payments,
    unattributed: orphans.map((o) => ({
      // The id, because an operator can now ACT on these rows. The queue used
      // to carry no identifier at all, which is the honest shape of a list
      // nothing could be done about.
      id: o.id,
      txHash: o.tx_hash,
      logIndex: o.log_index,
      from: toDisplayAddress(o.from_address),
      token: toDisplayAddress(o.token_address),
      amountAtomic: o.amount_atomic,
      blockNumber: String(o.block_number),
      reason: o.reason,
    })),
    refundsOwed: owed.map((r) => ({
      txHash: r.tx_hash,
      from: toDisplayAddress(r.from_address),
      amountAtomic: r.amount_atomic,
      owedSince: r.refund_owed_at.toISOString(),
      orderId: r.order_id,
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
    /*
     * Looked up by id, not searched for in a page of the queue.
     *
     * This read `listStablecoinReviews(500)` and `.find()`'d in it — ordered
     * oldest-first — so past five hundred payments in review, a decision about
     * real money answered NOT_FOUND for a payment that was plainly there. The
     * console lists a hundred, so the two disagreed about what existed, and
     * one intent can occupy two rows of that page when it has two evidence
     * rows. A lookup cannot run out.
     */
    const item = await getStablecoinReviewItem(params.intentId, tx);
    if (!item) throw new AppError('NOT_FOUND', 'no payment in review with that id');

    if (params.decision === 'reject') {
      if (!(await resolveReview({ intentId: params.intentId, state: 'cancelled' }, tx))) {
        throw new AppError('CONFLICT', 'that payment was already resolved');
      }
      /*
       * Rejected money is money we are holding and should not keep.
       *
       * This changed a state and nothing else: the evidence row kept its
       * intent, so it was not unattributed; the state was no longer 'review',
       * so it was not in the queue. The money left every list with no record
       * that anything was owed. Stablecoin refunds are deliberately manual —
       * signed by hand on a hardware wallet, §13 — which is exactly why the
       * obligation has to be written down.
       */
      await markRefundOwed(params.intentId, tx);
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
    /*
     * `changed` read, not discarded. This is the same defect the settle path
     * was fixed for in the previous round and the console copy was missed:
     * `markOrderPaid` matches only pending/failed/canceled, so accepting a
     * payment on a refunded order moved nothing — and the operator was told
     * the payment had been accepted while the item left the only queue that
     * would have brought it back.
     */
    const { changed } = await markOrderPaid(
      { orderId: item.order_id, paymentIntentId: null, receiptUrl: null, customerId: null },
      tx,
    );
    if (!changed) {
      throw new AppError('CONFLICT', 'that order can no longer be marked paid — it is not in a payable state');
    }
    return item.order_id;
  });

  // Outside the transaction and independently idempotent, the same way a
  // scanned settlement hands over: `entitlement_batches` is unique on
  // (user, source, order id).
  if (orderId && (await fulfilStablecoinOrder(orderId)) === 'duplicate_entitlement') {
    // Accepted, and what it bought was already held. Recorded as owed back
    // rather than marked delivered, the same as the automatic path.
    await markRefundOwed(params.intentId);
  }

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

export type OrphanDecision = 'attach_to_order' | 'dismiss';

/**
 * What an operator can do about money that arrived and settled nothing.
 *
 * Before this existed, the unattributed queue was a list and nothing more:
 * `decideStablecoinReview` only matched intents already in state `review`, so
 * a transfer that could not be attributed — a payment that arrived after its
 * quote expired, one refused as the wrong currency, one sent straight from a
 * block explorer — had no action anywhere in the product. The money sat in the
 * wallet and the only remedy was SQL by hand. Three separate routine
 * sequences ended there.
 *
 * Attaching is a deliberate act with a reason and an audit row, and it runs the
 * same settlement the scanner does: evidence row, intent confirmed, order
 * paid, entitlement handed over. It refuses to cross a currency or a chain —
 * money in the wrong token against a JPY order is a refund question, not an
 * attachment — and it refuses an order that is not in a payable state, rather
 * than reporting success and moving nothing.
 */
export async function decideOrphanTransfer(params: {
  orphanId: string;
  decision: OrphanDecision;
  orderId?: string;
  reason: string;
  actorId: string;
  actorRole: string;
}): Promise<{ orphanId: string; decision: OrphanDecision; orderId: string | null }> {
  if (!params.reason.trim()) throw new AppError('VALIDATION_FAILED', 'a reason is required');

  const orphan = await getOrphanTransfer(params.orphanId);
  if (!orphan) throw new AppError('NOT_FOUND', 'no such transfer');
  if (orphan.settled_at || orphan.claimed_at || orphan.dismissed_at) {
    throw new AppError('CONFLICT', 'that transfer has already been decided');
  }

  if (params.decision === 'dismiss') {
    if (!(await settleOrphanDecision({ id: orphan.id, decision: 'dismissed', actorId: params.actorId, note: params.reason }))) {
      throw new AppError('CONFLICT', 'that transfer has already been decided');
    }
    await writeAuditLog({
      actorId: params.actorId,
      actorRole: params.actorRole,
      action: 'stablecoin_orphan.dismiss',
      subjectType: 'stablecoin_orphan_transfer',
      subjectId: orphan.id,
      reason: params.reason,
      before: { settled: false },
      after: { dismissed: true, txHash: orphan.tx_hash, amountAtomic: orphan.amount_atomic },
    });
    return { orphanId: orphan.id, decision: params.decision, orderId: null };
  }

  if (!params.orderId) throw new AppError('VALIDATION_FAILED', 'attaching needs an order');
  const order = await getOrder(params.orderId);
  if (!order) throw new AppError('NOT_FOUND', 'order not found');
  const intent = await findLatestIntentForOrder(order.id);
  if (!intent) throw new AppError('VALIDATION_FAILED', 'that order was never quoted in stablecoin');
  const quote = await getQuote(intent.quote_id);
  if (!quote) throw new AppError('VALIDATION_FAILED', 'that order has no quote to attach against');
  if (quote.chain_id !== orphan.chain_id || !sameAddress(quote.token_address, orphan.token_address)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'that money is in a different currency or on a different chain from the order — it is a refund, not a payment',
    );
  }

  const outcome = await withTx(async (tx) => {
    /*
     * The operator's claim on the row goes FIRST.
     *
     * `recordTransferEvent` dates any orphan row for the same transfer as
     * settled — which is right, it stops the queue showing money that has
     * since been delivered — and `settleOrphanDecision` only matches a row
     * nobody has decided about. In the other order this function conflicted
     * with itself.
     */
    if (
      !(await settleOrphanDecision(
        { id: orphan.id, decision: 'claimed', actorId: params.actorId, orderId: order.id, note: params.reason },
        tx,
      ))
    ) {
      throw new AppError('CONFLICT', 'that transfer has already been decided');
    }

    const { claimed } = await recordTransferEvent(
      {
        chainId: orphan.chain_id,
        txHash: orphan.tx_hash,
        logIndex: orphan.log_index,
        tokenAddress: orphan.token_address,
        fromAddress: orphan.from_address,
        toAddress: orphan.to_address,
        amountAtomic: orphan.amount_atomic,
        blockNumber: BigInt(orphan.block_number),
        blockHash: orphan.block_hash,
        blockTime: orphan.block_time,
        intentId: intent.id,
      },
      tx,
    );
    // The anti-replay key, doing its job: this transfer already paid for
    // something. An operator must not be able to spend it twice.
    if (!claimed) throw new AppError('CONFLICT', 'that transfer has already been credited to an order');

    const { changed } = await markOrderPaid(
      { orderId: order.id, paymentIntentId: null, receiptUrl: null, customerId: null },
      tx,
    );
    if (!changed) {
      throw new AppError('CONFLICT', 'that order can no longer be marked paid — it is not in a payable state');
    }
    await confirmIntentByDecision(intent.id, tx);
    return order.id;
  });

  if ((await fulfilStablecoinOrder(outcome)) === 'duplicate_entitlement') {
    await markRefundOwed(intent.id);
  }

  await writeAuditLog({
    actorId: params.actorId,
    actorRole: params.actorRole,
    action: 'stablecoin_orphan.attach_to_order',
    subjectType: 'stablecoin_orphan_transfer',
    subjectId: orphan.id,
    reason: params.reason,
    before: { orderStatus: order.status },
    after: { orderId: order.id, intentId: intent.id, amountAtomic: orphan.amount_atomic, expected: quote.amount_atomic },
  });

  return { orphanId: orphan.id, decision: params.decision, orderId: outcome };
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
