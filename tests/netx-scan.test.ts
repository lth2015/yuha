/**
 * A NETX payment on BNB Smart Chain, found by BSC's own scanner.
 *
 * The case that decides money: an operator pauses NETX after a buyer was
 * quoted and has paid. Pausing stops NEW quotes; the payment already sent
 * must still be found and credited — otherwise the pause switch would be a
 * way to take somebody's tokens and deliver nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getChainCursor, query } from '@yuha/db';
import { expireStaleIntents } from '../apps/api/src/services/stablecoin-scan.js';
import { settleStablecoinObservation } from '../apps/api/src/services/stablecoin-settle.js';
import {
  ChainNode,
  DualChainReader,
  NETX_BSC,
  TRANSFER_TOPIC,
  addressTopic,
  encodeTransferCalldata,
  type ChainObservation,
  type JsonRpcParams,
} from '@yuha/providers';
import { runStablecoinScanPass, SCAN_STREAM } from '../apps/api/src/services/stablecoin-scan.js';
import { balanceOf, createHarness, resetData, teardown, type Harness, type TestUser, seedScanCursor, verifiedChainStub } from './helpers/harness.js';

let h: Harness;
let admin: TestUser;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `203.0.114.${(callNo++ % 200) + 10}` });
const silent = () => undefined;

const RECEIVER = '0x9999999999999999999999999999999999999999';
const wallet = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PAYER = wallet.address.toLowerCase();
const AMOUNT = 49n * 10n ** BigInt(NETX_BSC.decimals); // ¥980 at ¥20
const TX = `0x${'4e'.repeat(32)}`;
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;
const H = (c: string) => `0x${c.repeat(64)}`;
const HASHES: Record<number, string> = { 1_000: H('a'), 1_050: H('b'), 1_100: H('c') };

/** A BNB Smart Chain node that saw one NETX payment to us at block 1000, finalized at 1050. */
function bscNode(label: string): ChainNode {
  const log = {
    address: NETX_BSC.address,
    topics: [TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(RECEIVER)],
    data: hex(AMOUNT),
    blockNumber: hex(1_000),
    blockHash: HASHES[1_000],
    transactionHash: TX,
    logIndex: hex(3),
  };
  return new ChainNode({
    label,
    async request(method: string, params: JsonRpcParams): Promise<unknown> {
      switch (method) {
        case 'eth_chainId':
          return hex(56);
        case 'eth_call':
          return `0x${NETX_BSC.decimals.toString(16).padStart(64, '0')}`;
        case 'eth_blockNumber':
          return hex(1_100);
        case 'eth_getBlockByNumber': {
          const tag = params[0] as string;
          const n = tag === 'finalized' ? 1_050 : tag === 'latest' ? 1_100 : Number(BigInt(tag));
          return HASHES[n] ? { number: hex(n), hash: HASHES[n], timestamp: hex(1_760_000_000) } : null;
        }
        case 'eth_getLogs': {
          const f = params[0] as { fromBlock: string; toBlock: string };
          return Number(BigInt(f.fromBlock)) <= 1_000 && 1_000 <= Number(BigInt(f.toBlock)) ? [log] : [];
        }
        case 'eth_getTransactionByHash':
          return {
            hash: TX,
            from: PAYER,
            to: NETX_BSC.address,
            value: '0x0',
            input: encodeTransferCalldata(RECEIVER, AMOUNT),
            nonce: hex(1),
            blockNumber: hex(1_000),
            blockHash: HASHES[1_000],
            chainId: hex(56),
          };
        case 'eth_getTransactionReceipt':
          return { status: hex(1), blockNumber: hex(1_000), blockHash: HASHES[1_000], logs: [log] };
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  });
}

beforeAll(async () => {
  h = await createHarness({
    STABLECOIN_ENABLED: 'true',
    STABLECOIN_JPYC_ENABLED: 'true',
    STABLECOIN_NETX_ENABLED: 'true',
    STABLECOIN_RECEIVER_ADDRESS: RECEIVER,
    POLYGON_RPC_PRIMARY_URL: 'https://polygon.primary.invalid/rpc',
    POLYGON_RPC_SECONDARY_URL: 'https://polygon.secondary.invalid/rpc',
    BSC_RPC_PRIMARY_URL: 'https://bsc.primary.invalid/rpc',
    BSC_RPC_SECONDARY_URL: 'https://bsc.secondary.invalid/rpc',
    ADMIN_MFA_REQUIRED: 'false',
  });
  h.ctx.chain = verifiedChainStub(137);
});
beforeEach(async () => {
  await resetData();
  await seedScanCursor(500n, 137);
  await seedScanCursor(900n, 56);
  h.ctx.otherChains.set(56, new DualChainReader(bscNode('bsc-primary'), bscNode('bsc-secondary')));
  admin = await h.createUser({ email: 'netx-scan-admin@example.test', role: 'admin' });
});
afterAll(async () => {
  await teardown();
});

async function quotedInNetx(email: string): Promise<{ user: TestUser; orderId: string }> {
  const user = await h.createUser({ email });
  const ch = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-challenge',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { address: wallet.address, chainId: 56 } as never,
  });
  const { nonce, message } = ch.json() as { nonce: string; message: string };
  await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-verify',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { nonce, address: wallet.address, signature: await wallet.signMessage({ message }) } as never,
  });
  const q = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/quote',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { priceKey: 'drop_5', idempotencyKey: `netx-scan-${email}`, tokenKey: 'netx', payer: wallet.address } as never,
  });
  expect(q.statusCode, q.body).toBe(200);
  return { user, orderId: (q.json() as { orderId: string }).orderId };
}

describe('a NETX payment on BNB Smart Chain', () => {
  it('is found by the BSC scanner and credited, on the BSC cursor alone', async () => {
    const { user, orderId } = await quotedInNetx('netx-scan-ok@example.test');

    const pass = await runStablecoinScanPass(h.ctx, h.ctx.otherChains.get(56)!, silent, 56);
    expect(pass.found).toBe(1);
    expect(pass.settled.map((s) => s.kind)).toContain('fulfilled');

    const [order] = await query<{ status: string }>(`SELECT status FROM orders WHERE id = ?`, [orderId]);
    expect(order!.status).toBe('paid');
    expect((await balanceOf(user.id)).available).toBe(5);
    expect(await getChainCursor({ chainId: 56, stream: SCAN_STREAM })).toBe(1_050n);
    expect(await getChainCursor({ chainId: 137, stream: SCAN_STREAM })).toBe(500n);
  });

  it('is still credited after an operator pauses NETX — a pause stops quotes, not collection', async () => {
    const { user, orderId } = await quotedInNetx('netx-scan-paused@example.test');
    const paused = await h.app.inject({
      method: 'PUT',
      url: '/v1/admin/netx-payments',
      headers: { ...admin.authHeader, ...freshIp() },
      payload: { accepting: false, reason: 'market price under twenty yen' } as never,
    });
    expect(paused.statusCode, paused.body).toBe(200);

    await runStablecoinScanPass(h.ctx, h.ctx.otherChains.get(56)!, silent, 56);
    const [order] = await query<{ status: string }>(`SELECT status FROM orders WHERE id = ?`, [orderId]);
    expect(order!.status).toBe('paid');
    expect((await balanceOf(user.id)).available).toBe(5);
  });
});

describe('a NETX hash the customer reports', () => {
  it('is looked up on BNB Smart Chain — Polygon has never heard of it', async () => {
    const { user, orderId } = await quotedInNetx('netx-report@example.test');
    // ctx.chain (Polygon) is a stub that knows no transaction at all; only the
    // BSC reader can find TX. Asking the wrong chain answers 202 "not found".
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/stablecoin-transaction`,
      headers: { ...user.authHeader, ...freshIp() },
      payload: { txHash: TX } as never,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'fulfilled' });
    expect((await balanceOf(user.id)).available).toBe(5);
  });
});

describe('expiring stale quotes', () => {
  it('closes only the chain it is asked about', async () => {
    const { orderId: bscOrder } = await quotedInNetx('netx-expire@example.test');
    // A Polygon intent, quoted and expired at the same moment.
    const other = await h.createUser({ email: 'polygon-expire@example.test' });
    const [bscIntent] = await query<{ quote_id: string }>(`SELECT quote_id FROM stablecoin_intents WHERE order_id = ?`, [bscOrder]);
    await query(
      `INSERT INTO orders (id, user_id, price_key, price_version, kind, amount_minor, currency, status, idempotency_key, metadata, payment_method)
       SELECT UUID(), ?, price_key, price_version, kind, amount_minor, currency, 'pending', CONCAT('poly-', UUID()), '{}', 'stablecoin' FROM orders WHERE id = ?`,
      [other.id, bscOrder],
    );
    const [polyOrder] = await query<{ id: string }>(`SELECT id FROM orders WHERE user_id = ?`, [other.id]);
    await query(
      `INSERT INTO stablecoin_quotes (id, order_id, user_id, token_key, chain_id, token_address, token_decimals, receiver, payer, price_jpy, amount_atomic, start_block, config_version, expires_at)
       SELECT UUID(), ?, ?, 'jpyc', 137, '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29', 18, receiver, '0x1111111111111111111111111111111111111111', price_jpy, '980000000000000000000', 1, 1, expires_at FROM stablecoin_quotes WHERE id = ?`,
      [polyOrder!.id, other.id, bscIntent!.quote_id],
    );
    const [polyQuote] = await query<{ id: string }>(`SELECT id FROM stablecoin_quotes WHERE order_id = ?`, [polyOrder!.id]);
    await query(
      `INSERT INTO stablecoin_intents (id, quote_id, order_id, chain_id, payer, state, open_key, order_open_key)
       VALUES (UUID(), ?, ?, 137, '0x1111111111111111111111111111111111111111', 'quoted', '137:0x1111111111111111111111111111111111111111', ?)`,
      [polyQuote!.id, polyOrder!.id, polyOrder!.id],
    );
    await query(`UPDATE stablecoin_quotes SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 HOUR`);

    await expireStaleIntents({ graceSeconds: 0, chainId: 56 });
    const states = await query<{ chain_id: number; state: string }>(`SELECT chain_id, state FROM stablecoin_intents ORDER BY chain_id`);
    expect(states.map((x) => [x.chain_id, x.state])).toEqual([
      [56, 'expired'],
      [137, 'quoted'],
    ]);
  });
});

describe('the operator queue', () => {
  it('says which chain and token an unattributed NETX transfer is in, even while NETX is paused', async () => {
    /*
     * JPYC and NETX both have eighteen decimals. A queue row that showed a raw
     * amount and a truncated hash left an operator to guess which token to
     * refund in — 49 of one is ¥980, 49 of the other ¥49.
     */
    expect(
      (await h.app.inject({
        method: 'PUT', url: '/v1/admin/netx-payments', headers: { ...admin.authHeader, ...freshIp() },
        payload: { accepting: false, reason: 'market price under twenty yen' } as never,
      })).statusCode,
    ).toBe(200);
    const observation: ChainObservation = {
      transaction: {
        hash: TX, chainId: 56, from: PAYER, to: NETX_BSC.address, value: 0n,
        input: encodeTransferCalldata(RECEIVER, AMOUNT), nonce: 1, blockNumber: 1_000n, blockHash: HASHES[1_000]!,
      },
      receipt: { status: 1, blockNumber: 1_000n, blockHash: HASHES[1_000]! },
      transferLogs: [{ token: NETX_BSC.address, from: PAYER, to: RECEIVER, value: AMOUNT, logIndex: 3, blockNumber: 1_000n }],
      block: { number: 1_000n, hash: HASHES[1_000]!, timestampMs: Date.now() },
      canonicalBlockHashAtHeight: HASHES[1_000]!,
      finalizedBlockNumber: 1_050n,
    };
    await settleStablecoinObservation(h.ctx, observation);
    const res = await h.app.inject({ method: 'GET', url: '/v1/admin/stablecoin-payments', headers: { ...admin.authHeader, ...freshIp() } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().unattributed[0]).toMatchObject({
      chainId: 56,
      asset: { key: 'netx', label: NETX_BSC.label, decimals: NETX_BSC.decimals },
    });
  });
});
