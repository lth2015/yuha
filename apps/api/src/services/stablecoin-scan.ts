import { getChainCursor, setChainCursor } from '@yuha/db';
import {
  DualChainReader,
  decodeTransferLog,
  nextScanWindow,
  scanIncomingTransfers,
  type ChainObservation,
  type IncomingTransfer,
} from '@yuha/providers';
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
  const cursor = stored ?? BigInt(ctx.config.STABLECOIN_SCAN_START_BLOCK ?? 0);
  const window = nextScanWindow({
    cursor,
    safeHead: finalized.value,
    overlap: BigInt(ctx.config.STABLECOIN_SCAN_OVERLAP),
    maxSpan: BigInt(ctx.config.STABLECOIN_SCAN_MAX_SPAN),
  });
  if (!window) return { window: null, found: 0, settled: [], cursor };

  /*
   * Scanned with ONE node and verified with both.
   *
   * Asking both for the same log range doubles the cost and proves nothing
   * extra: whatever the primary finds is re-read through `agreedReceipt` and
   * `canonicalHashAt` before it can settle anything, so a primary that invents
   * a transfer gets caught there. What a second scan WOULD catch is a primary
   * that omits one — and that is covered differently, by the overlap re-read
   * on every pass plus the fact that an unattributed payment can also arrive
   * by the customer reporting its hash.
   */
  const transfers = await scanIncomingTransfers({
    node: reader.primary,
    chainId,
    receiver,
    tokenAddresses: tokensInUse(ctx),
    window,
  });

  const settled: SettleOutcome[] = [];
  let heldAt: ScanPass['heldAt'];

  for (const transfer of transfers.sort(byBlockThenLog)) {
    const observation = await observationFor(reader, transfer);
    if (!observation.ok) {
      /*
       * Stop here, and leave the cursor below this block.
       *
       * The alternative — note it and carry on — walks the cursor past a
       * payment the nodes could not agree about, and the overlap re-read is
       * only tens of blocks, so it would be lost rather than retried. A held
       * payment must still be there on the next pass.
       */
      heldAt = { blockNumber: transfer.blockNumber, reason: observation.reason };
      log('warn', 'stablecoin scan held', {
        blockNumber: transfer.blockNumber.toString(),
        txHash: transfer.txHash,
        reason: observation.reason,
      });
      break;
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

/** Only the currencies this deployment has switched on. */
function tokensInUse(ctx: AppContext): string[] {
  const out: string[] = [];
  if (ctx.config.STABLECOIN_JPYC_ENABLED) out.push('0xe7c3d8c9a439fede00d2600032d5db0be71c3c29');
  if (ctx.config.STABLECOIN_USDC_ENABLED) out.push('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
  return out;
}

type Observation = { ok: true; value: ChainObservation } | { ok: false; reason: string };

/**
 * Assembles the evidence the verifier judges, from both nodes.
 *
 * Everything that can disagree is asked of both: the receipt (status, block,
 * logs) and the hash at that height. The transaction body comes from the
 * primary, because every field of it that matters — sender, token, calldata,
 * amount — is checked again against the Transfer log in the agreed receipt.
 */
async function observationFor(reader: DualChainReader, transfer: IncomingTransfer): Promise<Observation> {
  const tx = await reader.primary.transaction(transfer.txHash);
  if (!tx) return { ok: false, reason: 'the primary no longer has that transaction' };
  if (tx.blockNumber === null || tx.blockHash === null) {
    return { ok: false, reason: 'the transaction is no longer in a block' };
  }

  const receipt = await reader.agreedReceipt(transfer.txHash);
  if (!receipt.agreed) return { ok: false, reason: receipt.reason };

  const canonical = await reader.canonicalHashAt(receipt.value.blockNumber);
  if (!canonical.agreed) return { ok: false, reason: canonical.reason };
  /*
   * The receipt's block must still BE the block at that height.
   *
   * After a reorg a node can keep serving the old receipt — same status, same
   * logs, same block number, and a block hash that is no longer on the chain.
   * Both nodes agreeing on that stale receipt is not reassurance; they can
   * both be serving the same stale copy. Without this comparison the evidence
   * reaching the verifier is internally consistent and historically wrong:
   * `block` and `canonicalBlockHashAtHeight` would both be the NEW hash, so
   * the verifier's own reorg check sees them agree and passes the payment.
   */
  if (receipt.value.blockHash !== canonical.value) {
    return {
      ok: false,
      reason: `the receipt names block ${receipt.value.blockHash}, but ${canonical.value} is at that height now`,
    };
  }

  const header = await reader.primary.blockAt(receipt.value.blockNumber);
  if (!header) return { ok: false, reason: 'the primary has no header for that block' };

  const finalized = await reader.finalizedHeight();
  if (!finalized.agreed) return { ok: false, reason: finalized.reason };

  const chainId = transfer.chainId;
  return {
    ok: true,
    value: {
      transaction: {
        hash: tx.hash,
        // A node may omit chainId on the transaction; the node's own
        // eth_chainId is what the scanner was configured against, and the
        // verifier compares it to the quote.
        chainId: tx.chainId ?? chainId,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        input: tx.input,
        nonce: tx.nonce,
        blockNumber: tx.blockNumber,
        blockHash: tx.blockHash,
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
      block: { number: header.number, hash: header.hash, timestampMs: header.timestampMs },
      canonicalBlockHashAtHeight: canonical.value,
      finalizedBlockNumber: finalized.value,
    },
  };
}
