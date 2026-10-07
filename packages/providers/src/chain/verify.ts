import { decodeTransferCalldata } from './erc20.js';
import { sameAddress, tokenAt } from './tokens.js';

/**
 * Whether an observed transfer fulfils one order — a pure function, so every
 * refusal is a unit test and none of them depend on a mocked client.
 *
 * What this deliberately does NOT decide: which order an observation belongs
 * to. That binding is a database question (one open intent per payer per
 * chain, enforced by a unique index) and is answered before this is called.
 * Mixing the two would let a verifier that is "mostly right" quietly pick an
 * order, which is the shape of defect this whole design is arranged against.
 */
export interface PaymentExpectation {
  chainId: number;
  /** Whitelisted token address for the currency this order was quoted in. */
  token: string;
  receiver: string;
  amountAtomic: bigint;
  /** The wallet that proved control via SIWE. */
  verifiedPayer: string;
  /** Block height the quote started watching from. */
  startBlock: bigint;
  /**
   * The nonce `prepare-payment` predicted. Corroborating evidence only — see
   * the comment on the return type.
   */
  expectedNonce: number | null;
  quoteExpiresAt: Date;
}

export interface ObservedTransaction {
  hash: string;
  chainId: number;
  from: string;
  to: string | null;
  value: bigint;
  input: string;
  nonce: number;
  blockNumber: bigint;
  blockHash: string;
}

export interface ObservedTransferLog {
  token: string;
  from: string;
  to: string;
  value: bigint;
  logIndex: number;
  blockNumber: bigint;
}

export interface ChainObservation {
  transaction: ObservedTransaction;
  receipt: { status: 0 | 1; blockNumber: bigint; blockHash: string };
  /** Transfer events decoded from the receipt's logs. */
  transferLogs: ObservedTransferLog[];
  block: { number: bigint; hash: string; timestampMs: number };
  /**
   * The hash currently at that height, read independently of the receipt —
   * from the agreed header, not from the receipt itself. Comparing it with
   * something derived from the same read makes the comparison vacuous.
   */
  canonicalBlockHashAtHeight: string;
  /** Highest block the chain reports as finalized. */
  finalizedBlockNumber: bigint;
}

export type RejectReason =
  | 'receipt_failed'
  | 'wrong_chain'
  | 'token_not_whitelisted'
  | 'token_not_quoted'
  | 'calldata_not_transfer'
  | 'unexpected_value'
  | 'wrong_receiver'
  | 'wrong_payer'
  | 'no_transfer_log'
  | 'before_start_block'
  | 'reorged_out';

export type ReviewReason = 'amount_short' | 'amount_over' | 'included_after_expiry';

export interface Verdict {
  outcome: 'fulfil' | 'pending_finality' | 'review' | 'reject';
  reason?: RejectReason | ReviewReason;
  /** The globally unique citation for this payment: (chain, tx, log index). */
  evidence?: { chainId: number; txHash: string; logIndex: number };
  /**
   * Whether the predicted nonce held. Recorded and reported, never a condition
   * for fulfilment: a nonce in someone else's wallet is predicted, not
   * reserved, and any other dapp the owner touches while the quote is open
   * consumes it. Refusing an exact payment because the number moved would
   * strand an honest customer's money in our wallet attached to nothing.
   */
  nonceMatched: boolean;
}

export function verifyStablecoinPayment(exp: PaymentExpectation, obs: ChainObservation): Verdict {
  const { transaction: tx, receipt } = obs;
  const nonceMatched = exp.expectedNonce !== null && tx.nonce === exp.expectedNonce;
  const no = (reason: RejectReason): Verdict => ({ outcome: 'reject', reason, nonceMatched });

  // Executed successfully. Necessary, nowhere near sufficient.
  if (receipt.status !== 1) return no('receipt_failed');

  if (tx.chainId !== exp.chainId) return no('wrong_chain');

  // The token must be on the whitelist AND be the one this order was quoted
  // in — a real JPYC transfer does not settle an order priced in USDC.
  const token = tx.to ? tokenAt(tx.chainId, tx.to) : undefined;
  if (!token) return no('token_not_whitelisted');
  if (!sameAddress(tx.to!, exp.token)) return no('token_not_quoted');

  // A plain transfer and nothing else. Anything with a different selector, a
  // longer payload, or native value attached is not the call we constructed.
  const call = decodeTransferCalldata(tx.input);
  if (!call) return no('calldata_not_transfer');
  if (tx.value !== 0n) return no('unexpected_value');
  if (!sameAddress(call.to, exp.receiver)) return no('wrong_receiver');
  if (!sameAddress(tx.from, exp.verifiedPayer)) return no('wrong_payer');

  // Calldata is the sender's claim about what they asked for; the log is the
  // token contract's record of what happened. A hash with no matching log is
  // the "copied a public hash" case and must never fulfil anything.
  const log = obs.transferLogs.find(
    (l) =>
      sameAddress(l.token, exp.token) &&
      sameAddress(l.from, exp.verifiedPayer) &&
      sameAddress(l.to, exp.receiver) &&
      l.value === call.amountAtomic,
  );
  if (!log) return no('no_transfer_log');

  if (tx.blockNumber < exp.startBlock) return no('before_start_block');

  /*
   * The block the RECEIPT names must still be the block at that height.
   *
   * This compared `canonicalBlockHashAtHeight` with `obs.block.hash`, and the
   * only caller sets both from the same agreed header — so the condition was
   * structurally false and `reorged_out` could not fire from the production
   * path at all. It read exactly like a defence and was one of the five
   * "checks that cannot fail" this codebase has now shipped.
   *
   * Comparing the receipt's block hash against the hash at that height is the
   * real property: after a reorg a node can keep serving the old receipt —
   * same status, same logs, same height, a block hash no longer on the chain —
   * and both nodes agreeing on that stale copy is not reassurance. The scan
   * path checks the same thing before building the observation, deliberately:
   * there it stops the pass, here it is a verdict a unit test can produce.
   */
  if (obs.receipt.blockHash !== obs.canonicalBlockHashAtHeight) return no('reorged_out');

  const evidence = { chainId: tx.chainId, txHash: tx.hash, logIndex: log.logIndex };
  const held = (reason: ReviewReason): Verdict => ({ outcome: 'review', reason, evidence, nonceMatched });

  // Amount decided before finality, so a wrong amount is reported now rather
  // than after a wait that was never going to end in fulfilment.
  if (log.value < exp.amountAtomic) return held('amount_short');
  if (log.value > exp.amountAtomic) return held('amount_over');

  // The deadline is the inclusion block's timestamp. Not the browser clock,
  // not when an RPC first mentioned the transaction — both of which can make
  // a payment that was in time look late, or the reverse.
  if (obs.block.timestampMs > exp.quoteExpiresAt.getTime()) return held('included_after_expiry');

  // Last, because it is the only condition that resolves itself by waiting.
  if (obs.finalizedBlockNumber < tx.blockNumber) return { outcome: 'pending_finality', evidence, nonceMatched };

  return { outcome: 'fulfil', evidence, nonceMatched };
}
