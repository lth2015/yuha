/**
 * Paying with NETX, on BNB Smart Chain, at a fixed ¥20 (docs/NETX_PAYMENT.md).
 *
 * The cases that decide money and trust: it is priced as fixed yen on its own
 * chain; it is a token rail like the others (top-ups and licences, never a
 * subscription); an operator can pause it without a deploy, and pausing stops
 * new quotes without stranding a payment already on its way; and it cannot be
 * switched on without its own pair of BSC nodes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { NETX_BSC } from '@yuha/providers';
import { ConfigError, loadConfig } from '@yuha/api';
import { query } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness, type TestUser, seedScanCursor, verifiedChainStub } from './helpers/harness.js';

let h: Harness;
let admin: TestUser;
let support: TestUser;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `198.51.101.${(callNo++ % 200) + 10}` });
const wallet = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

const NETX_ENV = {
  STABLECOIN_ENABLED: 'true',
  STABLECOIN_JPYC_ENABLED: 'true',
  STABLECOIN_NETX_ENABLED: 'true',
  STABLECOIN_RECEIVER_ADDRESS: '0x9999999999999999999999999999999999999999',
  POLYGON_RPC_PRIMARY_URL: 'https://polygon.primary.invalid/rpc/test',
  POLYGON_RPC_SECONDARY_URL: 'https://polygon.secondary.invalid/rpc/test',
  BSC_RPC_PRIMARY_URL: 'https://bsc.primary.invalid/rpc/test',
  BSC_RPC_SECONDARY_URL: 'https://bsc.secondary.invalid/rpc/test',
};

beforeAll(async () => {
  h = await createHarness({ ...NETX_ENV, ADMIN_MFA_REQUIRED: 'false' });
  h.ctx.chain = verifiedChainStub(137);
  h.ctx.otherChains.set(56, verifiedChainStub(56));
});
beforeEach(async () => {
  await resetData();
  await seedScanCursor(1n, 137);
  await seedScanCursor(1n, 56);
  admin = await h.createUser({ email: 'netx-admin@example.test', role: 'admin' });
  support = await h.createUser({ email: 'netx-support@example.test', role: 'support' });
});
afterAll(async () => {
  await teardown();
});

async function linkWallet(user: TestUser, chainId: number): Promise<void> {
  const ch = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-challenge',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { address: wallet.address, chainId } as never,
  });
  expect(ch.statusCode, ch.body).toBe(200);
  const { nonce, message } = ch.json() as { nonce: string; message: string };
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-verify',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { nonce, address: wallet.address, signature: await wallet.signMessage({ message }) } as never,
  });
  expect(res.statusCode, res.body).toBe(200);
}

const quoteNetx = (user: TestUser, key: string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/quote',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { priceKey: 'drop_5', idempotencyKey: key, tokenKey: 'netx', payer: wallet.address } as never,
  });

const runtime = async () =>
  (await h.app.inject({ method: 'GET', url: '/v1/runtime', headers: freshIp() })).json() as {
    stablecoin: { tokens: Array<{ key: string; chainId: number; label: string; stablecoin: boolean; yenPerToken: number | null }> };
  };

const pause = (user: TestUser, accepting: boolean, reason = 'market price under twenty yen') =>
  h.app.inject({
    method: 'PUT',
    url: '/v1/admin/netx-payments',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { accepting, reason } as never,
  });

describe('NETX as a way to pay', () => {
  it('is offered with its own chain, next to the Polygon tokens', async () => {
    const tokens = (await runtime()).stablecoin.tokens;
    expect(tokens.find((t) => t.key === 'netx')).toMatchObject({ chainId: 56, stablecoin: false, yenPerToken: 20 });
    expect(tokens.find((t) => t.key === 'jpyc')).toMatchObject({ chainId: 137, stablecoin: true, yenPerToken: null });
  });

  it('is a token rail: top-ups yes, subscriptions no', async () => {
    const products = (await h.app.inject({ method: 'GET', url: '/v1/products', headers: freshIp() })).json() as {
      items: Array<{ priceKey: string; kind: string; paymentMethods: Array<{ method: string; available: boolean }> }>;
    };
    const drop = products.items.find((p) => p.priceKey === 'drop_5')!;
    expect(drop.paymentMethods.find((m) => m.method === 'netx')?.available).toBe(true);
    const sub = products.items.find((p) => p.kind === 'subscription');
    expect(sub, 'the catalogue must list a subscription for this to test anything').toBeDefined();
    expect(sub!.paymentMethods.find((m) => m.method === 'netx')?.available).not.toBe(true);
  });

  it('quotes ¥980 as 49 NETX on BNB Smart Chain, wanting no exchange rate', async () => {
    const user = await h.createUser({ email: 'netx-buyer@example.test' });
    await linkWallet(user, 56);
    h.ctx.fx = {
      primary: async () => {
        throw new Error('NETX must not consult the USD/JPY feed');
      },
      reference: async () => {
        throw new Error('NETX must not consult the USD/JPY feed');
      },
    };
    const res = await quoteNetx(user, 'netx-quote-0001');
    expect(res.statusCode, res.body).toBe(200);
    const q = res.json() as { chainId: number; tokenAddress: string; amountAtomic: string; tokenKey: string };
    expect(q.tokenKey).toBe('netx');
    expect(q.chainId).toBe(56);
    expect(q.tokenAddress.toLowerCase()).toBe(NETX_BSC.address);
    expect(q.amountAtomic).toBe((49n * 10n ** BigInt(NETX_BSC.decimals)).toString());
  });

  it('wants the wallet proved on BNB Smart Chain, not just on Polygon', async () => {
    const user = await h.createUser({ email: 'netx-polygon-only@example.test' });
    await linkWallet(user, 137);
    const res = await quoteNetx(user, 'netx-quote-0002');
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/prove control/) });
    await linkWallet(user, 56);
    expect((await quoteNetx(user, 'netx-quote-0002b')).statusCode).toBe(200);
  });
});

describe('re-quoting an order on the other chain', () => {
  it('is refused once the wallet was handed the NETX transfer — that payment may be on its way', async () => {
    /*
     * A re-quote supersedes the order's open intent. Across chains that meant
     * a NETX transfer the wallet had already been asked to sign lost its
     * intent, the report endpoint followed the new (Polygon) quote, and the
     * BSC payment ended up unattributed.
     */
    const user = await h.createUser({ email: 'netx-requote@example.test' });
    await linkWallet(user, 56);
    await linkWallet(user, 137);
    const q = await quoteNetx(user, 'netx-requote-1');
    expect(q.statusCode, q.body).toBe(200);
    const { orderId } = q.json() as { orderId: string };
    const prep = await h.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/stablecoin-prepare`,
      headers: { ...user.authHeader, ...freshIp() },
    });
    expect(prep.statusCode, prep.body).toBe(200);
    const jpyc = await h.app.inject({
      method: 'POST',
      url: '/v1/payments/stablecoin/quote',
      headers: { ...user.authHeader, ...freshIp() },
      payload: { priceKey: 'drop_5', idempotencyKey: 'netx-requote-1', tokenKey: 'jpyc', payer: wallet.address } as never,
    });
    expect(jpyc.statusCode, jpyc.body).toBe(409);
    const [open] = await query<{ chain_id: number; state: string }>(
      `SELECT chain_id, state FROM stablecoin_intents WHERE order_id = ? AND order_open_key IS NOT NULL`,
      [orderId],
    );
    expect(open).toMatchObject({ chain_id: 56, state: 'prepared' });
  });

  it('is allowed before anything was handed to the wallet', async () => {
    const user = await h.createUser({ email: 'netx-requote-early@example.test' });
    await linkWallet(user, 56);
    await linkWallet(user, 137);
    expect((await quoteNetx(user, 'netx-requote-2')).statusCode).toBe(200);
    const jpyc = await h.app.inject({
      method: 'POST',
      url: '/v1/payments/stablecoin/quote',
      headers: { ...user.authHeader, ...freshIp() },
      payload: { priceKey: 'drop_5', idempotencyKey: 'netx-requote-2', tokenKey: 'jpyc', payer: wallet.address } as never,
    });
    expect(jpyc.statusCode, jpyc.body).toBe(200);
  });
});

describe('pausing NETX', () => {
  it('stops new quotes and hides it, at once and without a restart', async () => {
    const user = await h.createUser({ email: 'netx-paused@example.test' });
    await linkWallet(user, 56);

    const off = await pause(admin, false);
    expect(off.statusCode, off.body).toBe(200);
    expect((await runtime()).stablecoin.tokens.map((t) => t.key)).not.toContain('netx');
    const refused = await quoteNetx(user, 'netx-quote-0003');
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe('SERVICE_DISABLED');

    expect((await pause(admin, true, 'market price recovered')).statusCode).toBe(200);
    expect((await runtime()).stablecoin.tokens.map((t) => t.key)).toContain('netx');
    expect((await quoteNetx(user, 'netx-quote-0004')).statusCode).toBe(200);
  });

  it('leaves the other switches and the Polygon tokens alone', async () => {
    await pause(admin, false);
    const keys = (await runtime()).stablecoin.tokens.map((t) => t.key);
    expect(keys).toContain('jpyc');
    const status = (await h.app.inject({ method: 'GET', url: '/v1/admin/netx-payments', headers: { ...admin.authHeader, ...freshIp() } })).json();
    expect(status).toMatchObject({ configured: true, accepting: false });
  });

  it('is an administrator’s decision, with a reason, written to the audit log', async () => {
    expect((await pause(support, false)).statusCode).toBe(403);
    expect((await pause(admin, false, 'no')).statusCode).toBe(400);
    expect((await pause(admin, false, 'market price under twenty yen')).statusCode).toBe(200);
    expect((await pause(admin, true, 'market price back above twenty')).statusCode).toBe(200);
    const rows = await query<{ action: string; actor_id: string; reason: string }>(
      `SELECT action, actor_id, reason FROM audit_logs WHERE action LIKE 'payments.netx_%' ORDER BY created_at, id`,
    );
    expect(rows.map((r) => [r.action, r.actor_id, r.reason])).toEqual([
      ['payments.netx_paused', admin.id, 'market price under twenty yen'],
      ['payments.netx_resumed', admin.id, 'market price back above twenty'],
    ]);
  });

  it('stays paused when someone writes the generic feature switches (the generation runbook)', async () => {
    /*
     * docs/OPERATIONS.md §8 pauses generation by PUTting the whole
     * `feature_overrides` object. When the NETX pause lived inside that object,
     * the runbook command erased it and NETX was quoted again at a fixed price
     * below the market, with an audit row that said only "setting.updated".
     */
    const user = await h.createUser({ email: 'netx-runbook@example.test' });
    await linkWallet(user, 56);
    expect((await pause(admin, false)).statusCode).toBe(200);
    const runbook = await h.app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/feature_overrides',
      headers: { ...admin.authHeader, ...freshIp() },
      payload: { value: { generationEnabled: false }, reason: 'provider outage, ref INC-123' } as never,
    });
    expect(runbook.statusCode, runbook.body).toBe(200);
    expect((await runtime()).stablecoin.tokens.map((t) => t.key)).not.toContain('netx');
    expect((await quoteNetx(user, 'netx-quote-0005')).statusCode).toBe(503);
    const status = (await h.app.inject({ method: 'GET', url: '/v1/admin/netx-payments', headers: { ...admin.authHeader, ...freshIp() } })).json();
    expect(status).toMatchObject({ accepting: false });
  });
});

describe('switching NETX on', () => {
  const base = {
    DATABASE_URL: 'mysql://u:p@localhost:3306/x',
    RUN_MODE: 'integration',
    DEV_AUTH_SECRET: 'x',
    STORAGE_SIGNING_SECRET: 'y',
  };
  it('needs two BNB Smart Chain nodes, and two different ones', () => {
    const { BSC_RPC_PRIMARY_URL: _a, BSC_RPC_SECONDARY_URL: _b, ...noBsc } = NETX_ENV;
    expect(() => loadConfig({ ...base, ...noBsc } as never)).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, ...NETX_ENV, BSC_RPC_SECONDARY_URL: NETX_ENV.BSC_RPC_PRIMARY_URL } as never),
    ).toThrow(/BNB Smart Chain|BSC/);
    expect(() => loadConfig({ ...base, ...NETX_ENV } as never)).not.toThrow();
  });

  it('refuses BNB Smart Chain as the Polygon chain id', () => {
    expect(() => loadConfig({ ...base, ...NETX_ENV, STABLECOIN_CHAIN_ID: '56' } as never)).toThrow(/STABLECOIN_CHAIN_ID/);
  });

  it('runs NETX alone without Polygon nodes, and still wants them for JPYC', () => {
    const { POLYGON_RPC_PRIMARY_URL: _p, POLYGON_RPC_SECONDARY_URL: _s, STABLECOIN_JPYC_ENABLED: _j, ...netxOnly } = NETX_ENV;
    expect(() => loadConfig({ ...base, ...netxOnly } as never)).not.toThrow();
    expect(() => loadConfig({ ...base, ...netxOnly, STABLECOIN_JPYC_ENABLED: 'true' } as never)).toThrow(/POLYGON_RPC/);
  });
});
