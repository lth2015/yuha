import type { RawLog } from './rpc.js';
import { sameAddress } from './tokens.js';

/**
 * Finding incoming transfers by scanning logs, rather than by being told.
 *
 * A client reporting a transaction hash is a hint that makes discovery faster.
 * It is never the mechanism: a browser that was closed, a wallet that
 * replaced the transaction, a payment sent from a second device — all of those
 * produce a real payment nobody reported, and a system that only knows what it
 * was told would leave that money unattributed.
 */

/** keccak256('Transfer(address,address,uint256)'), verified with viem. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface IncomingTransfer {
  chainId: number;
  tokenAddress: string;
  from: string;
  to: string;
  amountAtomic: bigint;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
}

/** A 32-byte topic word back to an address. */
function addressFromTopic(topic: string): string {
  return `0x${topic.slice(-40)}`;
}

/** The 32-byte topic word for an address, for filtering server-side. */
export function addressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/**
 * Decodes one Transfer log, or returns undefined when it is not one we can
 * read. Undefined rather than a throw: a token that emits a non-standard
 * Transfer should not stop a scan over a block range that also contains real
 * payments.
 */
export function decodeTransferLog(log: RawLog, chainId: number): IncomingTransfer | undefined {
  if (log.topics[0] !== TRANSFER_TOPIC) return undefined;
  // Indexed from, indexed to. A Transfer with them in `data` instead is not
  // the ERC-20 event shape and is not read.
  if (log.topics.length < 3) return undefined;
  if (!/^0x[0-9a-f]{1,64}$/.test(log.data)) return undefined;
  return {
    chainId,
    tokenAddress: log.address,
    from: addressFromTopic(log.topics[1]!),
    to: addressFromTopic(log.topics[2]!),
    amountAtomic: BigInt(log.data === '0x' ? '0x0' : log.data),
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
  };
}

export interface ScanWindow {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * The next range to scan.
 *
 * Two deliberate properties:
 *
 * It re-scans `overlap` blocks below the cursor every time. A range scanned
 * once near the head can have been reorganised since, and re-reading cheap
 * blocks is how that gets noticed; a cursor that only ever moves forward
 * cannot notice it at all.
 *
 * It never scans above `safeHead`, which the caller sets from the FINALIZED
 * height and not from `latest`. Scanning to the head finds payments sooner and
 * finds them in blocks that may not survive, which then have to be unwound.
 *
 * Returns undefined when there is nothing to do, so a caller cannot
 * accidentally request an inverted range — which some nodes answer as an
 * empty result rather than an error, making a gap look like no payments.
 */
export function nextScanWindow(params: {
  cursor: bigint;
  safeHead: bigint;
  overlap: bigint;
  maxSpan: bigint;
}): ScanWindow | undefined {
  const from = params.cursor > params.overlap ? params.cursor - params.overlap : 0n;
  if (params.safeHead < from) return undefined;
  const span = params.safeHead - from;
  const to = span > params.maxSpan ? from + params.maxSpan : params.safeHead;
  return { fromBlock: from, toBlock: to };
}

/**
 * Scans one window for transfers of whitelisted tokens into one address.
 *
 * The address and token filters go to the node so it does the work, and are
 * checked again here on what comes back: a filter is a request, and the answer
 * is what has to be verified. A node that returns extra logs — buggy, or
 * malicious — must not be able to introduce a transfer to somebody else's
 * address into our evidence.
 */
export async function scanIncomingTransfers(params: {
  /**
   * How to fetch logs — a function, not a node.
   *
   * It took a single `ChainNode`, which is what made discovery single-node:
   * one endpoint omitting a payment from one answer lost that payment
   * permanently, because the cursor moved on and the overlap re-read asked the
   * same endpoint again. The caller now passes `DualChainReader.unionLogs`,
   * and a test can pass anything.
   */
  fetchLogs: (params: {
    fromBlock: bigint;
    toBlock: bigint;
    address: string | string[];
    topics: (string | string[] | null)[];
  }) => Promise<RawLog[]>;
  chainId: number;
  receiver: string;
  tokenAddresses: string[];
  window: ScanWindow;
}): Promise<IncomingTransfer[]> {
  const logs = await params.fetchLogs({
    fromBlock: params.window.fromBlock,
    toBlock: params.window.toBlock,
    address: params.tokenAddresses.map((a) => a.toLowerCase()),
    // [topic0, from (any), to (ours)]
    topics: [TRANSFER_TOPIC, null, addressTopic(params.receiver)],
  });

  const out: IncomingTransfer[] = [];
  for (const log of logs) {
    const t = decodeTransferLog(log, params.chainId);
    if (!t) continue;
    if (!sameAddress(t.to, params.receiver)) continue;
    if (!params.tokenAddresses.some((a) => sameAddress(a, t.tokenAddress))) continue;
    if (t.blockNumber < params.window.fromBlock || t.blockNumber > params.window.toBlock) continue;
    out.push(t);
  }
  return out;
}
