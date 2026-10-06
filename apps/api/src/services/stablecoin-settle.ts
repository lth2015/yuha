import {
  closeIntent,
  findOpenIntentForPayer,
  getOrder,
  getQuote,
  markOrderPaid,
  recordAttempt,
  recordTransferEvent,
  withTx,
  type StablecoinIntentRow,
  type StablecoinQuoteRow,
} from '@yuha/db';
import {
  verifyStablecoinPayment,
  type ChainObservation,
  type PaymentExpectation,
  type Verdict,
} from '@yuha/providers';
import type { AppContext } from '../context.js';
import { grantEntitlementForOrder } from './fulfilment.js';

/**
 * From an observed transfer to a paid order.
 *
 * Three steps, deliberately separate:
 *
 *   1. Attribute. Which intent does this transfer belong to? Answered by the
 *      database — the open intent for that payer on that chain, which is a
 *      unique index — never by matching on amount, which cannot distinguish
 *      two orders for the same product.
 *   2. Judge. The pure verifier, over the chain evidence. It decides; nothing
 *      here second-guesses it.
 *   3. Settle. One transaction writes the evidence, closes the intent and
 *      marks the order paid. Handing over what was bought is a SEPARATE
 *      transaction, so a crash between them leaves a paid order waiting for
 *      fulfilment rather than an unpaid order holding delivered goods — and
 *      the sweep below finishes it.
 */

export type SettleOutcome =
  | { kind: 'fulfilled'; orderId: string }
  | { kind: 'already_settled'; orderId: string | null }
  | { kind: 'waiting'; reason: string }
  | { kind: 'review'; orderId: string; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unattributed'; reason: string };

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

/**
 * Settles one observation.
 *
 * The caller supplies the chain evidence — it comes from the dual reader, so
 * two nodes have already agreed about the receipt and the block hash, and a
 * disagreement never reaches here. That separation is why this function is
 * testable without a chain at all.
 */
export async function settleStablecoinObservation(
  ctx: AppContext,
  observation: ChainObservation,
): Promise<SettleOutcome> {
  const payer = observation.transaction.from;
  const chainId = observation.transaction.chainId;

  const intent = await findOpenIntentForPayer({ chainId, payer });
  if (!intent) {
    /*
     * Money arrived from a wallet with nothing open. Recorded as evidence with
     * no intent attached and left for a person: it may be a late payment on a
     * cancelled quote, a second payment, or a transfer from someone who read
     * the address off a block explorer. None of those should be guessed at,
     * and none of them should make the row disappear.
     */
    const { claimed } = await recordTransferEvent({
      chainId,
      txHash: observation.transaction.hash,
      logIndex: observation.transferLogs[0]?.logIndex ?? 0,
      tokenAddress: observation.transaction.to ?? '0x',
      fromAddress: payer,
      toAddress: observation.transferLogs[0]?.to ?? '0x',
      amountAtomic: (observation.transferLogs[0]?.value ?? 0n).toString(),
      blockNumber: observation.block.number,
      blockHash: observation.block.hash,
      blockTime: new Date(observation.block.timestampMs),
      intentId: null,
    });
    // No cast: the two outcomes have different shapes and the type is what
    // says so. An `as SettleOutcome` here would have compiled an object that
    // matched neither variant.
    return claimed
      ? { kind: 'unattributed', reason: 'no open payment for that wallet' }
      : { kind: 'already_settled', orderId: null };
  }

  const quote = await getQuote(intent.quote_id);
  if (!quote) return { kind: 'unattributed', reason: 'intent has no quote' };

  const verdict: Verdict = verifyStablecoinPayment(expectationFrom(quote, intent), observation);

  await recordAttempt({
    intentId: intent.id,
    txHash: observation.transaction.hash,
    nonce: observation.transaction.nonce,
    receiptStatus: observation.receipt.status,
    blockNumber: observation.transaction.blockNumber,
    blockHash: observation.transaction.blockHash,
    blockTime: new Date(observation.block.timestampMs),
    verdict: verdict.outcome === 'fulfil' ? 'fulfil' : (verdict.reason ?? verdict.outcome),
  });

  if (verdict.outcome === 'reject') {
    // The intent stays open: a rejected transaction is not this order's
    // payment, and closing the slot would strand the customer who is still
    // about to pay properly.
    return { kind: 'rejected', reason: verdict.reason ?? 'rejected' };
  }
  if (verdict.outcome === 'pending_finality') {
    return { kind: 'waiting', reason: 'not finalized yet' };
  }

  const evidenceLogIndex = verdict.evidence?.logIndex ?? 0;

  if (verdict.outcome === 'review') {
    return withTx(async (tx) => {
      const { claimed } = await recordTransferEvent(
        {
          chainId,
          txHash: observation.transaction.hash,
          logIndex: evidenceLogIndex,
          tokenAddress: quote.token_address,
          fromAddress: payer,
          toAddress: quote.receiver,
          amountAtomic: (observation.transferLogs.find((l) => l.logIndex === evidenceLogIndex)?.value ?? 0n).toString(),
          blockNumber: observation.block.number,
          blockHash: observation.block.hash,
          blockTime: new Date(observation.block.timestampMs),
          intentId: intent.id,
        },
        tx,
      );
      if (!claimed) return { kind: 'already_settled', orderId: intent.order_id };
      // The slot is freed and the order is NOT paid: a short payment does not
      // buy anything, and the flow of money is still on the record.
      await closeIntent({ intentId: intent.id, state: 'review' }, tx);
      return { kind: 'review', orderId: intent.order_id, reason: verdict.reason ?? 'review' };
    });
  }

  // fulfil
  const settled = await withTx(async (tx) => {
    const { claimed } = await recordTransferEvent(
      {
        chainId,
        txHash: observation.transaction.hash,
        logIndex: evidenceLogIndex,
        tokenAddress: quote.token_address,
        fromAddress: payer,
        toAddress: quote.receiver,
        amountAtomic: quote.amount_atomic,
        blockNumber: observation.block.number,
        blockHash: observation.block.hash,
        blockTime: new Date(observation.block.timestampMs),
        intentId: intent.id,
      },
      tx,
    );
    /*
     * This decides the OUTCOME, and it is not what makes delivery
     * exactly-once. Deleting it changes nothing about the money, which was
     * established by deleting it: `markOrderPaid` reports changed:false the
     * second time, `fulfilStablecoinOrder` checks `entitlement_granted_at`,
     * and `entitlement_batches` is unique on (user, source, order id) under
     * `lockUserEntitlements`. That last one is the guarantee; the three above
     * it are layers, and the comment used to credit the wrong one.
     *
     * What this does give is a truthful answer to the caller — a re-read of an
     * overlapping block range should report `already_settled`, not claim it
     * just fulfilled an order it did not.
     */
    if (!claimed) return { already: true as const, orderId: intent.order_id };

    await closeIntent({ intentId: intent.id, state: 'confirmed' }, tx);
    await markOrderPaid(
      {
        orderId: intent.order_id,
        paymentIntentId: null,
        receiptUrl: null,
        customerId: null,
      },
      tx,
    );
    return { already: false as const, orderId: intent.order_id };
  });

  if (settled.already) return { kind: 'already_settled', orderId: settled.orderId };

  // Separate transaction, and independently idempotent: `entitlement_batches`
  // is unique on (user, source, order id), so a retry after a crash here hands
  // over once.
  await fulfilStablecoinOrder(settled.orderId);
  return { kind: 'fulfilled', orderId: settled.orderId };
}

/**
 * Hands over what a settled order bought. Safe to call repeatedly — which is
 * the point, because the sweep calls it for anything the step above did not
 * reach.
 */
export async function fulfilStablecoinOrder(orderId: string): Promise<boolean> {
  return withTx(async (tx) => {
    const order = await getOrder(orderId, tx);
    if (!order || order.status !== 'paid' || order.entitlement_granted_at) return false;
    await grantEntitlementForOrder(order, tx);
    return true;
  });
}
