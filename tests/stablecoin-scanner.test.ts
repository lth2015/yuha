/**
 * Scanning for payments nobody told us about.
 *
 * A reported transaction hash is a hint. The scan is the mechanism, because a
 * closed browser, a replaced transaction or a payment sent from another device
 * all produce real money arriving with nothing reported — and a system that
 * only knows what it was told leaves that unattributed.
 */
import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import {
  ChainNode,
  TRANSFER_TOPIC,
  addressTopic,
  decodeTransferLog,
  nextScanWindow,
  scanIncomingTransfers,
  type JsonRpcParams,
  type JsonRpcTransport,
  type RawLog,
} from '@yuha/providers';

const RECEIVER = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const STRANGER = '0x3333333333333333333333333333333333333333';
const JPYC = '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29';
const FAKE = '0x4444444444444444444444444444444444444444';

const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;

function logOf(over: Partial<{ token: string; from: string; to: string; amount: bigint; block: number; index: number; topics: string[] }> = {}) {
  const token = over.token ?? JPYC;
  const amount = over.amount ?? 980n * 10n ** 18n;
  return {
    address: token,
    topics: over.topics ?? [TRANSFER_TOPIC, addressTopic(over.from ?? PAYER), addressTopic(over.to ?? RECEIVER)],
    data: hex(amount),
    blockNumber: hex(over.block ?? 250),
    blockHash: `0x${'a'.repeat(64)}`,
    transactionHash: `0x${'b'.repeat(64)}`,
    logIndex: hex(over.index ?? 0),
  };
}

/** A node that returns a fixed log list and records what it was asked for. */
function nodeReturning(logs: unknown[]): { node: ChainNode; asked: JsonRpcParams[] } {
  const asked: JsonRpcParams[] = [];
  const transport: JsonRpcTransport = {
    label: 'fake',
    async request(method: string, params: JsonRpcParams) {
      asked.push(params);
      if (method === 'eth_getLogs') return logs;
      throw new Error(`unexpected ${method}`);
    },
  };
  return { node: new ChainNode(transport), asked };
}

describe('the Transfer topic', () => {
  it('is the hash of the real event signature, not a constant copied from memory', () => {
    expect(TRANSFER_TOPIC).toBe(keccak256(toHex('Transfer(address,address,uint256)')));
  });
});

describe('decoding one log', () => {
  const raw = (o: ReturnType<typeof logOf>): RawLog => ({
    address: o.address,
    topics: o.topics,
    data: o.data,
    blockNumber: BigInt(o.blockNumber),
    blockHash: o.blockHash,
    transactionHash: o.transactionHash,
    logIndex: Number(BigInt(o.logIndex)),
  });

  it('reads sender, recipient and amount', () => {
    const t = decodeTransferLog(raw(logOf()), 137)!;
    expect(t.from).toBe(PAYER);
    expect(t.to).toBe(RECEIVER);
    expect(t.amountAtomic).toBe(980n * 10n ** 18n);
  });

  it('ignores an event that is not Transfer', () => {
    expect(decodeTransferLog(raw(logOf({ topics: [keccak256(toHex('Approval(address,address,uint256)'))] })), 137)).toBeUndefined();
  });

  it('ignores a Transfer whose addresses are not indexed', () => {
    // Three topics is the ERC-20 shape. Fewer means from/to are in `data`,
    // which is a different event with the same name.
    expect(decodeTransferLog(raw(logOf({ topics: [TRANSFER_TOPIC, addressTopic(PAYER)] })), 137)).toBeUndefined();
  });

  it('skips a malformed amount rather than throwing away the whole scan', () => {
    const bad = raw(logOf());
    bad.data = '0xnot-a-number';
    expect(decodeTransferLog(bad, 137)).toBeUndefined();
  });
});

describe('the scan window', () => {
  it('re-reads blocks below the cursor, so a reorg near the head is noticed', () => {
    const w = nextScanWindow({ cursor: 1_000n, safeHead: 1_100n, overlap: 20n, maxSpan: 1_000n })!;
    expect(w.fromBlock).toBe(980n);
    expect(w.toBlock).toBe(1_100n);
  });

  it('never goes above the safe head, which is finality and not the tip', () => {
    const w = nextScanWindow({ cursor: 1_000n, safeHead: 1_010n, overlap: 20n, maxSpan: 1_000n })!;
    expect(w.toBlock).toBe(1_010n);
  });

  it('caps the span so one call cannot ask for a million blocks', () => {
    const w = nextScanWindow({ cursor: 0n, safeHead: 5_000_000n, overlap: 0n, maxSpan: 2_000n })!;
    expect(w.toBlock - w.fromBlock).toBe(2_000n);
  });

  it('does not clamp below zero near the genesis end', () => {
    const w = nextScanWindow({ cursor: 5n, safeHead: 100n, overlap: 20n, maxSpan: 1_000n })!;
    expect(w.fromBlock).toBe(0n);
  });

  it('returns nothing rather than an inverted range', () => {
    // Some nodes answer an inverted range with an empty result instead of an
    // error, which would make a gap look like "no payments".
    expect(nextScanWindow({ cursor: 1_000n, safeHead: 500n, overlap: 0n, maxSpan: 1_000n })).toBeUndefined();
  });
});

describe('scanning a window', () => {
  it('asks the node to filter by token and recipient', async () => {
    const { node, asked } = nodeReturning([]);
    await scanIncomingTransfers({
      node,
      chainId: 137,
      receiver: RECEIVER,
      tokenAddresses: [JPYC],
      window: { fromBlock: 100n, toBlock: 200n },
    });
    const filter = asked[0]![0] as Record<string, unknown>;
    expect(filter['address']).toEqual([JPYC]);
    expect(filter['topics']).toEqual([TRANSFER_TOPIC, null, addressTopic(RECEIVER)]);
    expect(filter['fromBlock']).toBe('0x64');
  });

  it('finds a payment the client never reported', async () => {
    const { node } = nodeReturning([logOf()]);
    const found = await scanIncomingTransfers({
      node,
      chainId: 137,
      receiver: RECEIVER,
      tokenAddresses: [JPYC],
      window: { fromBlock: 200n, toBlock: 300n },
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.amountAtomic).toBe(980n * 10n ** 18n);
  });

  it('drops a transfer to somebody else even though the filter asked for ours', async () => {
    // A filter is a request; the answer is what has to be verified. A node
    // that returns extra logs must not get a stranger's transfer into our
    // evidence.
    const { node } = nodeReturning([logOf({ to: STRANGER })]);
    const found = await scanIncomingTransfers({
      node,
      chainId: 137,
      receiver: RECEIVER,
      tokenAddresses: [JPYC],
      window: { fromBlock: 200n, toBlock: 300n },
    });
    expect(found).toHaveLength(0);
  });

  it('drops a same-named token at a different address', async () => {
    const { node } = nodeReturning([logOf({ token: FAKE })]);
    const found = await scanIncomingTransfers({
      node,
      chainId: 137,
      receiver: RECEIVER,
      tokenAddresses: [JPYC],
      window: { fromBlock: 200n, toBlock: 300n },
    });
    expect(found).toHaveLength(0);
  });

  it('drops a log from outside the window it asked for', async () => {
    const { node } = nodeReturning([logOf({ block: 5_000 })]);
    const found = await scanIncomingTransfers({
      node,
      chainId: 137,
      receiver: RECEIVER,
      tokenAddresses: [JPYC],
      window: { fromBlock: 200n, toBlock: 300n },
    });
    expect(found).toHaveLength(0);
  });

  it('keeps two transfers in one transaction apart by log index', async () => {
    const { node } = nodeReturning([logOf({ index: 0 }), logOf({ index: 4, amount: 1n })]);
    const found = await scanIncomingTransfers({
      node,
      chainId: 137,
      receiver: RECEIVER,
      tokenAddresses: [JPYC],
      window: { fromBlock: 200n, toBlock: 300n },
    });
    expect(found.map((f) => f.logIndex)).toEqual([0, 4]);
  });
});
