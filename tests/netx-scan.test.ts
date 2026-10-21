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
import {
  ChainNode,
  DualChainReader,
  NETX_BSC,
  TRANSFER_TOPIC,
  addressTopic,
  encodeTransferCalldata,
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
