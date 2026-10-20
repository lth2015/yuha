/**
 * Quoting in USDC: the JPY list price at USD/JPY, plus the buffer, from two
 * live sources that must agree — or no quote at all.
 *
 * USDC is priced as one US dollar (product decision, 2026-10-20). The rate
 * sources are faked through `ctx.fx`, because the cases that matter here — a
 * source down, a stale reference, the two disagreeing — cannot be arranged
 * against the real feeds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { query } from '@yuha/db';
import { parseDecimalRate, type RateObservation } from '@yuha/providers';
import { createHarness, resetData, teardown, type Harness, type TestUser, seedScanCursor, verifiedChainStub } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `198.51.100.${(callNo++ % 200) + 10}` });
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

const DAY = 86_400_000;
const obs = (text: string, provider: string, extra: Partial<RateObservation> = {}): RateObservation => ({
  rate: parseDecimalRate(text),
  provider,
  observedAtMs: Date.now(),
  ...extra,
});
/** Both sources healthy and in agreement, as on 2026-10-20 (158.0465 vs 158.16). */
const healthy = {
  primary: async () => obs('158.0465', 'coinbase-usd-jpy'),
  reference: async () => obs('158.16', 'frankfurter-usd-jpy', { sourceTimestampMs: Date.now() - 6 * 3600_000 }),
};

beforeAll(async () => {
  h = await createHarness({
    STABLECOIN_ENABLED: 'true',
    STABLECOIN_JPYC_ENABLED: 'true',
    STABLECOIN_USDC_ENABLED: 'true',
    STABLECOIN_RECEIVER_ADDRESS: '0x9999999999999999999999999999999999999999',
    POLYGON_RPC_PRIMARY_URL: 'https://polygon.primary.invalid/rpc/test',
    POLYGON_RPC_SECONDARY_URL: 'https://polygon.secondary.invalid/rpc/test',
  });
  h.ctx.chain = verifiedChainStub();
});
beforeEach(async () => {
  await resetData();
  await seedScanCursor(1n);
  h.ctx.fx = { ...healthy };
});
afterAll(async () => {
  await teardown();
});

async function linkWallet(user: TestUser): Promise<string> {
  const ch = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-challenge',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { address: account.address, chainId: 137 } as never,
  });
  const { nonce, message } = ch.json() as { nonce: string; message: string };
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-verify',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { nonce, address: account.address, signature: await account.signMessage({ message }) } as never,
  });
  expect(res.statusCode).toBe(200);
  return account.address;
}

const quote = (user: TestUser, body: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/quote',
    headers: { ...user.authHeader, ...freshIp() },
    payload: body as never,
  });

async function counts(): Promise<{ orders: number; quotes: number }> {
  const [o] = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM orders`);
  const [q] = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM stablecoin_quotes`);
  return { orders: Number(o!.n), quotes: Number(q!.n) };
}

describe('a USDC quote', () => {
  it('prices 980 JPY at the primary USD/JPY rate plus 1%, rounded up to the atomic unit', async () => {
    const user = await h.createUser({ email: 'u1@example.jp' });
    const payer = await linkWallet(user);
    const res = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'usdc-0001', tokenKey: 'usdc', payer });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // ceil(980 * 1.01 / 158.0465 * 10^6), computed independently: 6262713.82…
    expect(body.amountAtomic).toBe('6262714');
    expect(body.tokenDecimals).toBe(6);
    expect(body.roundedUp).toBe(true);
    // The buyer sees how the number was made.
    expect(body.rateText).toBe('158.0465');
    expect(body.rateBufferBps).toBe(100);
  });

  it('records the rate, its source, the buffer and the reference on the quote', async () => {
    const user = await h.createUser({ email: 'u2@example.jp' });
    const payer = await linkWallet(user);
    const res = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'usdc-0002', tokenKey: 'usdc', payer });
    const rows = await query<{
      rate_text: string;
      rate_provider: string;
      rate_buffer_bps: number;
      rate_reference_text: string;
      rate_observed_at: Date | null;
    }>(`SELECT rate_text, rate_provider, rate_buffer_bps, rate_reference_text, rate_observed_at FROM stablecoin_quotes WHERE id = ?`, [
      res.json().quoteId,
    ]);
    expect(rows[0]).toMatchObject({
      rate_text: '158.0465',
      rate_provider: 'coinbase-usd-jpy',
      rate_buffer_bps: 100,
      rate_reference_text: 'frankfurter-usd-jpy=158.16',
    });
    expect(rows[0]!.rate_observed_at).not.toBeNull();
  });

  it('takes the buffer from configuration at quote time', async () => {
    const user = await h.createUser({ email: 'u3@example.jp' });
    const payer = await linkWallet(user);
    const before = h.ctx.config.STABLECOIN_USDC_BUFFER_BPS;
    h.ctx.config.STABLECOIN_USDC_BUFFER_BPS = 0;
    try {
      const res = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'usdc-0003', tokenKey: 'usdc', payer });
      expect(res.json().amountAtomic).toBe('6200707');
      expect(res.json().rateBufferBps).toBe(0);
    } finally {
      h.ctx.config.STABLECOIN_USDC_BUFFER_BPS = before;
    }
  });

  it('never consults a rate for JPYC', async () => {
    h.ctx.fx = {
      primary: async () => {
        throw new Error('JPYC must not read a rate');
      },
      reference: async () => {
        throw new Error('JPYC must not read a rate');
      },
    };
    const user = await h.createUser({ email: 'u4@example.jp' });
    const payer = await linkWallet(user);
    const res = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'usdc-0004', tokenKey: 'jpyc', payer });
    expect(res.statusCode).toBe(200);
    expect(res.json().amountAtomic).toBe('980000000000000000000');
    expect(res.json().rateText).toBeNull();
    expect(res.json().rateBufferBps).toBeNull();
  });

  it('will not quote a subscription in USDC, and says to buy a top-up pack', async () => {
    const user = await h.createUser({ email: 'u5@example.jp' });
    const payer = await linkWallet(user);
    const res = await quote(user, { priceKey: 'pro_monthly', idempotencyKey: 'usdc-0005', tokenKey: 'usdc', payer });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/top-up pack/);
    expect(await counts()).toEqual({ orders: 0, quotes: 0 });
  });
});

describe('a USDC quote is refused, and nothing is written, when the rate cannot be trusted', () => {
  const refusedWith = async (email: string, key: string) => {
    const user = await h.createUser({ email });
    const payer = await linkWallet(user);
    const res = await quote(user, { priceKey: 'drop_5', idempotencyKey: key, tokenKey: 'usdc', payer });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.code).toBe('SERVICE_DISABLED');
    // Refused before the order or the quote exists: no pending order nobody can pay.
    expect(await counts()).toEqual({ orders: 0, quotes: 0 });
    return res.json().error;
  };

  it('when the primary source is down', async () => {
    h.ctx.fx.primary = async () => {
      throw new Error('coinbase answered 503');
    };
    const err = await refusedWith('r1@example.jp', 'usdc-r001');
    expect(err.details).toMatchObject({ reason: 'unconfirmed', primary: 'coinbase answered 503', reference: 'ok' });
  });

  it('when the reference is down — one source is never enough', async () => {
    h.ctx.fx.reference = async () => {
      throw new Error('frankfurter answered 500');
    };
    expect((await refusedWith('r2@example.jp', 'usdc-r002')).details).toMatchObject({ reason: 'unconfirmed' });
  });

  it('when the reference publication is older than the allowed age', async () => {
    h.ctx.fx.reference = async () => obs('158.16', 'frankfurter-usd-jpy', { sourceTimestampMs: Date.now() - 10 * DAY });
    expect((await refusedWith('r3@example.jp', 'usdc-r003')).details).toMatchObject({ reason: 'stale' });
  });

  it('when the two sources disagree by more than the allowed basis points', async () => {
    // 170 vs 158.0465 is about 7.5%, far past the 3% default.
    h.ctx.fx.reference = async () => obs('170', 'frankfurter-usd-jpy', { sourceTimestampMs: Date.now() });
    expect((await refusedWith('r4@example.jp', 'usdc-r004')).details).toMatchObject({ reason: 'divergent' });
  });
});
