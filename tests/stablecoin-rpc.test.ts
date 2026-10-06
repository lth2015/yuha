/**
 * Two nodes, and what it takes for them to be believed.
 *
 * Every case here is arranged with a fake transport, because none of them can
 * be arranged against a real endpoint on demand: a node that does not
 * implement the finalized tag, a node on a different chain, a node that is
 * behind, a node that answers null. Those are exactly the situations where
 * fulfilling a payment would be wrong, so they are the ones that have to be
 * testable.
 */
import { describe, expect, it } from 'vitest';
import {
  ChainNode,
  DualChainReader,
  probeFinality,
  type JsonRpcParams,
  type JsonRpcTransport,
} from '@yuha/providers';

const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;

interface NodeState {
  latest: number;
  finalized: number | 'unsupported' | 'null' | 'above-latest' | 'equals-latest';
  /** blockNumber -> hash. Missing means the node has no block there. */
  hashes: Record<number, string>;
  receipts?: Record<string, unknown>;
}

/** A node that answers from a plain object, and lies in the ways real ones do. */
function fakeNode(label: string, state: NodeState): ChainNode {
  const transport: JsonRpcTransport = {
    label,
    async request(method: string, params: JsonRpcParams): Promise<unknown> {
      switch (method) {
        case 'eth_blockNumber':
          return hex(state.latest);
        case 'eth_getBlockByNumber': {
          const tag = params[0] as string;
          if (tag === 'finalized') {
            if (state.finalized === 'unsupported') throw new Error('the method does not exist');
            if (state.finalized === 'null') return null;
            const n =
              state.finalized === 'above-latest'
                ? state.latest + 50
                : state.finalized === 'equals-latest'
                  ? state.latest
                  : state.finalized;
            return { number: hex(n), hash: state.hashes[n] ?? `0x${'f'.repeat(64)}`, timestamp: hex(1_700_000_000) };
          }
          if (tag === 'latest') {
            return { number: hex(state.latest), hash: state.hashes[state.latest]!, timestamp: hex(1_700_000_000) };
          }
          const n = Number(BigInt(tag));
          const h = state.hashes[n];
          return h ? { number: hex(n), hash: h, timestamp: hex(1_700_000_000) } : null;
        }
        case 'eth_getTransactionReceipt':
          return state.receipts?.[params[0] as string] ?? null;
        default:
          throw new Error(`unexpected method ${method}`);
      }
    },
  };
  return new ChainNode(transport);
}

const H = (seed: string) => `0x${seed.repeat(64).slice(0, 64)}`;

describe('the finality probe', () => {
  it('accepts a node that implements the tag', async () => {
    const p = await probeFinality(fakeNode('a', { latest: 200, finalized: 180, hashes: { 180: H('1'), 200: H('2') } }));
    expect(p.supported).toBe(true);
    expect(p.height).toBe(180n);
  });

  it('refuses a node that does not implement it, and says so', async () => {
    // §8: an unsupported finalized tag stops automatic confirmation and
    // raises an alert. It never becomes "wait a few seconds" — that is not a
    // weaker finality, it is a different thing a reorg goes straight through.
    const p = await probeFinality(fakeNode('a', { latest: 200, finalized: 'unsupported', hashes: { 200: H('2') } }));
    expect(p.supported).toBe(false);
    expect(p.reason).toMatch(/does not support the finalized tag/);
  });

  it('refuses a node that answers null for it', async () => {
    const p = await probeFinality(fakeNode('a', { latest: 200, finalized: 'null', hashes: { 200: H('2') } }));
    expect(p.supported).toBe(false);
    // The exact reason, not /null/: that loose pattern also matched a
    // TypeError message ("Cannot read properties of null") thrown by the next
    // line once the explicit check was removed, so the test passed while the
    // check it was for did not exist.
    expect(p.reason).toBe('the node answered null for the finalized tag');
  });

  it('refuses a node that serves latest for finalized', async () => {
    /*
     * The failure that actually happens: a provider without Heimdall v2
     * milestone finality answers `finalized` with its own head. The call
     * succeeds, the shape is right, nothing errors — and every settlement
     * decision is then made on a probabilistic confirmation while the code
     * believes it has finality.
     *
     * This check was missing. It was found by reading Polygon provider
     * documentation rather than by testing, which is the uncomfortable part:
     * the probe had three cases and looked thorough with the likeliest one
     * absent.
     */
    const p = await probeFinality(
      fakeNode('a', { latest: 200, finalized: 'equals-latest', hashes: { 200: H('2') } }),
    );
    expect(p.supported).toBe(false);
    expect(p.reason).toBe('finalized and latest are both 200, so the node is serving latest for finalized');
  });

  it('refuses a finalized height above the node’s own latest', async () => {
    // No honest node does this, so whatever it returned is not finality.
    const p = await probeFinality(fakeNode('a', { latest: 200, finalized: 'above-latest', hashes: { 200: H('2') } }));
    expect(p.supported).toBe(false);
    expect(p.reason).toMatch(/above latest/);
  });
});

describe('two nodes on finality', () => {
  it('takes the lower height, so a payment is final only when both agree it is', async () => {
    // Deliberately NOT an equality check. Two nodes advance independently and
    // would essentially never report the same number; requiring equality
    // would halt the system for good while looking like a safety property.
    const r = new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 280: H('1'), 300: H('2') } }),
      fakeNode('secondary', { latest: 299, finalized: 271, hashes: { 271: H('3'), 299: H('4') } }),
    );
    const agreed = await r.finalizedHeight();
    expect(agreed.agreed && agreed.value).toBe(271n);
  });

  it('holds when either node cannot do finality at all', async () => {
    const r = new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 280: H('1'), 300: H('2') } }),
      fakeNode('secondary', { latest: 299, finalized: 'unsupported', hashes: { 299: H('4') } }),
    );
    const held = await r.finalizedHeight();
    expect(held.agreed).toBe(false);
    expect(!held.agreed && held.reason).toMatch(/secondary/);
  });
});

describe('two nodes on a block hash', () => {
  it('agrees when they are on the same chain', async () => {
    const r = new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 250: H('a'), 300: H('2') } }),
      fakeNode('secondary', { latest: 300, finalized: 280, hashes: { 250: H('a'), 300: H('2') } }),
    );
    const a = await r.canonicalHashAt(250n);
    expect(a.agreed && a.value).toBe(H('a'));
  });

  it('holds on disagreement — this one IS equality, because it is not timing', async () => {
    // A different hash at the same height means at least one node is on a
    // different chain. Nothing may be fulfilled on that evidence.
    const r = new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 250: H('a'), 300: H('2') } }),
      fakeNode('secondary', { latest: 300, finalized: 280, hashes: { 250: H('b'), 300: H('2') } }),
    );
    const held = await r.canonicalHashAt(250n);
    expect(held.agreed).toBe(false);
    expect(!held.agreed && held.reason).toMatch(/disagree about block 250/);
  });

  it('holds when one node has no block at that height', async () => {
    const r = new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 250: H('a'), 300: H('2') } }),
      fakeNode('secondary', { latest: 240, finalized: 230, hashes: { 240: H('c') } }),
    );
    const held = await r.canonicalHashAt(250n);
    expect(held.agreed).toBe(false);
    expect(!held.agreed && held.reason).toMatch(/no block at 250/);
  });
});

describe('two nodes on a receipt', () => {
  const receipt = (status: number, blockNumber: number, blockHash: string, logIndex = 3) => ({
    status: hex(status),
    blockNumber: hex(blockNumber),
    blockHash,
    logs: [
      {
        address: '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29',
        topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
        data: '0x01',
        blockNumber: hex(blockNumber),
        blockHash,
        transactionHash: '0xaa',
        logIndex: hex(logIndex),
      },
    ],
  });

  const pair = (a: unknown, b: unknown) =>
    new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 300: H('2') }, receipts: { '0xaa': a } }),
      fakeNode('secondary', { latest: 300, finalized: 280, hashes: { 300: H('2') }, receipts: { '0xaa': b } }),
    );

  it('agrees when both describe the same thing', async () => {
    const r = pair(receipt(1, 250, H('a')), receipt(1, 250, H('a')));
    const got = await r.agreedReceipt('0xaa');
    expect(got.agreed).toBe(true);
    expect(got.agreed && got.value.logs[0]!.logIndex).toBe(3);
  });

  it('holds when they disagree about the status', async () => {
    const r = pair(receipt(1, 250, H('a')), receipt(0, 250, H('a')));
    expect((await r.agreedReceipt('0xaa')).agreed).toBe(false);
  });

  it('holds when they disagree about which block it is in', async () => {
    const r = pair(receipt(1, 250, H('a')), receipt(1, 250, H('b')));
    expect((await r.agreedReceipt('0xaa')).agreed).toBe(false);
  });

  it('holds when one node has not seen the transaction', async () => {
    const r = pair(receipt(1, 250, H('a')), null);
    const held = await r.agreedReceipt('0xaa');
    expect(held.agreed).toBe(false);
    expect(!held.agreed && held.reason).toMatch(/secondary has no receipt/);
  });

  it('does not hold over log ordering, which nodes may legitimately differ on', async () => {
    // Failing on a field that does not decide anything would be a halt
    // dressed up as a check.
    const a = receipt(1, 250, H('a'));
    const b = JSON.parse(JSON.stringify(a));
    b.logs = [...b.logs];
    const r = pair(a, b);
    expect((await r.agreedReceipt('0xaa')).agreed).toBe(true);
  });
});

describe('parsing what a node sends', () => {
  it('reads block timestamps as milliseconds, not seconds', async () => {
    // The chain speaks seconds and this codebase speaks milliseconds. Getting
    // it wrong makes every inclusion look like 1970, and a quote expiry
    // judged on block time would then never expire.
    const node = fakeNode('a', { latest: 10, finalized: 5, hashes: { 10: H('1') } });
    const header = await node.blockAt('latest');
    expect(header!.timestampMs).toBe(1_700_000_000_000);
  });

  it('refuses a malformed quantity instead of coercing it to zero', async () => {
    const node = new ChainNode({
      label: 'bad',
      async request() {
        return 'not-hex';
      },
    });
    await expect(node.blockNumber()).rejects.toThrow(/hex quantity/);
  });

  it('refuses a receipt status that is neither 0 nor 1', async () => {
    const node = new ChainNode({
      label: 'bad',
      async request() {
        return { status: hex(7), blockNumber: hex(1), blockHash: H('a'), logs: [] };
      },
    });
    await expect(node.receipt('0xaa')).rejects.toThrow(/receipt status/);
  });
});
