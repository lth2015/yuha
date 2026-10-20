/**
 * eth_getLogs against a node that caps the block range.
 *
 * Chainstack's Developer plan answers 403 to any eth_getLogs wider than 100
 * blocks; the scanner asked for 451 (STABLECOIN_SCAN_MAX_SPAN 450, inclusive),
 * so every pass failed, the cursor stood still, and in dual mode one capped
 * node stopped stablecoin confirmation outright. The way out was a hand-set
 * config value. A node now gets the window in pieces it will answer.
 */
import { describe, expect, it } from 'vitest';
import { ChainNode, type JsonRpcParams, type JsonRpcTransport } from '@yuha/providers';

const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;

/** A node that refuses any range wider than `cap` blocks, and logs every request it gets. */
function cappedNode(cap: number, opts: { down?: boolean } = {}) {
  const requests: Array<[number, number]> = [];
  const transport: JsonRpcTransport = {
    label: 'capped',
    async request(method: string, params: JsonRpcParams): Promise<unknown> {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
      const q = (params as Array<{ fromBlock: string; toBlock: string }>)[0]!;
      const from = Number(BigInt(q.fromBlock));
      const to = Number(BigInt(q.toBlock));
      requests.push([from, to]);
      if (opts.down) throw new Error('HTTP 503 from capped');
      if (to - from + 1 > cap) throw new Error('HTTP 403: block range exceeds your plan');
      // One log per block, so a missing or duplicated piece would show.
      return Array.from({ length: to - from + 1 }, (_, i) => ({
        blockNumber: hex(from + i),
        blockHash: `0x${'b'.repeat(64)}`,
        transactionHash: `0x${(from + i).toString(16).padStart(64, '0')}`,
        logIndex: '0x0',
        address: `0x${'1'.repeat(40)}`,
        topics: [],
        data: '0x',
        removed: false,
      }));
    },
  };
  return { node: new ChainNode(transport), requests };
}

const window = (from: number, to: number) => ({
  fromBlock: BigInt(from),
  toBlock: BigInt(to),
  address: `0x${'1'.repeat(40)}`,
  topics: [],
});

describe('eth_getLogs against a node that caps the range', () => {
  it('splits the window into ranges the node accepts and returns every block exactly once', async () => {
    const { node } = cappedNode(100);
    const logs = await node.logs(window(1_000, 1_450));
    const blocks = logs.map((l) => Number(l.blockNumber));
    expect(blocks).toHaveLength(451);
    expect(new Set(blocks).size).toBe(451);
    expect(Math.min(...blocks)).toBe(1_000);
    expect(Math.max(...blocks)).toBe(1_450);
  });

  it('remembers the size that worked, so the next window does not rediscover it', async () => {
    const { node, requests } = cappedNode(100);
    await node.logs(window(1_000, 1_450));
    const before = requests.length;
    await node.logs(window(1_451, 1_900));
    const refused = requests.slice(before).filter(([f, t]) => t - f + 1 > 100);
    expect(refused).toEqual([]);
  });

  it('still fails when the node is down, rather than shrinking forever', async () => {
    const { node, requests } = cappedNode(100, { down: true });
    await expect(node.logs(window(1_000, 1_450))).rejects.toThrow(/503/);
    // A handful of halvings, then it gives up — not one request per block.
    expect(requests.length).toBeLessThan(12);
  });

  it('does not learn a small size from an outage', async () => {
    let down = true;
    const requests: Array<[number, number]> = [];
    const node = new ChainNode({
      label: 'flaky',
      async request(_m: string, params: JsonRpcParams) {
        const q = (params as Array<{ fromBlock: string; toBlock: string }>)[0]!;
        requests.push([Number(BigInt(q.fromBlock)), Number(BigInt(q.toBlock))]);
        if (down) throw new Error('HTTP 503');
        return [];
      },
    });
    await expect(node.logs(window(1_000, 1_450))).rejects.toThrow();
    down = false;
    const before = requests.length;
    await node.logs(window(1_000, 1_450));
    // Back up: the whole window in one request again.
    expect(requests.slice(before)).toEqual([[1_000, 1_450]]);
  });
});
