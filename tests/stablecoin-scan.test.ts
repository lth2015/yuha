/**
 * The scanner, end to end, against two fake nodes.
 *
 * This is the first point where a payment nobody reported turns into credits
 * in an account, so it is also the first point where getting the chain wrong
 * costs money. Every node behaviour that decides that is arranged here:
 * finality missing, finality silently equal to latest, a reorg, two nodes
 * disagreeing, and a transfer sitting in a block the cursor must not pass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getChainCursor, query } from '@yuha/db';
import {
  ChainNode,
  DualChainReader,
  TRANSFER_TOPIC,
  addressTopic,
  encodeTransferCalldata,
  type JsonRpcParams,
  type JsonRpcTransport,
} from '@yuha/providers';
import { runStablecoinScanPass, SCAN_STREAM } from '../apps/api/src/services/stablecoin-scan.js';
import { balanceOf, createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `203.0.113.${(callNo++ % 200) + 10}` });
const silent = () => undefined;

const RECEIVER = '0x9999999999999999999999999999999999999999';
const JPYC = '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29';
const AMOUNT = 980n * 10n ** 18n;
const accountA = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PAYER = accountA.address.toLowerCase();
const TX = `0x${'ab'.repeat(32)}`;
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;

interface Fake {
  latest: number;
  finalized: number | 'unsupported' | 'equals-latest';
  /** height -> hash */
  hashes: Record<number, string>;
  /** The Transfer this node reports, if any. */
  transfer?: { block: number; amount: bigint; logIndex: number; to?: string; status?: number };
  /** A receipt that still names an older block hash, as after a reorg. */
  staleReceiptHash?: string;
  /**
   * What this node says is AT a height, when that differs from what its
   * receipts say. One node reorged and the other has not yet.
   */
  indexHash?: Record<number, string>;
}

function node(label: string, f: Fake): ChainNode {
  const logFor = (t: NonNullable<Fake['transfer']>) => ({
    address: JPYC,
    topics: [TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(t.to ?? RECEIVER)],
    data: hex(t.amount),
    blockNumber: hex(t.block),
    blockHash: f.hashes[t.block]!,
    transactionHash: TX,
    logIndex: hex(t.logIndex),
  });

  const transport: JsonRpcTransport = {
    label,
    async request(method: string, params: JsonRpcParams): Promise<unknown> {
      switch (method) {
        case 'eth_chainId':
          return hex(137);
        case 'eth_blockNumber':
          return hex(f.latest);
        case 'eth_getBlockByNumber': {
          const tag = params[0] as string;
          if (tag === 'finalized') {
            if (f.finalized === 'unsupported') throw new Error('method not found');
            const n = f.finalized === 'equals-latest' ? f.latest : f.finalized;
            return { number: hex(n), hash: f.hashes[n] ?? `0x${'f'.repeat(64)}`, timestamp: hex(1_760_000_000) };
          }
          const n = tag === 'latest' ? f.latest : Number(BigInt(tag));
          const hash = f.indexHash?.[n] ?? f.hashes[n];
          return hash ? { number: hex(n), hash, timestamp: hex(1_760_000_000) } : null;
        }
        case 'eth_getLogs': {
          if (!f.transfer) return [];
          const filter = params[0] as { fromBlock: string; toBlock: string };
          const from = Number(BigInt(filter.fromBlock));
          const to = Number(BigInt(filter.toBlock));
          // A real node answers only within the range it was given. A fake
          // that ignores it tests the scanner's own out-of-window filter by
          // accident and hides everything else.
          return f.transfer.block >= from && f.transfer.block <= to ? [logFor(f.transfer)] : [];
        }
        case 'eth_getTransactionByHash':
          return f.transfer
            ? {
                hash: TX,
                from: PAYER,
                to: JPYC,
                value: '0x0',
                input: encodeTransferCalldata(f.transfer.to ?? RECEIVER, f.transfer.amount),
                nonce: hex(7),
                blockNumber: hex(f.transfer.block),
                blockHash: f.hashes[f.transfer.block]!,
                chainId: hex(137),
              }
            : null;
        case 'eth_getTransactionReceipt':
          return f.transfer
            ? {
                status: hex(f.transfer.status ?? 1),
                blockNumber: hex(f.transfer.block),
                blockHash: f.staleReceiptHash ?? f.hashes[f.transfer.block]!,
                logs: [logFor(f.transfer)],
              }
            : null;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return new ChainNode(transport);
}

const H = (seed: string) => `0x${seed.repeat(64).slice(0, 64)}`;

/** Both nodes agreeing about a correct, finalized payment at block 1000. */
const good = (over: Partial<Fake> = {}): Fake => ({
  latest: 1_100,
  finalized: 1_050,
  hashes: { 1_000: H('a'), 1_050: H('b'), 1_100: H('c') },
  transfer: { block: 1_000, amount: AMOUNT, logIndex: 2 },
  ...over,
});

const pair = (a: Fake, b: Fake = a) => new DualChainReader(node('primary', a), node('secondary', b));

beforeAll(async () => {
  h = await createHarness({
    STABLECOIN_ENABLED: 'true',
    STABLECOIN_JPYC_ENABLED: 'true',
    STABLECOIN_RECEIVER_ADDRESS: RECEIVER,
    POLYGON_RPC_PRIMARY_URL: 'https://primary.invalid/rpc',
    POLYGON_RPC_SECONDARY_URL: 'https://secondary.invalid/rpc',
    STABLECOIN_SCAN_START_BLOCK: '900',
    STABLECOIN_SCAN_OVERLAP: '10',
    STABLECOIN_SCAN_MAX_SPAN: '450',
  });
});
beforeEach(async () => {
  await resetData();
  await query(`DELETE FROM chain_cursors`);
});
afterAll(async () => {
  await teardown();
});

/** A user with a verified wallet and a live quote for DROP. */
async function quoted(email: string): Promise<{ user: TestUser; orderId: string }> {
  const user = await h.createUser({ email });
  const ch = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-challenge',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { address: accountA.address, chainId: 137 } as never,
  });
  const { nonce, message } = ch.json() as { nonce: string; message: string };
  await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-verify',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { nonce, address: accountA.address, signature: await accountA.signMessage({ message }) } as never,
  });
  const q = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/quote',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { priceKey: 'drop_5', idempotencyKey: `scan-${email}`, tokenKey: 'jpyc', payer: accountA.address } as never,
  });
  expect(q.statusCode).toBe(200);
  return { user, orderId: q.json().orderId as string };
}

describe('a payment nobody reported', () => {
  it('is found by the scan and credited', async () => {
    const { user } = await quoted('scan-ok@example.jp');
    const pass = await runStablecoinScanPass(h.ctx, pair(good()), silent);
    expect(pass.found).toBe(1);
    expect(pass.settled[0]!.kind).toBe('fulfilled');
    expect((await balanceOf(user.id)).available).toBe(5);
  });

  it('moves the cursor to the end of the window, not to the chain tip', async () => {
    await quoted('scan-cursor@example.jp');
    await runStablecoinScanPass(h.ctx, pair(good()), silent);
    // safeHead is the FINALIZED height (1050), never latest (1100).
    expect(await getChainCursor({ chainId: 137, stream: SCAN_STREAM })).toBe(1_050n);
  });

  it('re-reads the same range without paying twice', async () => {
    const { user } = await quoted('scan-twice@example.jp');
    await runStablecoinScanPass(h.ctx, pair(good()), silent);
    const second = await runStablecoinScanPass(h.ctx, pair(good()), silent);
    expect(second.settled.every((s) => s.kind !== 'fulfilled')).toBe(true);
    expect((await balanceOf(user.id)).available).toBe(5);
  });
});

describe('when the chain cannot be trusted', () => {
  it('does nothing at all if a node has no finality', async () => {
    const { user } = await quoted('scan-nofinal@example.jp');
    const pass = await runStablecoinScanPass(h.ctx, pair(good(), good({ finalized: 'unsupported' })), silent);
    expect(pass.window).toBeNull();
    expect((await balanceOf(user.id)).available).toBe(0);
    expect(await getChainCursor({ chainId: 137, stream: SCAN_STREAM })).toBeUndefined();
  });

  it('does nothing if a node serves latest for finalized', async () => {
    // The silent failure. Nothing errors; the pass simply must not run.
    const { user } = await quoted('scan-silent@example.jp');
    const pass = await runStablecoinScanPass(h.ctx, pair(good(), good({ finalized: 'equals-latest' })), silent);
    expect(pass.window).toBeNull();
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('holds when the two nodes disagree about the block, and keeps the cursor below it', async () => {
    const { user } = await quoted('scan-split@example.jp');
    const other = good({ hashes: { 1_000: H('z'), 1_050: H('b'), 1_100: H('c') } });
    const pass = await runStablecoinScanPass(h.ctx, pair(good(), other), silent);
    expect(pass.heldAt?.blockNumber).toBe(1_000n);
    expect((await balanceOf(user.id)).available).toBe(0);
    // Below the held block, so the next pass sees it again rather than losing it.
    expect(await getChainCursor({ chainId: 137, stream: SCAN_STREAM })).toBe(999n);
  });

  it('settles the held payment once the nodes agree again', async () => {
    const { user } = await quoted('scan-recover@example.jp');
    const other = good({ hashes: { 1_000: H('z'), 1_050: H('b'), 1_100: H('c') } });
    await runStablecoinScanPass(h.ctx, pair(good(), other), silent);
    expect((await balanceOf(user.id)).available).toBe(0);

    const after = await runStablecoinScanPass(h.ctx, pair(good()), silent);
    expect(after.settled[0]!.kind).toBe('fulfilled');
    expect((await balanceOf(user.id)).available).toBe(5);
  });

  it('holds when the nodes disagree about the receipt, not just the block', async () => {
    /*
     * This case was missing, and it showed: taking the receipt from the
     * primary alone passed every other test here, because the existing
     * disagreement test varies the block HASH, which `canonicalHashAt`
     * catches. Two nodes reporting different receipt statuses for one
     * transaction is a different failure and has to be its own refusal —
     * otherwise a single node's word decides whether a payment succeeded.
     */
    const { user } = await quoted('scan-receipt-split@example.jp');
    const succeeded = good();
    const reverted = good({ transfer: { block: 1_000, amount: AMOUNT, logIndex: 2, status: 0 } });
    const pass = await runStablecoinScanPass(h.ctx, pair(succeeded, reverted), silent);

    expect(pass.heldAt?.blockNumber).toBe(1_000n);
    expect(pass.heldAt?.reason).toMatch(/describe receipt .* differently/);
    expect((await balanceOf(user.id)).available).toBe(0);
    expect(await getChainCursor({ chainId: 137, stream: SCAN_STREAM })).toBe(999n);
  });

  it('refuses a receipt whose block is no longer the one at that height', async () => {
    /*
     * The reorg a stale receipt hides. Both nodes agree about the receipt —
     * they can both be serving the same stale copy, so agreement proves
     * nothing here — and both agree about what is at that height now. The
     * evidence is internally consistent and historically wrong: the verifier's
     * own reorg check would compare the new hash with the new hash and pass.
     *
     * Found by asking what `canonicalHashAt` adds over `agreedReceipt` in this
     * path, after a mutation that removed it broke no test.
     */
    const { user } = await quoted('scan-stale-receipt@example.jp');
    const reorged = good({ staleReceiptHash: H('9') });
    const pass = await runStablecoinScanPass(h.ctx, pair(reorged), silent);

    expect(pass.heldAt?.blockNumber).toBe(1_000n);
    expect(pass.heldAt?.reason).toMatch(/at that height now/);
    expect((await balanceOf(user.id)).available).toBe(0);
    expect(await getChainCursor({ chainId: 137, stream: SCAN_STREAM })).toBe(999n);
  });

  it('holds when the nodes disagree about what is at that height', async () => {
    /*
     * Reached only when the two nodes' block indexes differ while their
     * receipts still agree — one has reorged and the other has not. The
     * earlier "disagree about the block" test does not reach it, because
     * changing a hash there also changes that node's receipt and
     * `agreedReceipt` refuses first. A mutation that neutered
     * `canonicalHashAt` broke no test until this one existed.
     */
    const { user } = await quoted('scan-index-split@example.jp');
    const moved = good({ indexHash: { 1_000: H('7') } });
    const pass = await runStablecoinScanPass(h.ctx, pair(good(), moved), silent);

    expect(pass.heldAt?.blockNumber).toBe(1_000n);
    expect(pass.heldAt?.reason).toMatch(/disagree about block 1000/);
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('refuses a failed transaction, and keeps scanning past it', async () => {
    const { user } = await quoted('scan-failed@example.jp');
    const failed = good({ transfer: { block: 1_000, amount: AMOUNT, logIndex: 2, status: 0 } });
    const pass = await runStablecoinScanPass(h.ctx, pair(failed), silent);
    expect(pass.settled[0]!.kind).toBe('rejected');
    expect((await balanceOf(user.id)).available).toBe(0);
    // A refusal is an answer, not a disagreement: the cursor moves on.
    expect(await getChainCursor({ chainId: 137, stream: SCAN_STREAM })).toBe(1_050n);
  });

  it('sends a short payment to review without crediting anything', async () => {
    const { user } = await quoted('scan-short@example.jp');
    const short = good({ transfer: { block: 1_000, amount: AMOUNT - 1n, logIndex: 2 } });
    const pass = await runStablecoinScanPass(h.ctx, pair(short), silent);
    expect(pass.settled[0]!.kind).toBe('review');
    expect((await balanceOf(user.id)).available).toBe(0);
  });
});

describe('what the scan asks the chain for', () => {
  it('ignores a transfer to an address that is not ours', async () => {
    const { user } = await quoted('scan-stranger@example.jp');
    const stranger = good({
      transfer: { block: 1_000, amount: AMOUNT, logIndex: 2, to: '0x3333333333333333333333333333333333333333' },
    });
    const pass = await runStablecoinScanPass(h.ctx, pair(stranger), silent);
    expect(pass.found).toBe(0);
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('scans the overlap even when finality is just behind the cursor', async () => {
    // Start block 900 with an overlap of 10 means the window begins at 890,
    // so a finalized head of 895 still has something to look at. The overlap
    // is what notices a reorg near the head; a cursor that only moves forward
    // cannot.
    await quoted('scan-overlap@example.jp');
    const justBehind = good({ latest: 905, finalized: 895, hashes: { 895: H('b'), 905: H('c') } });
    const pass = await runStablecoinScanPass(h.ctx, pair(justBehind), silent);
    expect(pass.window).toEqual({ fromBlock: 890n, toBlock: 895n });
    expect(pass.found).toBe(0);
  });

  it('does nothing when finality is below even the overlap', async () => {
    await quoted('scan-caughtup@example.jp');
    const wayBehind = good({ latest: 889, finalized: 880, hashes: { 880: H('b'), 889: H('c') } });
    const pass = await runStablecoinScanPass(h.ctx, pair(wayBehind), silent);
    expect(pass.window).toBeNull();
  });
});

describe('the first pass, with nothing configured', () => {
  it('starts watching from the finalized head rather than from block zero', async () => {
    /*
     * Zero reads as "from the beginning" and is not slow but impossible:
     * Polygon is past seventy million blocks and a pass covers a few hundred,
     * so the scanner would never reach the present and no payment would ever
     * be seen. Leaving the start block blank in a .env is an ordinary thing to
     * do, and it must not produce a scanner that can never work.
     */
    const fresh = await createHarness({
      STABLECOIN_ENABLED: 'true',
      STABLECOIN_JPYC_ENABLED: 'true',
      STABLECOIN_RECEIVER_ADDRESS: RECEIVER,
      POLYGON_RPC_PRIMARY_URL: 'https://primary.invalid/rpc',
      POLYGON_RPC_SECONDARY_URL: 'https://secondary.invalid/rpc',
      STABLECOIN_SCAN_START_BLOCK: '',
      // Stated rather than inherited: the default overlap is 32 and the rest
      // of this file uses 10, which is how the expectation below came out 22
      // blocks wrong the first time.
      STABLECOIN_SCAN_OVERLAP: '10',
    });
    try {
      await query(`DELETE FROM chain_cursors`);
      const pass = await runStablecoinScanPass(fresh.ctx, pair(good()), silent);
      expect(pass.window).toBeNull();
      expect(await getChainCursor({ chainId: 137, stream: SCAN_STREAM })).toBe(1_050n);
    } finally {
      await fresh.close();
    }
  });

  it('writes that starting point down, so a restart does not skip what arrived', async () => {
    const fresh = await createHarness({
      STABLECOIN_ENABLED: 'true',
      STABLECOIN_JPYC_ENABLED: 'true',
      STABLECOIN_RECEIVER_ADDRESS: RECEIVER,
      POLYGON_RPC_PRIMARY_URL: 'https://primary.invalid/rpc',
      POLYGON_RPC_SECONDARY_URL: 'https://secondary.invalid/rpc',
      STABLECOIN_SCAN_START_BLOCK: '',
      // Stated rather than inherited: the default overlap is 32 and the rest
      // of this file uses 10, which is how the expectation below came out 22
      // blocks wrong the first time.
      STABLECOIN_SCAN_OVERLAP: '10',
    });
    try {
      await query(`DELETE FROM chain_cursors`);
      await runStablecoinScanPass(fresh.ctx, pair(good()), silent);
      // A later pass with a higher head must resume from the recorded point,
      // not keep jumping to the newest head and losing the blocks between.
      const later = good({ latest: 1_200, finalized: 1_150, hashes: { 1_000: H('a'), 1_150: H('d'), 1_200: H('e') } });
      const pass = await runStablecoinScanPass(fresh.ctx, pair(later), silent);
      expect(pass.window?.fromBlock).toBe(1_050n - 10n);
    } finally {
      await fresh.close();
    }
  });
});

describe('a customer reporting a transaction hash', () => {
  /*
   * A reported hash says WHERE TO LOOK and nothing else. It exists for speed:
   * the scan finds the same payment on its next pass regardless.
   */
  const report = (user: TestUser, orderId: string, txHash: string) =>
    h.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/stablecoin-transaction`,
      headers: { ...user.authHeader, ...freshIp() },
      payload: { txHash } as never,
    });

  it('credits the order without waiting for the next scan', async () => {
    const { user, orderId } = await quoted('hint-ok@example.jp');
    h.ctx.chain = pair(good());
    const res = await report(user, orderId, TX);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('fulfilled');
    expect((await balanceOf(user.id)).available).toBe(5);
  });

  it('gives a stranger nothing for pasting somebody else\u2019s payment', async () => {
    /*
     * The attack the specification names: copy a hash off a block explorer and
     * claim it. Attribution comes from the open intent of the TRANSACTION'S
     * OWN sender, so a genuine payment by someone else resolves to their order
     * or to nothing — never to whoever pasted it. The order id in the URL is
     * checked for ownership and is not used to attribute anything.
     */
    const { user: payer } = await quoted('hint-payer@example.jp');
    const stranger = await h.createUser({ email: 'hint-stranger@example.jp' });
    const theirOrder = await h.app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: { ...stranger.authHeader, ...freshIp() },
      payload: { priceKey: 'drop_5', idempotencyKey: 'stranger-order-001' } as never,
    });
    expect(theirOrder.statusCode).toBe(200);

    h.ctx.chain = pair(good());
    const res = await report(stranger, theirOrder.json().orderId, TX);
    expect(res.statusCode).toBeLessThan(300);

    // The payer is credited, because the chain says the payment is theirs.
    expect((await balanceOf(payer.id)).available).toBe(5);
    // The stranger gets nothing at all.
    expect((await balanceOf(stranger.id)).available).toBe(0);
  });

  it('will not take one node\u2019s word for it', async () => {
    // Taking the receipt from the primary alone passed every other test here.
    // Whether a payment succeeded is not a single node's call to make.
    const { user, orderId } = await quoted('hint-split@example.jp');
    h.ctx.chain = pair(good(), good({ transfer: { block: 1_000, amount: AMOUNT, logIndex: 2, status: 0 } }));
    const res = await report(user, orderId, TX);
    expect(res.statusCode).toBe(202);
    expect(res.json().detail).toMatch(/describe receipt .* differently/);
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('says so plainly when the transaction does not pay this service', async () => {
    const { user, orderId } = await quoted('hint-elsewhere@example.jp');
    h.ctx.chain = pair(
      good({ transfer: { block: 1_000, amount: AMOUNT, logIndex: 2, to: '0x3333333333333333333333333333333333333333' } }),
    );
    const res = await report(user, orderId, TX);
    // Accepted, not an error: a customer can paste the wrong hash, and that is
    // not a fault condition.
    expect(res.statusCode).toBe(202);
    expect(res.json().detail).toMatch(/does not pay this service/);
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('refuses a hash that is not a hash before touching the chain', async () => {
    const { user, orderId } = await quoted('hint-garbage@example.jp');
    h.ctx.chain = pair(good());
    const res = await report(user, orderId, '0xnot-a-hash');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('is not a way to read somebody else\u2019s order', async () => {
    const { orderId } = await quoted('hint-owner@example.jp');
    const nosy = await h.createUser({ email: 'hint-nosy@example.jp' });
    h.ctx.chain = pair(good());
    const res = await report(nosy, orderId, TX);
    expect(res.statusCode).toBe(404);
  });

  it('does not pay twice when the scan reaches the same payment afterwards', async () => {
    const { user, orderId } = await quoted('hint-then-scan@example.jp');
    h.ctx.chain = pair(good());
    await report(user, orderId, TX);
    expect((await balanceOf(user.id)).available).toBe(5);

    await runStablecoinScanPass(h.ctx, pair(good()), silent);
    expect((await balanceOf(user.id)).available).toBe(5);
  });
});
