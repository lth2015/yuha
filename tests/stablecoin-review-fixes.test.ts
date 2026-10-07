/**
 * The rest of what two adversarial reviews found.
 *
 * Each of these was real while the suite was green. The pattern they share is
 * the one worth naming: a value that was written down wrong, a record that was
 * never written at all, or a return value that was computed and thrown away.
 * None of them needed an attacker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getChainCursor, query, setChainCursor } from '@yuha/db';
import {
  ChainNode,
  encodeTransferCalldata,
  probeFinality,
  verifyTokenDecimals,
  type ChainObservation,
  type JsonRpcParams,
  type JsonRpcTransport,
  type TokenSpec,
} from '@yuha/providers';
import { settleStablecoinObservation } from '../apps/api/src/services/stablecoin-settle.js';
import { expireStaleIntents, SCAN_STREAM } from '../apps/api/src/services/stablecoin-scan.js';
import { createStablecoinQuote } from '../apps/api/src/services/stablecoin.js';
import { balanceOf, createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `198.51.100.${(callNo++ % 200) + 10}` });

const RECEIVER = '0x9999999999999999999999999999999999999999';
const STRANGER = '0x3333333333333333333333333333333333333333';
const JPYC = '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29';
const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const AMOUNT = 980n * 10n ** 18n;
const accountA = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PAYER = accountA.address.toLowerCase();

beforeAll(async () => {
  h = await createHarness({
    STABLECOIN_ENABLED: 'true',
    STABLECOIN_JPYC_ENABLED: 'true',
    STABLECOIN_RECEIVER_ADDRESS: RECEIVER,
    POLYGON_RPC_PRIMARY_URL: 'https://primary.invalid/rpc',
    POLYGON_RPC_SECONDARY_URL: 'https://secondary.invalid/rpc',
  });
});
beforeEach(async () => {
  await resetData();
  await query(`DELETE FROM chain_cursors`);
});
afterAll(async () => {
  await teardown();
});

async function linkedUser(email: string): Promise<TestUser> {
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
  return user;
}

const quote = (user: TestUser, key: string) =>
  createStablecoinQuote(h.ctx, {
    userId: user.id,
    priceKey: 'drop_5',
    idempotencyKey: key,
    tokenKey: 'jpyc',
    payer: accountA.address,
  });

function observe(over: Partial<{ amount: bigint; token: string; to: string; status: 0 | 1; extraLogFirst: boolean }> = {}): ChainObservation {
  const amount = over.amount ?? AMOUNT;
  const token = over.token ?? JPYC;
  const to = over.to ?? RECEIVER;
  const payment = { token, from: PAYER, to, value: amount, logIndex: 3, blockNumber: 500n };
  const noise = { token: STRANGER, from: PAYER, to: STRANGER, value: 1n, logIndex: 0, blockNumber: 500n };
  return {
    transaction: {
      hash: '0xaa', chainId: 137, from: PAYER, to: token, value: 0n,
      input: encodeTransferCalldata(to, amount), nonce: 11, blockNumber: 500n, blockHash: '0xbb',
    },
    receipt: { status: over.status ?? 1, blockNumber: 500n, blockHash: '0xbb' },
    transferLogs: over.extraLogFirst ? [noise, payment] : [payment],
    block: { number: 500n, hash: '0xbb', timestampMs: Date.now() },
    canonicalBlockHashAtHeight: '0xbb',
    finalizedBlockNumber: 600n,
  };
}

describe('a payment the verifier refuses is still money that arrived', () => {
  it('is written down, so an operator can see it', async () => {
    /*
     * A refusal left only a `stablecoin_attempts` row, which nothing in the
     * console surfaces. A customer paying USDC against a JPYC quote had real
     * money arrive that appeared in neither operator queue.
     */
    const user = await linkedUser('rej-usdc@example.jp');
    await quote(user, 'rej-usdc-0001');
    const out = await settleStablecoinObservation(h.ctx, observe({ token: USDC }));
    expect(out.kind).toBe('rejected');

    const rows = await query<{ amount_atomic: string; intent_id: string | null; token_address: string }>(
      `SELECT amount_atomic, intent_id, token_address FROM chain_transfer_events`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_atomic).toBe(AMOUNT.toString());
    expect(rows[0]!.intent_id).toBeNull();
    expect(rows[0]!.token_address).toBe(USDC);
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('writes nothing for a transaction that failed, because nothing moved', async () => {
    const user = await linkedUser('rej-failed@example.jp');
    await quote(user, 'rej-failed-0001');
    await settleStablecoinObservation(h.ctx, observe({ status: 0 }));
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM chain_transfer_events`);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('money from a wallet with nothing open', () => {
  it('is recorded from the log that paid us, not from log zero', async () => {
    /*
     * These fields came from `transferLogs[0]`, and a transaction's first
     * Transfer is usually not the payment. The operator queue showed the wrong
     * amount to refund, keyed on a log index that was not the payment's.
     */
    const out = await settleStablecoinObservation(h.ctx, observe({ extraLogFirst: true }));
    expect(out.kind).toBe('unattributed');
    const rows = await query<{ amount_atomic: string; to_address: string; log_index: number }>(
      `SELECT amount_atomic, to_address, log_index FROM chain_transfer_events`,
    );
    expect(rows[0]!.amount_atomic).toBe(AMOUNT.toString());
    expect(rows[0]!.to_address).toBe(RECEIVER.toLowerCase());
    expect(Number(rows[0]!.log_index)).toBe(3);
  });
});

describe('an order that can no longer be paid', () => {
  it('cannot be re-quoted after a refund', async () => {
    const user = await linkedUser('refunded@example.jp');
    const q = await quote(user, 'refunded-0001');
    await query(`UPDATE orders SET status = 'refunded' WHERE id = ?`, [q.orderId]);
    await expect(quote(user, 'refunded-0001')).rejects.toThrow(/no longer be paid/);
  });

  it('sends a payment that cannot move the order to review rather than reporting success', async () => {
    /*
     * `markOrderPaid` returns `changed`, which was discarded — so a second
     * payment on a refunded order was taken, delivered nothing, and answered
     * `fulfilled`.
     */
    const user = await linkedUser('unpayable@example.jp');
    const q = await quote(user, 'unpayable-0001');
    await query(`UPDATE orders SET status = 'refunded' WHERE id = ?`, [q.orderId]);

    const out = await settleStablecoinObservation(h.ctx, observe());
    expect(out.kind).toBe('review');
    expect((await balanceOf(user.id)).available).toBe(0);
    // The money is on the record even though the order could not take it.
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM chain_transfer_events`);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe('a quote nobody paid', () => {
  it('stops holding the wallet once it expires', async () => {
    /*
     * `closeIntent({ state: 'expired' })` had no caller and no sweep. One
     * abandoned quote held a wallet's only slot forever, so every later quote
     * that wallet made for a different order was refused, permanently.
     */
    const user = await linkedUser('stale@example.jp');
    const first = await quote(user, 'stale-0001');
    await query(`UPDATE stablecoin_quotes SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE id = ?`, [
      first.quoteId,
    ]);

    // Before the sweep: a different order is refused.
    await expect(quote(user, 'stale-0002')).rejects.toThrow(/already has a payment waiting/);

    expect(await expireStaleIntents()).toBe(1);
    const rows = await query<{ state: string; open_key: string | null }>(
      `SELECT state, open_key FROM stablecoin_intents WHERE quote_id = ?`,
      [first.quoteId],
    );
    expect(rows[0]!.state).toBe('expired');
    expect(rows[0]!.open_key).toBeNull();

    // And now the wallet can buy something else.
    await expect(quote(user, 'stale-0003')).resolves.toBeTruthy();
  });

  it('leaves a live quote alone', async () => {
    const user = await linkedUser('live@example.jp');
    await quote(user, 'live-0001');
    expect(await expireStaleIntents()).toBe(0);
  });
});

describe('where a quote starts watching', () => {
  it('is where the scanner has reached, not block zero', async () => {
    /*
     * Hardcoded 0 disabled `before_start_block` entirely: the verifier bounds
     * inclusion only from above, so an arbitrarily old transfer could satisfy
     * a brand-new quote.
     */
    await setChainCursor({ chainId: 137, stream: SCAN_STREAM, block: 7_000n });
    const user = await linkedUser('startblock@example.jp');
    const q = await quote(user, 'startblock-0001');
    const rows = await query<{ start_block: string | number }>(
      `SELECT start_block FROM stablecoin_quotes WHERE id = ?`,
      [q.quoteId],
    );
    expect(BigInt(rows[0]!.start_block)).toBe(7_000n);
    expect(await getChainCursor({ chainId: 137, stream: SCAN_STREAM })).toBe(7_000n);
  });

  it('refuses a payment older than the quote', async () => {
    await setChainCursor({ chainId: 137, stream: SCAN_STREAM, block: 7_000n });
    const user = await linkedUser('oldpayment@example.jp');
    await quote(user, 'oldpayment-0001');
    // The observation is in block 500, far below where this quote starts.
    const out = await settleStablecoinObservation(h.ctx, observe());
    expect(out.kind).toBe('rejected');
    expect(out.kind === 'rejected' && out.reason).toBe('before_start_block');
    expect((await balanceOf(user.id)).available).toBe(0);
  });
});

describe('the token decimals check that only a comment claimed', () => {
  const spec = (decimals: number): TokenSpec => ({
    key: 'jpyc', chainId: 137, address: JPYC, decimals, label: 'JPYC',
  });

  it('accepts a contract that reports what the whitelist says', async () => {
    const problems = await verifyTokenDecimals(async () => `0x${(18).toString(16)}`, [spec(18)]);
    expect(problems).toEqual([]);
  });

  it('refuses a contract that reports something else', async () => {
    // Six where eighteen was configured is a factor of a trillion, and every
    // quote would be "a number" that looked fine.
    const problems = await verifyTokenDecimals(async () => `0x${(6).toString(16)}`, [spec(18)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.reason).toMatch(/reports 6 decimals/);
  });

  it('refuses a contract that cannot be asked', async () => {
    const problems = await verifyTokenDecimals(async () => {
      throw new Error('execution reverted');
    }, [spec(18)]);
    expect(problems[0]!.reason).toMatch(/could not be read/);
  });
});

describe('the finality probe', () => {
  const hex = (n: number) => `0x${n.toString(16)}`;
  function node(over: { latest: number; finalized: number; finalizedHash?: string; atHeightHash?: string }): ChainNode {
    const transport: JsonRpcTransport = {
      label: 'fake',
      async request(method: string, params: JsonRpcParams) {
        if (method === 'eth_blockNumber') return hex(over.latest);
        if (method === 'eth_getBlockByNumber') {
          const tag = params[0] as string;
          if (tag === 'finalized') {
            return { number: hex(over.finalized), hash: over.finalizedHash ?? '0xaa', timestamp: hex(1_700_000_000) };
          }
          return { number: tag, hash: over.atHeightHash ?? '0xaa', timestamp: hex(1_700_000_000) };
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    return new ChainNode(transport);
  }

  it('refuses a finalized header that is not the block at that height', async () => {
    // A node answering the tag from a cache, another network, or thin air.
    const p = await probeFinality(node({ latest: 1_000, finalized: 990, finalizedHash: '0xaa', atHeightHash: '0xbb' }));
    expect(p.supported).toBe(false);
    expect(p.reason).toMatch(/is not the block at height 990/);
  });

  it('accepts a node whose finalized header really is at that height', async () => {
    const p = await probeFinality(node({ latest: 1_000, finalized: 990 }));
    expect(p.supported).toBe(true);
  });
});
