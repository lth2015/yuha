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
  verifyChainIds,
  type JsonRpcParams,
  type JsonRpcTransport,
} from '@yuha/providers';

const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;

interface NodeState {
  latest: number;
  finalized: number | 'unsupported' | 'null' | 'above-latest' | 'equals-latest';
  /** blockNumber -> hash. Missing means the node has no block there. */
  hashes: Record<number, string>;
  /** Seconds, so one node can be made to disagree about when a block was mined. */
  timestamp?: number;
  receipts?: Record<string, unknown>;
  txs?: Record<string, unknown>;
  /** What eth_getLogs answers, so omission by one node can be arranged. */
  logs?: unknown[];
  /** What eth_call answers. */
  callResult?: string;
  chainId?: number;
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
            return { number: hex(n), hash: state.hashes[n] ?? `0x${'f'.repeat(64)}`, timestamp: hex(state.timestamp ?? 1_700_000_000) };
          }
          if (tag === 'latest') {
            return { number: hex(state.latest), hash: state.hashes[state.latest]!, timestamp: hex(state.timestamp ?? 1_700_000_000) };
          }
          const n = Number(BigInt(tag));
          const h = state.hashes[n];
          return h ? { number: hex(n), hash: h, timestamp: hex(state.timestamp ?? 1_700_000_000) } : null;
        }
        case 'eth_getTransactionReceipt':
          return state.receipts?.[params[0] as string] ?? null;
        case 'eth_getTransactionByHash':
          return state.txs?.[params[0] as string] ?? null;
        case 'eth_getLogs':
          return state.logs ?? [];
        case 'eth_call':
          if (state.callResult === undefined) throw new Error('no call result configured');
          return state.callResult;
        case 'eth_chainId':
          if (state.chainId === undefined) throw new Error('this node will not say what chain it is');
          return hex(state.chainId);
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

describe('two nodes on a block header', () => {
  it('agrees when they are on the same chain', async () => {
    const r = new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 250: H('a'), 300: H('2') } }),
      fakeNode('secondary', { latest: 300, finalized: 280, hashes: { 250: H('a'), 300: H('2') } }),
    );
    const a = await r.agreedHeader(250n);
    expect(a.agreed && a.value.hash).toBe(H('a'));
  });

  it('holds on disagreement — this one IS equality, because it is not timing', async () => {
    // A different hash at the same height means at least one node is on a
    // different chain. Nothing may be fulfilled on that evidence.
    const r = new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 250: H('a'), 300: H('2') } }),
      fakeNode('secondary', { latest: 300, finalized: 280, hashes: { 250: H('b'), 300: H('2') } }),
    );
    const held = await r.agreedHeader(250n);
    expect(held.agreed).toBe(false);
    expect(!held.agreed && held.reason).toMatch(/disagree about block 250/);
  });

  it('holds when they disagree about WHEN the block was mined', async () => {
    /*
     * The timestamp is not decoration: a quote's expiry is judged on the
     * inclusion block's time, so a node able to backdate a header could turn a
     * late payment into a fulfilled one. This method returned only the hash
     * until an adversarial review demonstrated exactly that, with the header
     * the caller then used coming from one node.
     */
    const r = new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 250: H('a'), 300: H('2') } }),
      fakeNode('secondary', { latest: 300, finalized: 280, hashes: { 250: H('a'), 300: H('2') }, timestamp: 1_500_000_000 }),
    );
    const held = await r.agreedHeader(250n);
    expect(held.agreed).toBe(false);
    expect(!held.agreed && held.reason).toMatch(/disagree about when block 250 was mined/);
  });

  it('holds when one node has no block at that height', async () => {
    const r = new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 250: H('a'), 300: H('2') } }),
      fakeNode('secondary', { latest: 240, finalized: 230, hashes: { 240: H('c') } }),
    );
    const held = await r.agreedHeader(250n);
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

  const logAt = (logIndex: number, blockNumber: number, blockHash: string, over: Record<string, unknown> = {}) => ({
    address: '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29',
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
    data: '0x01',
    blockNumber: hex(blockNumber),
    blockHash,
    transactionHash: '0xaa',
    logIndex: hex(logIndex),
    ...over,
  });

  /** A receipt with two logs, in the order given. */
  const twoLogs = (indices: number[]) => ({
    status: hex(1),
    blockNumber: hex(250),
    blockHash: H('a'),
    logs: indices.map((i) => logAt(i, 250, H('a'))),
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
    /*
     * Failing on a field that does not decide anything would be a halt dressed
     * up as a check.
     *
     * The first version of this test built one receipt, deep-copied it, and
     * reassigned `logs` to a shallow copy IN THE SAME ORDER — so it asserted
     * that two identical receipts agree, which `agreedReceipt` cannot violate.
     * Mutation testing confirmed it: removing the normalisation entirely
     * survived the whole suite. Two logs, served in opposite orders, is the
     * property.
     */
    // The PRIMARY serves them reversed, deliberately: the value handed back is
    // the primary's object, so normalising only the comparison leaves a caller
    // searching an array whose order the primary chose. Written this way round
    // because the first version served them in order from the primary and the
    // assertion held with the normalisation deleted.
    const r = pair(twoLogs([3, 0]), twoLogs([0, 3]));
    const got = await r.agreedReceipt('0xaa');
    expect(got.agreed).toBe(true);
    expect(got.agreed && got.value.logs.map((l) => l.logIndex)).toEqual([0, 3]);
  });

  it('holds when a log claims to belong to a different transaction', async () => {
    /*
     * The compared projection was `{address, topics, data, logIndex}`, so each
     * log's `transactionHash`, `blockNumber` and `blockHash` were the
     * primary's word alone — and the caller's "is this log in the agreed
     * receipt, with this transaction hash" check then verified the primary
     * against itself.
     */
    const honest = twoLogs([3]);
    const lying = { ...twoLogs([3]), logs: [logAt(3, 250, H('a'), { transactionHash: '0xbb' })] };
    const held = await pair(lying, honest).agreedReceipt('0xaa');
    expect(held.agreed).toBe(false);
  });

  it('holds when a log claims a different block from the other node’s copy', async () => {
    const honest = twoLogs([3]);
    const lying = { ...twoLogs([3]), logs: [logAt(3, 251, H('a'))] };
    expect((await pair(lying, honest).agreedReceipt('0xaa')).agreed).toBe(false);
  });
});

describe('two nodes on a transaction body', () => {
  const tx = (over: Record<string, unknown> = {}) => ({
    hash: '0xaa',
    from: '0x1111111111111111111111111111111111111111',
    to: '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29',
    value: '0x0',
    input: '0xa9059cbb',
    nonce: hex(4),
    blockNumber: hex(250),
    blockHash: H('a'),
    chainId: hex(137),
    ...over,
  });

  const pair = (a: unknown, b: unknown) =>
    new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 300: H('2') }, txs: { '0xaa': a } }),
      fakeNode('secondary', { latest: 300, finalized: 280, hashes: { 300: H('2') }, txs: { '0xaa': b } }),
    );

  it('agrees when both describe the same transaction', async () => {
    const got = await pair(tx(), tx()).agreedTransaction('0xaa');
    expect(got.agreed).toBe(true);
    expect(got.agreed && got.value.from).toBe('0x1111111111111111111111111111111111111111');
  });

  it('holds when they disagree about the SENDER, which decides attribution', async () => {
    /*
     * The field that mattered most and was checked least. `from` is the
     * attribution key — it decides which open intent a payment belongs to —
     * and that lookup runs before the verifier, so no later check sees it. One
     * node altering it turned a real payment into unattributable money.
     */
    const held = await pair(tx({ from: '0x2222222222222222222222222222222222222222' }), tx()).agreedTransaction('0xaa');
    expect(held.agreed).toBe(false);
    expect(!held.agreed && held.reason).toMatch(/describe transaction .* differently/);
  });

  it('holds when they disagree about the calldata, the token or the value', async () => {
    // These decide REJECTION, which is also a decision about money that
    // really arrived: each rejection reason writes a row and refuses a
    // payment.
    for (const over of [{ input: '0xdeadbeef' }, { to: '0x5555555555555555555555555555555555555555' }, { value: '0x1' }]) {
      expect((await pair(tx(over), tx()).agreedTransaction('0xaa')).agreed, JSON.stringify(over)).toBe(false);
    }
  });

  it('tolerates one node omitting the chain id, and uses the one that has it', async () => {
    // Genuinely absent from some nodes' answers; `verifyChainIds` is what
    // establishes the endpoint is this chain.
    const got = await pair(tx({ chainId: null }), tx()).agreedTransaction('0xaa');
    expect(got.agreed).toBe(true);
    expect(got.agreed && got.value.chainId).toBe(137);
  });

  it('holds when they disagree about the chain id', async () => {
    expect((await pair(tx({ chainId: hex(1) }), tx()).agreedTransaction('0xaa')).agreed).toBe(false);
  });

  it('holds when one node has not seen it', async () => {
    const held = await pair(null, tx()).agreedTransaction('0xaa');
    expect(held.agreed).toBe(false);
    expect(!held.agreed && held.reason).toMatch(/primary has no transaction/);
  });
});

describe('the height a header claims to be', () => {
  it('holds when a node answers about a different block than the one asked for', async () => {
    /*
     * `agreedHeader` compared the hash and the timestamp, returned the
     * primary's object, and never compared `number` with the height asked for
     * or with the other node. A node answering `eth_getBlockByNumber(250)`
     * with a truthful hash and timestamp under `number: 0` had that zero
     * written onto the payment's evidence row — and the operator refund queue
     * is ordered by that column, so an attacker could bury a row at the
     * bottom of it.
     */
    const liar = new ChainNode({
      label: 'liar',
      async request(method: string, params: JsonRpcParams) {
        if (method === 'eth_getBlockByNumber') {
          const tag = params[0] as string;
          if (tag === 'finalized') return { number: hex(280), hash: H('f'), timestamp: hex(1_700_000_000) };
          return { number: hex(0), hash: H('a'), timestamp: hex(1_700_000_000) };
        }
        if (method === 'eth_blockNumber') return hex(300);
        throw new Error(`unexpected ${method}`);
      },
    });
    const r = new DualChainReader(liar, fakeNode('secondary', { latest: 300, finalized: 280, hashes: { 250: H('a'), 300: H('2') } }));
    const held = await r.agreedHeader(250n);
    expect(held.agreed).toBe(false);
    expect(!held.agreed && held.reason).toMatch(/answered about block 0 when asked for 250/);
  });
});

describe('logs from both nodes', () => {
  const log = (txHash: string, logIndex: number) => ({
    address: '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29',
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
    data: '0x01',
    blockNumber: hex(250),
    blockHash: H('a'),
    transactionHash: txHash,
    logIndex: hex(logIndex),
  });
  const ask = (r: DualChainReader) =>
    r.unionLogs({ fromBlock: 200n, toBlock: 300n, address: [], topics: [] });

  it('includes a transfer only one node reported', async () => {
    /*
     * The defect this exists for: discovery asked ONE node, so a node that
     * left a payment out of a single eth_getLogs answer lost it for good — the
     * cursor advanced, the overlap re-read asked the same node again, and no
     * row existed anywhere, not even in an operator queue. The only invisible
     * way to lose a payment in this design.
     */
    const r = new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 300: H('2') }, logs: [] }),
      fakeNode('secondary', { latest: 300, finalized: 280, hashes: { 300: H('2') }, logs: [log('0xaa', 2)] }),
    );
    const found = await ask(r);
    expect(found.map((l) => l.transactionHash)).toEqual(['0xaa']);
  });

  it('does not double-count a transfer both reported', async () => {
    const r = new DualChainReader(
      fakeNode('primary', { latest: 300, finalized: 280, hashes: { 300: H('2') }, logs: [log('0xaa', 2)] }),
      fakeNode('secondary', { latest: 300, finalized: 280, hashes: { 300: H('2') }, logs: [log('0xaa', 2)] }),
    );
    expect(await ask(r)).toHaveLength(1);
  });

  it('propagates an error instead of treating one node as having found nothing', async () => {
    // A node that errors is not a node that found nothing. Swallowing it would
    // reintroduce the omission defect in a new costume.
    const broken = new ChainNode({
      label: 'broken',
      async request(method: string) {
        if (method === 'eth_getLogs') throw new Error('rate limited');
        throw new Error(`unexpected ${method}`);
      },
    });
    const r = new DualChainReader(broken, fakeNode('secondary', { latest: 300, finalized: 280, hashes: {}, logs: [] }));
    await expect(ask(r)).rejects.toThrow(/rate limited/);
  });
});

describe('a contract read, and the chain the endpoints are on', () => {
  const node = (over: Partial<NodeState>) =>
    fakeNode('n', { latest: 300, finalized: 280, hashes: { 300: H('2') }, ...over });

  it('agrees only when both nodes answer the same thing', async () => {
    /*
     * The decimals check — the one guard between a mistyped constant and a
     * quote wrong by a factor of a trillion — asked the primary alone, in a
     * design where every other chain read insists on agreement.
     */
    const same = new DualChainReader(node({ callResult: '0x12' }), node({ callResult: '0x12' }));
    const got = await same.agreedCall({ to: '0xabc', data: '0x313ce567' });
    expect(got.agreed).toBe(true);

    const different = new DualChainReader(node({ callResult: '0x12' }), node({ callResult: '0x06' }));
    expect((await different.agreedCall({ to: '0xabc', data: '0x313ce567' })).agreed).toBe(false);
  });

  it('checks both endpoints really are the configured chain', async () => {
    /*
     * `eth_chainId` was never called anywhere in the repository, while a
     * comment in the RPC client claimed the caller compared it. Nothing
     * established that either URL pointed at Polygon mainnet: the only thing
     * holding the pair to the real chain was that they agreed with each other,
     * which two endpoints onto the same wrong chain satisfy perfectly.
     */
    const right = new DualChainReader(node({ chainId: 137 }), node({ chainId: 137 }));
    expect(await verifyChainIds(right, 137)).toEqual([]);

    const wrong = new DualChainReader(node({ chainId: 137 }), node({ chainId: 80_002 }));
    expect(await verifyChainIds(wrong, 137)).toEqual(['n is chain 80002, not 137']);

    const silent = new DualChainReader(node({ chainId: 137 }), node({}));
    expect((await verifyChainIds(silent, 137))[0]).toMatch(/could not be asked for its chain id/);
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
