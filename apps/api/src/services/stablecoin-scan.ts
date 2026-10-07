import { closeIntent, findExpiredOpenIntents, getChainCursor, setChainCursor } from '@yuha/db';
import {
  DualChainReader,
  decodeTransferLog,
  tokenByKey,
  verifyChainIds,
  verifyTokenDecimals,
  type TokenShapeProblem,
  type TokenSpec,
  nextScanWindow,
  scanIncomingTransfers,
  type ChainObservation,
  type IncomingTransfer,
} from '@yuha/providers';
import { AppError } from '@yuha/contracts';
import type { AppContext } from '../context.js';
import { settleStablecoinObservation, type SettleOutcome } from './stablecoin-settle.js';

/**
 * One pass of the scanner.
 *
 * Written as a function over a reader rather than as a loop, so the whole
 * thing is testable against a fake transport: a reorg, a node that lies, a
 * node that is behind, two nodes that disagree. None of those can be arranged
 * against a real endpoint on demand, and all of them decide whether money is
 * handed over.
 */

export const SCAN_STREAM = 'stablecoin_incoming';

/**
 * Frees the slot held by a quote nobody paid, once it is safely stale.
 *
 * One open intent per wallet per chain is what makes an incoming transfer
 * unambiguous, and nothing ever closed an abandoned one: `expired` was a state
 * with no caller. A customer who asked for a quote and walked away could not
 * buy anything else from that wallet, ever.
 *
 * Then this ran the instant a quote expired, which was worse. The scanner only
 * looks at FINALIZED blocks and only every interval, so a payment made inside
 * the quote window — which the verifier accepts — is routinely first seen a
 * minute after the window closed. Closing the intent on the deadline turned
 * those on-time payments into money from a wallet with nothing open: the
 * customer paid in time and received nothing, with no automatic repair.
 *
 * The grace period must cover finality plus the scan interval. It is a held
 * wallet slot against a lost payment, which is not a close call.
 *
 * Money that arrives after the grace has passed is still recorded — in
 * `stablecoin_orphan_transfers`, where an operator can attach it to the order.
 */
export async function expireStaleIntents(params: { graceSeconds: number; limit?: number }): Promise<number> {
  const stale = await findExpiredOpenIntents(params);
  let closed = 0;
  for (const intent of stale) {
    if (await closeIntent({ intentId: intent.id, state: 'expired' })) closed += 1;
  }
  return closed;
}

export interface ScanPass {
  /** Blocks examined this pass, or null when there was nothing to do. */
  window: { fromBlock: bigint; toBlock: bigint } | null;
  found: number;
  settled: SettleOutcome[];
  /** Why the pass stopped early, if it did. The cursor does not move past it. */
  heldAt?: { blockNumber: bigint; reason: string };
  cursor: bigint | undefined;
}

export async function runStablecoinScanPass(
  ctx: AppContext,
  reader: DualChainReader,
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void,
): Promise<ScanPass> {
  const chainId = ctx.config.STABLECOIN_CHAIN_ID;
  const receiver = ctx.config.STABLECOIN_RECEIVER_ADDRESS;
  if (!receiver) throw new Error('scanner started with no receiving address');

  /*
   * The safe head is FINALITY, not the chain tip.
   *
   * Scanning to the tip finds payments sooner and finds them in blocks that
   * may not survive, which then have to be unwound. If either node cannot do
   * finality — including the silent case where it serves `latest` for
   * `finalized` — this returns a refusal and the pass does nothing. That is
   * §8's "stop automatic confirmation and alert", and it is deliberately not
   * a fallback to waiting a few seconds, which a reorg goes straight through.
   */
  const finalized = await reader.finalizedHeight();
  if (!finalized.agreed) {
    log('error', 'stablecoin scan halted: finality unavailable', { reason: finalized.reason });
    return { window: null, found: 0, settled: [], cursor: await getChainCursor({ chainId, stream: SCAN_STREAM }) };
  }

  const stored = await getChainCursor({ chainId, stream: SCAN_STREAM });
  const configured = ctx.config.STABLECOIN_SCAN_START_BLOCK;

  /*
   * With no cursor and no configured start block, start watching from NOW.
   *
   * Defaulting to zero reads honestly — "from the beginning" — and is not slow
   * but impossible: Polygon is past seventy million blocks and a pass covers a
   * few hundred, so the scanner would never reach the present and no payment
   * would ever be seen. The cost of starting at the finalized head is that a
   * transfer sent before the first run is not picked up by the scan, which is
   * acceptable precisely because the feature was switched off until then; a
   * customer reporting the hash still finds it.
   *
   * Written down immediately, so a restart does not keep moving the start
   * forward and skipping whatever arrived in between.
   */
  if (stored === undefined && configured === undefined) {
    await setChainCursor({ chainId, stream: SCAN_STREAM, block: finalized.value });
    log('info', 'stablecoin scan starting from the current finalized head', {
      block: finalized.value.toString(),
    });
    return { window: null, found: 0, settled: [], cursor: finalized.value };
  }

  const cursor = stored ?? BigInt(configured!);
  const window = nextScanWindow({
    cursor,
    safeHead: finalized.value,
    overlap: BigInt(ctx.config.STABLECOIN_SCAN_OVERLAP),
    maxSpan: BigInt(ctx.config.STABLECOIN_SCAN_MAX_SPAN),
  });
  if (!window) return { window: null, found: 0, settled: [], cursor };

  /*
   * Discovery asks BOTH nodes, and takes the union.
   *
   * This asked the primary alone, and the comment justifying it argued that
   * anything the primary invents is caught by `agreedReceipt` before it can
   * settle — which is true, and is the wrong direction. The direction that was
   * not covered is OMISSION. A node that leaves a payment out of one
   * `eth_getLogs` answer loses it for good: the cursor advances, and the
   * overlap re-read asks the same node again, so after `overlap` blocks the
   * block is never in a window again. That left no row anywhere, not even in
   * an operator queue — the only invisible way to lose a payment in this
   * design. One node, one empty answer, once.
   *
   * The union is safe because being found is not being believed: every
   * transfer is re-read through `agreedReceipt` and `agreedTransaction` before
   * it can settle anything.
   */
  const transfers = await scanIncomingTransfers({
    fetchLogs: (p) => reader.unionLogs(p),
    chainId,
    receiver,
    tokenAddresses: tokensInUse(ctx).map((t) => t.address),
    window,
  });

  const settled: SettleOutcome[] = [];
  let heldAt: ScanPass['heldAt'];

  for (const transfer of transfers.sort(byBlockThenLog)) {
    const observation = await observationFor(reader, transfer);
    if (!observation.ok) {
      /*
       * Hold the CURSOR below this block, but keep going through the window.
       *
       * The loop used to `break`. A node that injects one fabricated log at
       * the bottom of the window then stops the pass before anything real in
       * it is reached, every pass, for good — a permanent halt from one node,
       * wearing the clothes of conservative behaviour. Every transfer is
       * verified independently, so settling the ones that do agree is sound;
       * what must not happen is the cursor moving past one that does not, and
       * that is the line below, not this one.
       */
      if (!heldAt || transfer.blockNumber < heldAt.blockNumber) {
        heldAt = { blockNumber: transfer.blockNumber, reason: observation.reason };
      }
      log('warn', 'stablecoin scan held', {
        blockNumber: transfer.blockNumber.toString(),
        txHash: transfer.txHash,
        reason: observation.reason,
      });
      continue;
    }
    settled.push(await settleStablecoinObservation(ctx, observation.value));
  }

  // Up to the window, or up to just below whatever is held.
  const next = heldAt ? maxOf(cursor, heldAt.blockNumber - 1n) : window.toBlock;
  if (next > cursor) await setChainCursor({ chainId, stream: SCAN_STREAM, block: next });

  return { window, found: transfers.length, settled, cursor: next, ...(heldAt ? { heldAt } : {}) };
}

function maxOf(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function byBlockThenLog(a: IncomingTransfer, b: IncomingTransfer): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

/**
 * Only the currencies this deployment has switched on.
 *
 * From the whitelist, not from literals written again here: the scanner's
 * filter and `tokenAt()` drifting apart would mean scanning for one token and
 * accepting another, silently.
 */
function tokensInUse(ctx: AppContext): TokenSpec[] {
  const chainId = ctx.config.STABLECOIN_CHAIN_ID;
  const out: TokenSpec[] = [];
  if (ctx.config.STABLECOIN_JPYC_ENABLED) out.push(tokenByKey('jpyc', chainId));
  if (ctx.config.STABLECOIN_USDC_ENABLED) out.push(tokenByKey('usdc', chainId));
  return out;
}

/**
 * Asks each enabled contract how many decimals it has, before any scanning.
 *
 * The constant in `tokens.ts` is what every quote is computed from, and a
 * wrong address or a mistyped digit there is worth a factor of a trillion. The
 * comment in that file claimed this check existed for a week before it did.
 */
export async function verifyConfiguredTokens(
  ctx: AppContext,
  reader: DualChainReader,
): Promise<TokenShapeProblem[]> {
  /*
   * Both endpoints are asked, and they must agree.
   *
   * This asked `reader.primary` alone — the single-node read in a design where
   * every other chain read insists on agreement, guarding the one constant
   * whose being wrong is worth a factor of a trillion. A compromised endpoint
   * could answer `0x12` for any address and the gate opened.
   *
   * A disagreement is reported as `unavailable` rather than `mismatch`: it
   * means we cannot establish the precision, not that we have established the
   * wrong one. Either way nothing is quoted, and `unavailable` is retried
   * instead of latching the process into a permanent stop.
   */
  const problems = await verifyTokenDecimals(async (params) => {
    const answer = await reader.agreedCall(params);
    if (!answer.agreed) throw new Error(answer.reason);
    return answer.value;
  }, tokensInUse(ctx));

  /*
   * And the endpoints are the chain this build was configured for.
   *
   * Nothing in the repository ever called `eth_chainId`, while a comment in
   * the RPC client claimed the caller compared it. The configuration requires
   * the two URLs to differ, which two endpoints onto the same wrong chain
   * satisfy perfectly.
   */
  for (const problem of await verifyChainIds(reader, ctx.config.STABLECOIN_CHAIN_ID)) {
    problems.push({ token: 'chain', kind: 'unavailable', reason: problem });
  }
  return problems;
}

/**
 * The same check, on the path that actually takes money.
 *
 * `verifyConfiguredTokens` had exactly one caller: the worker, once, at
 * startup. The worker scans. It is the API that computes every quote from
 * `token.decimals` and the API that settles a reported hash and delivers
 * against it — so "the scanner refuses to start" was true and beside the
 * point: a mistyped constant still produced a quote wrong by a factor of a
 * trillion, still served it to a customer, and still delivered on it.
 *
 * Memoised per process on success, because it is one eth_call per currency and
 * the answer cannot change for a deployed build. A `mismatch` is latched —
 * that is a wrong build and waiting will not fix it — while `unavailable` is
 * not, so a timeout refuses this one quote rather than the rest of the day's.
 */
const tokenGate = new Map<string, 'verified' | 'mismatch'>();

export function resetTokenGateForTests(): void {
  tokenGate.clear();
}

export async function assertConfiguredTokensVerified(ctx: AppContext, reader: DualChainReader): Promise<void> {
  const key = `${ctx.config.STABLECOIN_CHAIN_ID}:${tokensInUse(ctx)
    .map((t) => t.address)
    .sort()
    .join(',')}`;
  const known = tokenGate.get(key);
  if (known === 'verified') return;
  if (known === 'mismatch') {
    throw new AppError('SERVICE_DISABLED', 'stablecoin payments are misconfigured and have been stopped');
  }
  const problems = await verifyConfiguredTokens(ctx, reader);
  if (problems.length === 0) {
    tokenGate.set(key, 'verified');
    return;
  }
  if (problems.some((p) => p.kind === 'mismatch')) tokenGate.set(key, 'mismatch');
  throw new AppError(
    'SERVICE_DISABLED',
    'stablecoin payments are not available right now',
    { problems: problems.map((p) => `${p.token}: ${p.reason}`) },
  );
}

type Observation = { ok: true; value: ChainObservation } | { ok: false; reason: string };

/**
 * Settles one transaction the client pointed us at.
 *
 * A reported hash says WHERE TO LOOK and nothing else. Everything that decides
 * whether a payment is real is re-derived from the chain through the same dual
 * reader the scanner uses, and attribution comes from the open intent of the
 * transaction's own sender — so a hash copied from a block explorer, or
 * somebody else's genuine payment, resolves to that sender's order or to
 * nothing at all. It can never resolve to the person who pasted it.
 *
 * This exists for speed, not for authority: the scan finds the same payment
 * on its next pass regardless.
 */
export async function settleReportedTransaction(
  ctx: AppContext,
  reader: DualChainReader,
  txHash: string,
): Promise<SettleOutcome | { kind: 'not_found'; reason: string }> {
  const chainId = ctx.config.STABLECOIN_CHAIN_ID;
  const receiver = ctx.config.STABLECOIN_RECEIVER_ADDRESS;
  if (!receiver) return { kind: 'not_found', reason: 'no receiving wallet is configured' };

  /*
   * Located through the AGREED receipt, not the primary's.
   *
   * The earlier version read the primary alone here and argued the read only
   * locates the transfer. That is true of what it finds and false of what it
   * does not: a single node answering with a receipt whose logs do not pay us
   * turns a real reported payment into "that transaction does not pay this
   * service", which is the one answer a customer will believe and stop
   * retrying. One call to both nodes costs nothing here — this is a
   * request-path operation that happens once per customer click.
   */
  const located = await reader.agreedReceipt(txHash);
  if (!located.agreed) return { kind: 'not_found', reason: located.reason };

  const transfer = located.value.logs
    .map((l) => decodeTransferLog(l, chainId))
    .find((t) => t && t.to.toLowerCase() === receiver.toLowerCase());
  if (!transfer) {
    // Not a payment to us. Said plainly rather than treated as an error: a
    // customer can paste the wrong hash, and that is not a fault condition.
    return { kind: 'not_found', reason: 'that transaction does not pay this service' };
  }

  /*
   * The hash the customer reported, not the one the primary put in the log it
   * returned. `observationFor` keys the evidence on `transfer.txHash`, and a
   * primary free to choose it could have one real payment claimed by any
   * number of orders — the evidence unique key is the only thing stopping
   * that, and two of its three parts are agreed while this one was not.
   */
  const observation = await observationFor(reader, { ...transfer, txHash: txHash.toLowerCase() });
  if (!observation.ok) return { kind: 'not_found', reason: observation.reason };
  return settleStablecoinObservation(ctx, observation.value);
}

/**
 * Assembles the evidence the verifier judges, from both nodes.
 *
 * Everything that can disagree is asked of both: the transaction body, the
 * receipt (status, block, logs) and the header at that height. Nothing in the
 * returned observation is one node's word.
 */
async function observationFor(reader: DualChainReader, transfer: IncomingTransfer): Promise<Observation> {
  /*
   * The receipt first, because it is the only thing here both nodes agree on
   * that also names a block — and everything else is pinned to it.
   *
   * What this function used to do: take the whole transaction body from the
   * primary and pass it through untouched. Three fields of that body decide
   * money, and none of them were checked against anything.
   *
   *   `hash`        is two thirds of the evidence unique key, so a primary
   *                 returning a different hash for the same transaction made
   *                 one real payment claimable by unlimited orders.
   *   `blockNumber` is what the finality gate compares against, so a primary
   *                 reporting a lower number had an unfinalized payment
   *                 fulfilled — defeating the entire reorg defence, which is
   *                 "only settle finalized blocks" and nothing else.
   *   `blockHash`   was likewise unchecked.
   *
   * The comment on this function claimed every field that matters was checked
   * again against the agreed receipt. It was not; two independent reviews
   * demonstrated both with working proofs. They are taken from the agreed
   * receipt now, and the primary's body is used only for the fields the
   * verifier re-derives from the agreed log anyway.
   */
  const receipt = await reader.agreedReceipt(transfer.txHash);
  if (!receipt.agreed) return { ok: false, reason: receipt.reason };

  /*
   * The evidence log must be IN the agreed receipt, at the index claimed.
   *
   * In the scan path `transfer` comes from the primary's eth_getLogs, so its
   * hash and log index are the primary's word. Both nodes being asked for the
   * receipt of that hash is what makes the content agreed — but nothing tied
   * the log the scanner found to a log the receipt actually contains.
   */
  const inReceipt = receipt.value.logs.some(
    (l) => l.logIndex === transfer.logIndex && l.transactionHash === transfer.txHash.toLowerCase(),
  );
  if (!inReceipt) {
    return { ok: false, reason: `no log at index ${transfer.logIndex} in the agreed receipt for ${transfer.txHash}` };
  }

  /*
   * The transaction body, from BOTH nodes.
   *
   * It came from the primary alone, justified by the comment on this function
   * claiming every field that matters is re-checked against the agreed log.
   * Two of them are not: `from` is the ATTRIBUTION key, consumed before the
   * verifier runs, and `to`/`value`/`input` decide REJECTION, which is also a
   * decision about money that really arrived. One altered field in one
   * response was a remote kill switch on a real payment.
   */
  const agreedTx = await reader.agreedTransaction(transfer.txHash);
  if (!agreedTx.agreed) return { ok: false, reason: agreedTx.reason };
  const tx = agreedTx.value;
  if (tx.hash !== transfer.txHash.toLowerCase()) {
    // A node answering about a different transaction than the one asked for.
    return { ok: false, reason: `asked about ${transfer.txHash} and was told about ${tx.hash}` };
  }

  // The whole header, agreed: the hash because a reorg moves it, the
  // timestamp because quote expiry is judged on it.
  const header = await reader.agreedHeader(receipt.value.blockNumber);
  if (!header.agreed) return { ok: false, reason: header.reason };

  /*
   * The receipt's block must still BE the block at that height.
   *
   * After a reorg a node can keep serving the old receipt — same status, same
   * logs, same block number, and a block hash that is no longer on the chain.
   * Both nodes agreeing on that stale receipt is not reassurance; they can
   * both be serving the same stale copy.
   */
  if (receipt.value.blockHash !== header.value.hash) {
    return {
      ok: false,
      reason: `the receipt names block ${receipt.value.blockHash}, but ${header.value.hash} is at that height now`,
    };
  }

  const finalized = await reader.finalizedHeight();
  if (!finalized.agreed) return { ok: false, reason: finalized.reason };

  const chainId = transfer.chainId;
  return {
    ok: true,
    value: {
      transaction: {
        // The hash we asked about, not the one we were told.
        hash: transfer.txHash.toLowerCase(),
        /*
         * A node may legitimately omit `chainId` on a transaction. The
         * fallback is the configured chain, which is sound only because
         * `verifyConfiguredTokens` now really asks both endpoints for
         * `eth_chainId` and refuses to scan unless both are that chain — the
         * check this comment used to assert without it existing anywhere.
         */
        chainId: tx.chainId ?? chainId,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        input: tx.input,
        nonce: tx.nonce,
        // From the AGREED receipt. These decide finality and the start-block
        // bound; the primary does not get to choose them.
        blockNumber: receipt.value.blockNumber,
        blockHash: receipt.value.blockHash,
      },
      receipt: {
        status: receipt.value.status,
        blockNumber: receipt.value.blockNumber,
        blockHash: receipt.value.blockHash,
      },
      transferLogs: receipt.value.logs
        .map((l) => decodeTransferLog(l, chainId))
        .filter((t): t is IncomingTransfer => t !== undefined)
        .map((t) => ({
          token: t.tokenAddress,
          from: t.from,
          to: t.to,
          value: t.amountAtomic,
          logIndex: t.logIndex,
          blockNumber: t.blockNumber,
        })),
      block: header.value,
      canonicalBlockHashAtHeight: header.value.hash,
      finalizedBlockNumber: finalized.value,
    },
  };
}
