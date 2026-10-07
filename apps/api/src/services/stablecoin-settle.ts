import {
  closeIntent,
  findOpenIntentForPayer,
  findTransferEvent,
  getQuote,
  markOrderPaid,
  markRefundOwed,
  recordAttempt,
  recordOrphanTransfer,
  recordTransferEvent,
  withTx,
  type StablecoinIntentRow,
  type StablecoinQuoteRow,
} from '@yuha/db';
import {
  sameAddress,
  verifyStablecoinPayment,
  type ChainObservation,
  type ObservedTransferLog,
  type PaymentExpectation,
  type Verdict,
} from '@yuha/providers';
import type { AppContext } from '../context.js';
import { fulfilPaidOrder, type FulfilResult } from './fulfilment.js';

/**
 * From an observed transfer to a paid order.
 *
 * Four steps, deliberately separate:
 *
 *   1. Identify the payment. Which Transfer in this transaction paid US?
 *      Answered by looking for our receiving address in the agreed logs, and
 *      refusing to guess when more than one does.
 *   2. Attribute. Which intent does it belong to? Answered by the database —
 *      the open intent for that payer on that chain, which is a unique index —
 *      never by matching on amount, which cannot distinguish two orders for
 *      the same product.
 *   3. Judge. The pure verifier, over the chain evidence. It decides; nothing
 *      here second-guesses it.
 *   4. Settle. One transaction writes the evidence, marks the order paid and
 *      closes the intent. Handing over what was bought is a SEPARATE
 *      transaction, so a crash between them leaves a paid order waiting for
 *      fulfilment rather than an unpaid order holding delivered goods — and
 *      the sweep finishes it.
 *
 * The rule that governs steps 1 and 3, learned expensively: money that arrived
 * and is not being attributed goes in `stablecoin_orphan_transfers`, NEVER in
 * `chain_transfer_events`. The latter's unique key is the anti-replay claim on
 * a payment; spending it on a row that delivers nothing makes the real payment
 * permanently unsettleable.
 */

export type SettleOutcome =
  | { kind: 'fulfilled'; orderId: string }
  | { kind: 'already_settled'; orderId: string | null }
  | { kind: 'waiting'; reason: string }
  | { kind: 'review'; orderId: string; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unattributed'; reason: string };

/**
 * Whether this outcome needs a person, and an exhaustive switch so that
 * answering it is not optional.
 *
 * A `review` outcome was added that reached no operator queue at all: the
 * function returned the word, the scanner logged the word, and nothing failed
 * to compile because nothing in the codebase ever consumed the set of
 * outcomes. This is that consumer. Adding a variant now breaks the build here
 * until somebody says where it belongs.
 */
export function needsOperator(outcome: SettleOutcome): boolean {
  switch (outcome.kind) {
    case 'fulfilled':
    case 'already_settled':
    case 'waiting':
      return false;
    case 'review':
    case 'rejected':
    case 'unattributed':
      return true;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled settle outcome ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** The configured receiving wallet, lowercased. */
function receiverOf(ctx: AppContext): string {
  return (ctx.config.STABLECOIN_RECEIVER_ADDRESS ?? '').toLowerCase();
}

/**
 * Every address a payment to us could legitimately name.
 *
 * The configured receiver AND the one written on the quote, because they can
 * differ: rotating the receiving wallet leaves live quotes naming the old one,
 * and a payment to it is still our money. The code looked only at the config
 * value, so after a rotation the "which log paid us" search found nothing and
 * the refusal branch recorded no evidence at all — the original defect, back.
 */
function ourReceivers(ctx: AppContext, quote?: StablecoinQuoteRow): string[] {
  const out = [receiverOf(ctx), quote?.receiver.toLowerCase() ?? ''].filter((a) => a.length > 0);
  return [...new Set(out)];
}

function logsPayingUs(obs: ChainObservation, receivers: string[]): ObservedTransferLog[] {
  return obs.transferLogs.filter((l) => receivers.some((r) => sameAddress(l.to, r)));
}

function expectationFrom(quote: StablecoinQuoteRow, intent: StablecoinIntentRow): PaymentExpectation {
  return {
    chainId: quote.chain_id,
    token: quote.token_address,
    receiver: quote.receiver,
    amountAtomic: BigInt(quote.amount_atomic),
    verifiedPayer: quote.payer,
    startBlock: BigInt(quote.start_block),
    expectedNonce: intent.predicted_nonce,
    quoteExpiresAt: quote.expires_at,
  };
}

/** Writes the record that money moved, for each log that paid us. */
async function orphan(
  obs: ChainObservation,
  payments: ObservedTransferLog[],
  reason: string,
  refusedForIntentId: string | null,
): Promise<void> {
  await withTx(async (tx) => {
    for (const p of payments) {
      await recordOrphanTransfer(
        {
          chainId: obs.transaction.chainId,
          txHash: obs.transaction.hash,
          logIndex: p.logIndex,
          tokenAddress: p.token,
          fromAddress: p.from,
          toAddress: p.to,
          amountAtomic: p.value.toString(),
          blockNumber: obs.block.number,
          blockHash: obs.block.hash,
          blockTime: new Date(obs.block.timestampMs),
          reason,
          refusedForIntentId,
        },
        tx,
      );
    }
  });
}

/**
 * Settles one observation.
 *
 * The caller supplies the chain evidence — it comes from the dual reader, so
 * two nodes have already agreed about the transaction, the receipt, the logs
 * and the block, and a disagreement never reaches here. That separation is why
 * this function is testable without a chain at all.
 */
export async function settleStablecoinObservation(
  ctx: AppContext,
  observation: ChainObservation,
): Promise<SettleOutcome> {
  const chainId = observation.transaction.chainId;

  /*
   * Which Transfer paid us, from the AGREED logs.
   *
   * Attribution used `observation.transaction.from` — the sender of the
   * transaction, which came from one node and was checked against nothing
   * before this lookup. A single altered field in a single RPC response made a
   * real payment unattributable, and the row written for it took the payment's
   * anti-replay key with it. The token contract's own record of who paid, in a
   * receipt both nodes describe identically, is the only sound answer.
   */
  const payments = logsPayingUs(observation, ourReceivers(ctx));
  if (payments.length === 0) {
    // Nothing in this transaction moved money to us. Nothing to attribute and
    // nothing to record: there is no payment here, mistaken or otherwise.
    return { kind: 'rejected', reason: 'no transfer to this service' };
  }
  if (payments.length > 1) {
    /*
     * Two Transfers to our address in one transaction. Deciding which one is
     * "the payment" means picking, and picking is what a previous version did
     * — `transferLogs[0]`, then the first match — leaving the node's array
     * order to choose which amount an operator was shown. Both are recorded
     * and neither is settled automatically.
     */
    await orphan(observation, payments, 'several_payments_in_one_transaction', null);
    return { kind: 'unattributed', reason: 'more than one transfer to this service in one transaction' };
  }
  const payment = payments[0]!;

  /*
   * Money this system has already settled, recognised before anything else.
   *
   * The scanner re-reads an overlapping range every pass, so seeing a settled
   * payment again is the ordinary case — and by then its intent is closed, so
   * an attribution lookup finds nothing. That used to be noticed by the
   * unattributed branch writing to `chain_transfer_events` and being told
   * `claimed: false`, which is exactly the write that made a real payment
   * permanently unsettleable. Asking is both clearer and free of that.
   */
  const already = await findTransferEvent({ chainId, txHash: observation.transaction.hash, logIndex: payment.logIndex });
  if (already) return { kind: 'already_settled', orderId: already.order_id };

  const intent = await findOpenIntentForPayer({ chainId, payer: payment.from });
  if (!intent) {
    /*
     * Money arrived from a wallet with nothing open. It may be a late payment
     * on an expired quote, a second payment, or a transfer from someone who
     * read the address off a block explorer. None of those should be guessed
     * at, and none of them should make the row disappear — an operator can
     * attach it to an order from the console.
     */
    await orphan(observation, payments, 'no_open_intent', null);
    return { kind: 'unattributed', reason: 'no open payment for that wallet' };
  }

  const quote = await getQuote(intent.quote_id);
  if (!quote) {
    await orphan(observation, payments, 'intent_without_quote', intent.id);
    return { kind: 'unattributed', reason: 'intent has no quote' };
  }

  const verdict: Verdict = verifyStablecoinPayment(expectationFrom(quote, intent), observation);

  if (verdict.outcome === 'reject') {
    /*
     * Refused, and written down when money actually moved to us — in the
     * orphan table, which claims nothing.
     *
     * Both writes in ONE transaction. They were two statements on two
     * connections, so a crash between them left an attempt row with no record
     * of the money, which is the state this branch exists to prevent.
     */
    const reallyPaid = observation.receipt.status === 1 ? logsPayingUs(observation, ourReceivers(ctx, quote)) : [];
    await withTx(async (tx) => {
      await recordAttempt(attemptFrom(observation, intent, verdict), tx);
      for (const p of reallyPaid) {
        await recordOrphanTransfer(
          {
            chainId,
            txHash: observation.transaction.hash,
            logIndex: p.logIndex,
            tokenAddress: p.token,
            fromAddress: p.from,
            toAddress: p.to,
            amountAtomic: p.value.toString(),
            blockNumber: observation.block.number,
            blockHash: observation.block.hash,
            blockTime: new Date(observation.block.timestampMs),
            reason: verdict.reason ?? 'rejected',
            refusedForIntentId: intent.id,
          },
          tx,
        );
      }
    });
    // The intent stays open: a rejected transaction is not this order's
    // payment, and closing the slot would strand the customer who is still
    // about to pay properly.
    return { kind: 'rejected', reason: verdict.reason ?? 'rejected' };
  }

  await recordAttempt(attemptFrom(observation, intent, verdict));

  if (verdict.outcome === 'pending_finality') {
    return { kind: 'waiting', reason: 'not finalized yet' };
  }

  const evidenceLogIndex = verdict.evidence?.logIndex ?? payment.logIndex;
  const evidenceValue = observation.transferLogs.find((l) => l.logIndex === evidenceLogIndex)?.value ?? payment.value;

  if (verdict.outcome === 'review') {
    return withTx(async (tx) => {
      const { claimed } = await recordTransferEvent(evidenceFrom(observation, quote, payment, evidenceLogIndex, evidenceValue, intent.id), tx);
      if (!claimed) return { kind: 'already_settled', orderId: intent.order_id };
      // The slot is freed and the order is NOT paid: a short payment does not
      // buy anything, and the flow of money is still on the record.
      await closeIntent({ intentId: intent.id, state: 'review' }, tx);
      return { kind: 'review', orderId: intent.order_id, reason: verdict.reason ?? 'review' };
    });
  }

  // fulfil
  const settled = await withTx(async (tx) => {
    const { claimed } = await recordTransferEvent(evidenceFrom(observation, quote, payment, evidenceLogIndex, evidenceValue, intent.id), tx);
    /*
     * This decides the OUTCOME, and it is not what makes delivery
     * exactly-once. Deleting it changes nothing about the money, which was
     * established by deleting it: `markOrderPaid` reports changed:false the
     * second time, `fulfilPaidOrder` checks `entitlement_granted_at`, and
     * `entitlement_batches` is unique on (user, source, order id) under
     * `lockUserEntitlements`. That last one is the guarantee; the three above
     * it are layers, and the comment used to credit the wrong one.
     */
    if (!claimed) return { kind: 'already' as const, orderId: intent.order_id };

    /*
     * The order is moved FIRST, and the intent is closed according to what
     * happened.
     *
     * The order of these two statements is the whole defect. The intent was
     * closed as `confirmed` and then `markOrderPaid` was consulted — so a
     * payment against an order that could not be moved (already paid,
     * refunded, partially refunded) committed an intent in `confirmed` with an
     * evidence row attached, which `listStablecoinReviews` does not show
     * (wrong state), `listOpenOrphanTransfers` does not show (it has an
     * intent), and the accounting export DOES show as settled revenue. The
     * caller was handed the word "review" and there was nothing in review.
     */
    const { changed } = await markOrderPaid(
      { orderId: intent.order_id, paymentIntentId: null, receiptUrl: null, customerId: null },
      tx,
    );
    if (!changed) {
      await closeIntent({ intentId: intent.id, state: 'review' }, tx);
      return { kind: 'unpayable' as const, orderId: intent.order_id };
    }
    await closeIntent({ intentId: intent.id, state: 'confirmed' }, tx);
    return { kind: 'paid' as const, orderId: intent.order_id };
  });

  if (settled.kind === 'already') return { kind: 'already_settled', orderId: settled.orderId };
  if (settled.kind === 'unpayable') {
    // In review, with its evidence row, where a person will see it.
    return { kind: 'review', orderId: settled.orderId, reason: 'payment for an order that is not payable' };
  }

  // Separate transaction, and independently idempotent: `entitlement_batches`
  // is unique on (user, source, order id), so a retry after a crash here hands
  // over once.
  const handed = await fulfilStablecoinOrder(settled.orderId);
  if (handed === 'duplicate_entitlement') {
    /*
     * Paid for something the buyer already holds. The order stays paid and
     * ungranted, so `listUngrantedPaidOrders` keeps showing it, and the money
     * is marked as owed back — because the one thing that must not happen is
     * the silent version: `markEntitlementGranted` called anyway, the order
     * reading as delivered, and nothing anywhere saying a refund is due.
     */
    await markRefundOwed(intent.id);
    return { kind: 'review', orderId: settled.orderId, reason: 'paid for something already held' };
  }
  return { kind: 'fulfilled', orderId: settled.orderId };
}

function attemptFrom(obs: ChainObservation, intent: StablecoinIntentRow, verdict: Verdict) {
  return {
    intentId: intent.id,
    txHash: obs.transaction.hash,
    nonce: obs.transaction.nonce,
    receiptStatus: obs.receipt.status,
    blockNumber: obs.transaction.blockNumber,
    blockHash: obs.transaction.blockHash,
    blockTime: new Date(obs.block.timestampMs),
    verdict: verdict.outcome === 'fulfil' ? 'fulfil' : (verdict.reason ?? verdict.outcome),
  };
}

function evidenceFrom(
  obs: ChainObservation,
  quote: StablecoinQuoteRow,
  payment: ObservedTransferLog,
  logIndex: number,
  value: bigint,
  intentId: string,
) {
  return {
    chainId: obs.transaction.chainId,
    txHash: obs.transaction.hash,
    logIndex,
    tokenAddress: quote.token_address,
    fromAddress: payment.from,
    // What ARRIVED, not what was expected. The fulfil path wrote
    // `quote.amount_atomic`, which is the same number only because fulfilment
    // requires exact equality — and the accounting export calls that column
    // `received_atomic`, so it must be what was received.
    toAddress: payment.to,
    amountAtomic: value.toString(),
    blockNumber: obs.block.number,
    blockHash: obs.block.hash,
    blockTime: new Date(obs.block.timestampMs),
    intentId,
  };
}

/**
 * Hands over what a settled order bought.
 *
 * `duplicate_entitlement` is money taken for something the buyer already
 * holds: `track_licenses` is unique on (track, buyer), so two orders for one
 * song can both be created before either is paid and only one can deliver.
 * That used to be thrown away — `grantLicense` reported it and the caller
 * marked the order delivered anyway — so the second order read as fulfilled
 * while delivering nothing, which also hid it from the ungranted-orders sweep.
 */
export async function fulfilStablecoinOrder(orderId: string): Promise<FulfilResult> {
  return fulfilPaidOrder(orderId);
}
