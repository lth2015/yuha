/**
 * The dashboard and the ops panel describe the same money.
 *
 * They disagreed in production: the dashboard counted 5 paid orders worth
 * ¥6,900 while the ops panel showed $0 for 5 orders. The dashboard reads
 * `orders`; the ops panel reads `payments`, and a stablecoin settlement marked
 * its order paid without writing a payment row — so on-chain money existed in
 * one figure and not the other, and an empty `payments` window was labelled
 * USD by default in a service that sells only in yen.
 *
 * Each order here travels the real path — a simulated card checkout through
 * the signed-webhook pipeline, a JPYC quote through settlement — and the
 * figures are read back from both admin endpoints and from the rows.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { processWebhookEvent } from '@yuha/api';
import { claimWebhookEvents, query, withTx } from '@yuha/db';
import { encodeTransferCalldata, type ChainObservation } from '@yuha/providers';
import { settleStablecoinObservation } from '../apps/api/src/services/stablecoin-settle.js';
import {
  createHarness,
  resetData,
  seedScanCursor,
  teardown,
  verifiedChainStub,
  type Harness,
  type TestUser,
} from './helpers/harness.js';

let h: Harness;
let admin: TestUser;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `192.0.2.${(callNo++ % 200) + 10}` });

const RECEIVER = '0x9999999999999999999999999999999999999999';
const JPYC = '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29';
const AMOUNT = 980n * 10n ** 18n;
const payerAccount = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PAYER = payerAccount.address.toLowerCase();

beforeAll(async () => {
  h = await createHarness({
    ADMIN_MFA_REQUIRED: 'false',
    STABLECOIN_ENABLED: 'true',
    STABLECOIN_JPYC_ENABLED: 'true',
    STABLECOIN_RECEIVER_ADDRESS: RECEIVER,
    POLYGON_RPC_PRIMARY_URL: 'https://polygon.primary.invalid/rpc/test',
    POLYGON_RPC_SECONDARY_URL: 'https://polygon.secondary.invalid/rpc/test',
  });
  h.ctx.chain = verifiedChainStub();
});
beforeEach(async () => {
  await resetData();
  await seedScanCursor(1n);
  admin = await h.createUser({ email: 'revenue-admin@example.test', role: 'admin' });
});
afterAll(async () => {
  await teardown();
});

const get = (user: TestUser, url: string) => h.app.inject({ method: 'GET', url, headers: user.authHeader });

async function drainWebhooks(): Promise<void> {
  const events = await withTx(async (tx) => claimWebhookEvents(20, tx));
  for (const ev of events) await processWebhookEvent(h.ctx, ev);
}

/** A card order, paid through the simulated checkout and the webhook pipeline. */
async function paidCardOrder(email: string): Promise<string> {
  const user = await h.createUser({ email });
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/checkout',
    headers: user.authHeader,
    payload: { priceKey: 'drop_5', idempotencyKey: `card-${email}` } as never,
  });
  expect(res.statusCode, res.body).toBe(200);
  const { orderId, checkoutUrl } = res.json() as { orderId: string; checkoutUrl: string };
  const sessionId = new URL(checkoutUrl).searchParams.get('session_id')!;
  const settled = await h.app.inject({
    method: 'POST',
    url: '/v1/dev/simulate-payment',
    headers: user.authHeader,
    payload: { sessionId, outcome: 'paid' } as never,
  });
  expect(settled.statusCode, settled.body).toBe(200);
  await drainWebhooks();
  return orderId;
}

/** A JPYC order, quoted through the API and settled from chain evidence. */
async function quotedJpycOrder(email: string): Promise<string> {
  const user = await h.createUser({ email });
  const ch = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-challenge',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { address: payerAccount.address, chainId: 137 } as never,
  });
  const { nonce, message } = ch.json() as { nonce: string; message: string };
  await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-verify',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { nonce, address: payerAccount.address, signature: await payerAccount.signMessage({ message }) } as never,
  });
  const q = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/quote',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { priceKey: 'drop_5', idempotencyKey: `jpyc-${email}`, tokenKey: 'jpyc', payer: payerAccount.address } as never,
  });
  expect(q.statusCode, q.body).toBe(200);
  return q.json().orderId as string;
}

function observe(hash = '0xaa', logIndex = 2): ChainObservation {
  return {
    transaction: {
      hash,
      chainId: 137,
      from: PAYER,
      to: JPYC,
      value: 0n,
      input: encodeTransferCalldata(RECEIVER, AMOUNT),
      nonce: 11,
      blockNumber: 500n,
      blockHash: '0xbb',
    },
    receipt: { status: 1, blockNumber: 500n, blockHash: '0xbb' },
    transferLogs: [{ token: JPYC, from: PAYER, to: RECEIVER, value: AMOUNT, logIndex, blockNumber: 500n }],
    block: { number: 500n, hash: '0xbb', timestampMs: Date.now() },
    canonicalBlockHashAtHeight: '0xbb',
    finalizedBlockNumber: 600n,
  };
}

/** Today's date in Tokyo, the dashboard's bucket key. */
function todayJst(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

interface Revenue {
  currency: string | null;
  grossMinor: number;
  paidOrderCount: number;
  paidOrdersWithoutPayment: number;
}

async function opsRevenue(): Promise<Revenue> {
  const res = await get(admin, '/v1/admin/overview');
  expect(res.statusCode, res.body).toBe(200);
  return res.json().revenue as Revenue;
}

async function dashboardTotals(): Promise<{ count: number; jpy: number }> {
  const d = todayJst();
  const res = await get(admin, `/v1/admin/stats?granularity=day&from=${d}&to=${d}`);
  expect(res.statusCode, res.body).toBe(200);
  const b = res.json().buckets[0] as { paidOrders: { count: number }; revenueJpy: { total: number } };
  return { count: b.paidOrders.count, jpy: b.revenueJpy.total };
}

describe('one card order and one JPYC order in the same window', () => {
  it('reads the same order count and the same yen gross on the dashboard and the ops panel', async () => {
    const cardOrder = await paidCardOrder('card-buyer@example.test');
    const jpycOrder = await quotedJpycOrder('jpyc-buyer@example.test');
    expect(await settleStablecoinObservation(h.ctx, observe())).toEqual({ kind: 'fulfilled', orderId: jpycOrder });

    // The orders themselves, read back: both paid, ¥980 each, in yen.
    const orders = await query<{ id: string; status: string; amount_minor: number; currency: string }>(
      `SELECT id, status, amount_minor, currency FROM orders WHERE id IN (?, ?)`,
      [cardOrder, jpycOrder],
    );
    expect(orders.map((o) => [o.status, o.amount_minor, o.currency])).toEqual([
      ['paid', 980, 'jpy'],
      ['paid', 980, 'jpy'],
    ]);

    const dash = await dashboardTotals();
    const ops = await opsRevenue();
    expect(dash).toEqual({ count: 2, jpy: 1960 });
    expect(ops.paidOrderCount).toBe(dash.count);
    expect(ops.grossMinor).toBe(dash.jpy);
    expect(ops.currency).toBe('jpy');
    expect(ops.paidOrdersWithoutPayment).toBe(0);
  });

  it('writes the on-chain payment as a payments row in yen, carrying the token details', async () => {
    const orderId = await quotedJpycOrder('jpyc-row@example.test');
    await settleStablecoinObservation(h.ctx, observe('0xcafe', 7));

    const rows = await query<{ kind: string; stripe_object_id: string; amount_minor: number; currency: string; status: string; raw: unknown }>(
      `SELECT kind, stripe_object_id, amount_minor, currency, status, raw FROM payments WHERE order_id = ?`,
      [orderId],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('payment');
    expect(row.stripe_object_id).toBe('chain:137:0xcafe:7');
    expect(row.amount_minor).toBe(980);
    expect(row.currency).toBe('jpy');
    expect(row.status).toBe('succeeded');
    const raw = (typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw) as Record<string, unknown>;
    expect(raw).toMatchObject({
      rail: 'stablecoin',
      tokenKey: 'jpyc',
      chainId: 137,
      tokenAddress: JPYC,
      txHash: '0xcafe',
      logIndex: 7,
      amountAtomic: AMOUNT.toString(),
    });
  });

  it('does not write a second payment row when the scanner sees the same transfer again', async () => {
    const orderId = await quotedJpycOrder('jpyc-replay@example.test');
    await settleStablecoinObservation(h.ctx, observe());
    expect((await settleStablecoinObservation(h.ctx, observe())).kind).toBe('already_settled');
    const [n] = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ?`, [orderId]);
    expect(Number(n!.n)).toBe(1);
    expect((await opsRevenue()).grossMinor).toBe(980);
  });
});

describe('what the ops panel says when it cannot see the money', () => {
  it('names no currency for a window with no payment rows, rather than calling it USD', async () => {
    const ops = await opsRevenue();
    expect(ops.currency).toBeNull();
    expect(ops.grossMinor).toBe(0);
    expect(ops.paidOrderCount).toBe(0);
  });

  it('counts a paid order that has no payment row, instead of letting gross quietly read low', async () => {
    // An order marked paid by a path that wrote no payment row — the shape a
    // subscription order takes when its invoice carries no top-level charge.
    const u = await h.createUser({ email: 'uncovered@example.test' });
    const [cat] = await query<{ version: number }>(`SELECT MAX(version) AS version FROM product_catalog WHERE price_key = 'drop_5'`);
    const id = randomUUID();
    await query(
      `INSERT INTO orders (id, user_id, price_key, price_version, kind, amount_minor, currency, status, idempotency_key, metadata, payment_method, paid_at)
       VALUES (?, ?, 'drop_5', ?, 'one_time', 980, 'jpy', 'paid', ?, '{}', 'card', UTC_TIMESTAMP(3))`,
      [id, u.id, Number(cat!.version), `idem-${id}`],
    );
    const ops = await opsRevenue();
    expect(ops.paidOrderCount).toBe(1);
    expect(ops.paidOrdersWithoutPayment).toBe(1);
    expect(ops.grossMinor).toBe(0);
    expect(ops.currency).toBeNull();
  });

  it('counts a refunded order as paid in its window, as the dashboard does', async () => {
    const orderId = await paidCardOrder('refunded@example.test');
    await query(`UPDATE orders SET status = 'refunded' WHERE id = ?`, [orderId]);
    const dash = await dashboardTotals();
    const ops = await opsRevenue();
    expect(dash.count).toBe(1);
    expect(ops.paidOrderCount).toBe(1);
    expect(ops.paidOrdersWithoutPayment).toBe(0);
  });
});
