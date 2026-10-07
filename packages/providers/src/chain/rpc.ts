/**
 * Reading the chain, through two independent nodes.
 *
 * The transport is an interface and not a client, for one reason: every
 * refusal and every held result in this file has to be reachable from a test
 * with no network at all. A fake transport can produce a reorg, a node that
 * lies, a node that is behind, and a node that does not implement finality —
 * none of which can be arranged against a real endpoint on demand.
 */

export type JsonRpcParams = readonly unknown[];

export interface JsonRpcTransport {
  readonly label: string;
  request(method: string, params: JsonRpcParams): Promise<unknown>;
}

export interface BlockHeader {
  number: bigint;
  hash: string;
  timestampMs: number;
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
}

export interface RawTransaction {
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
  input: string;
  nonce: number;
  blockNumber: bigint | null;
  blockHash: string | null;
  chainId: number | null;
}

export interface RawReceipt {
  status: 0 | 1;
  blockNumber: bigint;
  blockHash: string;
  logs: RawLog[];
}

function hexToBigInt(v: unknown): bigint {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error(`rpc: expected a hex quantity, got ${String(v)}`);
  return BigInt(v === '0x' ? '0x0' : v);
}

function hexToNumber(v: unknown): number {
  const n = hexToBigInt(v);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('rpc: quantity too large for a number');
  return Number(n);
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`rpc: ${what} is not a string`);
  return v;
}

function toQuantity(n: bigint): string {
  return `0x${n.toString(16)}`;
}

function parseHeader(raw: unknown): BlockHeader {
  const o = raw as Record<string, unknown>;
  return {
    number: hexToBigInt(o['number']),
    hash: str(o['hash'], 'block hash').toLowerCase(),
    // Seconds on the wire, milliseconds everywhere in this codebase.
    timestampMs: hexToNumber(o['timestamp']) * 1000,
  };
}

function parseLog(raw: unknown): RawLog {
  const o = raw as Record<string, unknown>;
  return {
    address: str(o['address'], 'log address').toLowerCase(),
    topics: (o['topics'] as string[]).map((t) => t.toLowerCase()),
    data: str(o['data'], 'log data').toLowerCase(),
    blockNumber: hexToBigInt(o['blockNumber']),
    blockHash: str(o['blockHash'], 'log block hash').toLowerCase(),
    transactionHash: str(o['transactionHash'], 'log tx hash').toLowerCase(),
    logIndex: hexToNumber(o['logIndex']),
  };
}

/** One node. Parsing lives here so a malformed answer fails loudly, not later. */
export class ChainNode {
  constructor(private readonly transport: JsonRpcTransport) {}

  get label(): string {
    return this.transport.label;
  }

  async chainId(): Promise<number> {
    return hexToNumber(await this.transport.request('eth_chainId', []));
  }

  async blockNumber(): Promise<bigint> {
    return hexToBigInt(await this.transport.request('eth_blockNumber', []));
  }

  /**
   * The header at a tag or height, or null when the node has nothing there.
   *
   * 'finalized' is a tag the node may not implement; a node that does not
   * will error or answer null, and both are reported rather than smoothed
   * over. See `probeFinality`.
   */
  async blockAt(tag: 'latest' | 'finalized' | bigint): Promise<BlockHeader | null> {
    const param = typeof tag === 'bigint' ? toQuantity(tag) : tag;
    const raw = await this.transport.request('eth_getBlockByNumber', [param, false]);
    return raw == null ? null : parseHeader(raw);
  }

  async transaction(hash: string): Promise<RawTransaction | null> {
    const raw = await this.transport.request('eth_getTransactionByHash', [hash]);
    if (raw == null) return null;
    const o = raw as Record<string, unknown>;
    return {
      hash: str(o['hash'], 'tx hash').toLowerCase(),
      from: str(o['from'], 'tx from').toLowerCase(),
      to: o['to'] == null ? null : str(o['to'], 'tx to').toLowerCase(),
      value: hexToBigInt(o['value']),
      input: str(o['input'], 'tx input').toLowerCase(),
      nonce: hexToNumber(o['nonce']),
      blockNumber: o['blockNumber'] == null ? null : hexToBigInt(o['blockNumber']),
      blockHash: o['blockHash'] == null ? null : str(o['blockHash'], 'tx block hash').toLowerCase(),
      // Absent on pre-EIP-155 and on some nodes; the caller compares the
      // node's own eth_chainId instead of trusting a missing field.
      chainId: o['chainId'] == null ? null : hexToNumber(o['chainId']),
    };
  }

  async receipt(hash: string): Promise<RawReceipt | null> {
    const raw = await this.transport.request('eth_getTransactionReceipt', [hash]);
    if (raw == null) return null;
    const o = raw as Record<string, unknown>;
    const status = hexToNumber(o['status']);
    if (status !== 0 && status !== 1) throw new Error(`rpc: unexpected receipt status ${status}`);
    return {
      status: status as 0 | 1,
      blockNumber: hexToBigInt(o['blockNumber']),
      blockHash: str(o['blockHash'], 'receipt block hash').toLowerCase(),
      logs: ((o['logs'] as unknown[]) ?? []).map(parseLog),
    };
  }

  async logs(params: {
    fromBlock: bigint;
    toBlock: bigint;
    address: string | string[];
    topics: (string | string[] | null)[];
  }): Promise<RawLog[]> {
    const raw = await this.transport.request('eth_getLogs', [
      {
        fromBlock: toQuantity(params.fromBlock),
        toBlock: toQuantity(params.toBlock),
        address: params.address,
        topics: params.topics,
      },
    ]);
    return ((raw as unknown[]) ?? []).map(parseLog);
  }

  /** A read-only contract call at the chain head. */
  async call(params: { to: string; data: string }): Promise<string> {
    const raw = await this.transport.request('eth_call', [{ to: params.to, data: params.data }, 'latest']);
    return str(raw, 'eth_call result');
  }

  /** eth_getTransactionCount at 'latest' — the next nonce, as a prediction. */
  async transactionCount(address: string): Promise<number> {
    return hexToNumber(await this.transport.request('eth_getTransactionCount', [address, 'latest']));
  }
}

export interface FinalityProbe {
  supported: boolean;
  /** Why not, when it is not — carried into the alert rather than swallowed. */
  reason?: string;
  height?: bigint;
}

/**
 * Whether this node really implements the `finalized` tag.
 *
 * Checked, not assumed, and checked by asking: §8 is explicit that an
 * unsupported `finalized` must stop automatic confirmation and raise an
 * alert, never quietly become "wait a few seconds" or "one confirmation".
 * Those are not weaker versions of finality; they are a different thing that
 * a reorg goes straight through.
 *
 * A node can fail this four ways, and all four are failures: it errors on the
 * tag, it answers null, it answers a header at a height above its own latest
 * (which no honest node does), or it answers exactly its own latest.
 *
 * That last one is the failure that actually happens in the field, and it was
 * missing here. A provider that has not implemented Heimdall v2 milestone
 * finality can silently serve `latest` for `finalized` — the call succeeds,
 * the shape is right, nothing errors, and every settlement decision is then
 * made on a probabilistic confirmation while the code believes it has
 * finality. Polygon's own documentation puts milestone finality at 2–5
 * seconds against 1–2 second blocks, so a correct node is always at least one
 * block behind its own head; equality is the signature of the silent default,
 * not a quiet chain.
 *
 * Refusing equality is deliberately conservative: a provider whose `latest`
 * is itself stale could trip it. Stopping automatic confirmation and raising
 * an alert is the right side to be wrong on.
 *
 * What this CANNOT establish, and a review was right to say so: a node
 * answering `latest - 1` passes, and on Polygon that is also what a correct
 * node looks like, since milestone finality runs two to five seconds behind
 * one-to-two-second blocks. Lag alone cannot tell milestone finality from a
 * node that simply reports one confirmation. What it can do is check that the
 * header it returned is the block really at that height — a node inventing an
 * answer fails that — and leave the rest to running
 * deploy/stablecoin/probe-rpc.sh against the real endpoint, where a person
 * reads the lag and the provider's own documentation. The honest summary is
 * that this probe refuses the failures it can see and does not prove finality.
 */
export async function probeFinality(node: ChainNode): Promise<FinalityProbe> {
  let latest: bigint;
  try {
    latest = await node.blockNumber();
  } catch (e) {
    return { supported: false, reason: `eth_blockNumber failed: ${(e as Error).message}` };
  }
  try {
    const header = await node.blockAt('finalized');
    if (!header) return { supported: false, reason: 'the node answered null for the finalized tag' };
    if (header.number > latest) {
      return {
        supported: false,
        reason: `finalized (${header.number}) is above latest (${latest}), so it is not finality`,
      };
    }
    if (header.number === latest) {
      return {
        supported: false,
        reason: `finalized and latest are both ${latest}, so the node is serving latest for finalized`,
      };
    }
    /*
     * The finalized header must be the block at that height.
     *
     * A node that answers the tag from somewhere other than its own chain —
     * a cache, a different network, a fabrication — fails here. It does not
     * prove finality; it rules out an answer that is not even this chain.
     */
    const atHeight = await node.blockAt(header.number);
    if (!atHeight || atHeight.hash !== header.hash) {
      return {
        supported: false,
        reason: `the finalized header ${header.hash} is not the block at height ${header.number}`,
      };
    }
    return { supported: true, height: header.number };
  } catch (e) {
    return { supported: false, reason: `the node does not support the finalized tag: ${(e as Error).message}` };
  }
}

export type Agreement<T> = { agreed: true; value: T } | { agreed: false; reason: string };

/**
 * Two nodes, and what it means for them to agree.
 *
 * The distinction that matters: finalized HEIGHTS are not compared for
 * equality. Two nodes advance independently and would essentially never report
 * the same number, so requiring equality would halt the system permanently
 * while looking like a safety property. The conservative reading is the
 * minimum — a payment is final when BOTH nodes consider it final.
 *
 * Block HASHES at a height are compared for equality, because disagreement
 * there is not timing: it means at least one node is on a different chain, and
 * nothing may be fulfilled on that evidence.
 */
export class DualChainReader {
  constructor(
    readonly primary: ChainNode,
    readonly secondary: ChainNode,
  ) {}

  /** Both nodes' finalized height, reduced to the lower of the two. */
  async finalizedHeight(): Promise<Agreement<bigint>> {
    const probes = await Promise.all([probeFinality(this.primary), probeFinality(this.secondary)]);
    const broken = probes.findIndex((p) => !p.supported);
    if (broken >= 0) {
      const node = broken === 0 ? this.primary : this.secondary;
      return { agreed: false, reason: `${node.label}: ${probes[broken]!.reason}` };
    }
    const [a, b] = probes as [{ height: bigint }, { height: bigint }];
    return { agreed: true, value: a.height < b.height ? a.height : b.height };
  }

  /**
   * The whole header at a height, only when both nodes say the same thing.
   *
   * The TIMESTAMP is compared as well as the hash, because it is not
   * decoration: a quote's expiry is judged on the inclusion block's time, so a
   * single node able to backdate a header could turn a late payment into a
   * fulfilled one. This used to return only the hash, and the header the
   * caller then used came from the primary alone.
   */
  async agreedHeader(height: bigint): Promise<Agreement<BlockHeader>> {
    const [a, b] = await Promise.all([this.primary.blockAt(height), this.secondary.blockAt(height)]);
    if (!a || !b) {
      const missing = !a ? this.primary.label : this.secondary.label;
      return { agreed: false, reason: `${missing} has no block at ${height}` };
    }
    if (a.hash !== b.hash) {
      return {
        agreed: false,
        reason: `the nodes disagree about block ${height}: ${this.primary.label} ${a.hash}, ${this.secondary.label} ${b.hash}`,
      };
    }
    if (a.timestampMs !== b.timestampMs) {
      return {
        agreed: false,
        reason: `the nodes disagree about when block ${height} was mined: ${a.timestampMs} vs ${b.timestampMs}`,
      };
    }
    return { agreed: true, value: a };
  }

  /**
   * A receipt both nodes describe identically in the parts that decide
   * fulfilment: status, the block it is in, and the Transfer logs.
   *
   * Compared on a normalised projection rather than deep-equality of the raw
   * objects, because nodes legitimately differ on fields that do not matter
   * here (gas accounting, effective price, log ordering keys) and failing on
   * those would be a halt dressed up as a check.
   */
  async agreedReceipt(hash: string): Promise<Agreement<RawReceipt>> {
    const [a, b] = await Promise.all([this.primary.receipt(hash), this.secondary.receipt(hash)]);
    if (!a || !b) {
      const missing = !a ? this.primary.label : this.secondary.label;
      return { agreed: false, reason: `${missing} has no receipt for ${hash}` };
    }
    const shape = (r: RawReceipt) =>
      JSON.stringify({
        status: r.status,
        blockNumber: r.blockNumber.toString(),
        blockHash: r.blockHash,
        logs: r.logs
          .map((l) => ({ a: l.address, t: l.topics, d: l.data, i: l.logIndex }))
          .sort((x, y) => x.i - y.i),
      });
    if (shape(a) !== shape(b)) {
      return { agreed: false, reason: `the nodes describe receipt ${hash} differently` };
    }
    return { agreed: true, value: a };
  }
}
