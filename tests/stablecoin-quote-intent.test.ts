/**
 * Quoting a payment, and the slot a quote holds in the payer's wallet.
 *
 * The constraint under test is the one the whole no-receiving-contract design
 * rests on: one open intent per wallet per chain. If two were open, a transfer
 * arriving for the right amount would be ambiguous between two orders, and
 * nothing else here could disambiguate it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { query } from '@yuha/db';
import { createStablecoinQuote } from '../apps/api/src/services/stablecoin.js';
import { createHarness, resetData, teardown, type Harness, type TestUser, seedScanCursor, verifiedChainStub } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `198.51.100.${(callNo++ % 200) + 10}` });

const RECEIVER = '0x9999999999999999999999999999999999999999';
const accountA = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const accountB = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');

beforeAll(async () => {
  h = await createHarness({
    STABLECOIN_ENABLED: 'true',
    STABLECOIN_JPYC_ENABLED: 'true',
    STABLECOIN_RECEIVER_ADDRESS: RECEIVER,
    // Two distinct URLs because the configuration requires two, and requires
    // them to differ: one endpoint behind both names would make "hold when
    // the nodes disagree" a line that always passes. Nothing here dials them —
    // quoting and settling read no chain.
    POLYGON_RPC_PRIMARY_URL: 'https://polygon.primary.invalid/rpc/test',
    POLYGON_RPC_SECONDARY_URL: 'https://polygon.secondary.invalid/rpc/test',
  });
  /*
   * The chain reader the quote path now needs.
   *
   * Quoting asks each configured token for its own `decimals()` before
   * computing an amount from the constant in the whitelist — the check that
   * used to exist only in the worker, which neither quotes nor delivers. A
   * real `DualChainReader` over a stub transport means the gate is exercised
   * rather than skipped.
   */
  h.ctx.chain = verifiedChainStub();
});
beforeEach(async () => {
  await resetData();
  /*
   * Quoting refuses when nothing is watching the chain, so a test that quotes
   * has to say where the watcher is. `start_block` used to default to zero,
   * which disabled the only bound on how OLD a satisfying transfer may be —
   * any historical transfer from a verified wallet could settle a brand-new
   * quote. This is that default becoming explicit.
   */
  await seedScanCursor(1n);
});
afterAll(async () => {
  await teardown();
});

/** Links a wallet to an account the way the real flow does. */
async function linkWallet(user: TestUser, account: typeof accountA): Promise<string> {
  const ch = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-challenge',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { address: account.address, chainId: 137 } as never,
  });
  expect(ch.statusCode).toBe(200);
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

const prepare = (user: TestUser, orderId: string) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/orders/${orderId}/stablecoin-prepare`,
    headers: { ...user.authHeader, ...freshIp() },
  });

describe('a JPYC quote', () => {
  it('prices 980 JPY as exactly 980 JPYC in atomic units, as a string', async () => {
    const user = await h.createUser({ email: 'q1@example.jp' });
    const payer = await linkWallet(user, accountA);
    const res = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'idem-0001', tokenKey: 'jpyc', payer });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // A string, not a number: 980 * 10^18 is past Number.MAX_SAFE_INTEGER.
    expect(body.amountAtomic).toBe('980000000000000000000');
    expect(typeof body.amountAtomic).toBe('string');
    expect(body.priceJpy).toBe(980);
    expect(body.roundedUp).toBe(false);
  });

  it('marks the order as paid by stablecoin and opens one intent', async () => {
    const user = await h.createUser({ email: 'q2@example.jp' });
    const payer = await linkWallet(user, accountA);
    const res = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'idem-0002', tokenKey: 'jpyc', payer });
    const { orderId } = res.json();

    const orders = await query<{ payment_method: string }>(`SELECT payment_method FROM orders WHERE id = ?`, [orderId]);
    expect(orders[0]!.payment_method).toBe('stablecoin');
    const intents = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stablecoin_intents WHERE order_id = ? AND open_key IS NOT NULL`,
      [orderId],
    );
    expect(Number(intents[0]!.n)).toBe(1);
  });

  it('will not quote for a wallet that never proved control', async () => {
    const user = await h.createUser({ email: 'q3@example.jp' });
    const res = await quote(user, {
      priceKey: 'drop_5',
      idempotencyKey: 'idem-0003',
      tokenKey: 'jpyc',
      payer: accountB.address,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('will not quote a subscription', async () => {
    const user = await h.createUser({ email: 'q4@example.jp' });
    const payer = await linkWallet(user, accountA);
    const res = await quote(user, { priceKey: 'pro_monthly', idempotencyKey: 'idem-0004', tokenKey: 'jpyc', payer });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses USDC, which has no rate source yet', async () => {
    const user = await h.createUser({ email: 'q5@example.jp' });
    const payer = await linkWallet(user, accountA);
    const res = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'idem-0005', tokenKey: 'usdc', payer });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('one open payment per wallet', () => {
  it('refuses a second order while one is waiting', async () => {
    const user = await h.createUser({ email: 'one@example.jp' });
    const payer = await linkWallet(user, accountA);
    expect((await quote(user, { priceKey: 'drop_5', idempotencyKey: 'wait-one-001', tokenKey: 'jpyc', payer })).statusCode).toBe(
      200,
    );
    const second = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'wait-one-002', tokenKey: 'jpyc', payer });
    expect(second.statusCode).toBe(409);
  });

  it('lets the same order be re-quoted, superseding the old price', async () => {
    const user = await h.createUser({ email: 'requote@example.jp' });
    const payer = await linkWallet(user, accountA);
    const first = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'requote-001', tokenKey: 'jpyc', payer });
    const again = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'requote-001', tokenKey: 'jpyc', payer });
    expect(again.statusCode).toBe(200);
    expect(again.json().orderId).toBe(first.json().orderId);
    expect(again.json().quoteId).not.toBe(first.json().quoteId);

    // Both quotes kept — a superseded price is part of what the customer was
    // shown — and exactly one intent still holds the wallet's slot.
    const quotes = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM stablecoin_quotes WHERE order_id = ?`, [
      first.json().orderId,
    ]);
    expect(Number(quotes[0]!.n)).toBe(2);
    const open = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stablecoin_intents WHERE open_key IS NOT NULL AND payer = ?`,
      [payer.toLowerCase()],
    );
    expect(Number(open[0]!.n)).toBe(1);
  });

  it('frees the slot once the intent is closed', async () => {
    const user = await h.createUser({ email: 'freed@example.jp' });
    const payer = await linkWallet(user, accountA);
    await quote(user, { priceKey: 'drop_5', idempotencyKey: 'freed-001', tokenKey: 'jpyc', payer });
    await query(`UPDATE stablecoin_intents SET state = 'cancelled', open_key = NULL WHERE payer = ?`, [
      payer.toLowerCase(),
    ]);
    const next = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'freed-002', tokenKey: 'jpyc', payer });
    expect(next.statusCode).toBe(200);
  });

  it('is per wallet, so a second wallet is not blocked by the first', async () => {
    const user = await h.createUser({ email: 'twowallets@example.jp' });
    const a = await linkWallet(user, accountA);
    const b = await linkWallet(user, accountB);
    expect((await quote(user, { priceKey: 'drop_5', idempotencyKey: 'twowallet-001', tokenKey: 'jpyc', payer: a })).statusCode).toBe(200);
    expect((await quote(user, { priceKey: 'drop_5', idempotencyKey: 'twowallet-002', tokenKey: 'jpyc', payer: b })).statusCode).toBe(200);
  });
});

describe('the prepared transfer', () => {
  it('is calldata the wallet can check, built from the stored quote', async () => {
    const user = await h.createUser({ email: 'prep@example.jp' });
    const payer = await linkWallet(user, accountA);
    const q = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'prepared-001', tokenKey: 'jpyc', payer });
    const res = await prepare(user, q.json().orderId);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // transfer(address,uint256): selector + receiver + amount, nothing else.
    expect(body.data.slice(0, 10)).toBe('0xa9059cbb');
    expect(body.data.length).toBe(2 + 8 + 64 + 64);
    expect(body.data.slice(34, 74)).toBe(RECEIVER.slice(2).toLowerCase());
    expect(BigInt('0x' + body.data.slice(74))).toBe(980n * 10n ** 18n);
    // The transaction goes to the token contract; the receiver is inside it.
    expect(body.to.toLowerCase()).toBe('0xe7c3d8c9a439fede00d2600032d5db0be71c3c29');
    expect(body.value).toBe('0');
    // Null, and honestly so: a nonce in someone else's wallet is predicted,
    // not reserved, and there is no RPC to predict with yet.
    expect(body.predictedNonce).toBeNull();
  });

  it('refuses an expired quote instead of handing out stale calldata', async () => {
    const user = await h.createUser({ email: 'expired@example.jp' });
    const payer = await linkWallet(user, accountA);
    const q = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'expired-001', tokenKey: 'jpyc', payer });
    await query(`UPDATE stablecoin_quotes SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?`, [
      q.json().quoteId,
    ]);
    const res = await prepare(user, q.json().orderId);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('is not somebody else’s to prepare', async () => {
    const owner = await h.createUser({ email: 'owner@example.jp' });
    const stranger = await h.createUser({ email: 'stranger@example.jp' });
    const payer = await linkWallet(owner, accountA);
    const q = await quote(owner, { priceKey: 'drop_5', idempotencyKey: 'owner-001', tokenKey: 'jpyc', payer });
    const res = await prepare(stranger, q.json().orderId);
    expect(res.statusCode).toBe(404);
  });
});

describe('one live payment slot per ORDER, not only per wallet', () => {
  it('supersedes the first wallet’s slot when the same order is quoted from a second', async () => {
    /*
     * The rule was enforced per wallet only. A customer with two verified
     * wallets could quote the SAME order twice and hold two live slots, and
     * paying both took both payments: the first settled, and the second found
     * an order it could not move — which, before the settle path was fixed,
     * reported success and appeared in no operator queue at all. Reproduced by
     * an independent review with no attacker and no unusual timing.
     *
     * Migration 0016 makes two open intents for one order impossible in the
     * database. This is the behaviour that keeps a legitimate re-quote from a
     * second wallet working: the first slot is superseded, not duplicated.
     */
    const user = await h.createUser({ email: 'two-wallets@example.jp' });
    await linkWallet(user, accountA);
    await linkWallet(user, accountB);

    const first = await quote(user, {
      priceKey: 'drop_5',
      idempotencyKey: 'two-wallets-0001',
      tokenKey: 'jpyc',
      payer: accountA.address,
    });
    expect(first.statusCode).toBe(200);
    const orderId = first.json().orderId as string;

    const second = await quote(user, {
      priceKey: 'drop_5',
      idempotencyKey: 'two-wallets-0001',
      tokenKey: 'jpyc',
      payer: accountB.address,
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().orderId).toBe(orderId);

    const open = await query<{ payer: string; state: string }>(
      `SELECT payer, state FROM stablecoin_intents WHERE order_id = ? AND order_open_key IS NOT NULL`,
      [orderId],
    );
    expect(open).toHaveLength(1);
    expect(open[0]!.payer).toBe(accountB.address.toLowerCase());

    // The first wallet's slot is free again, rather than still held.
    const closed = await query<{ state: string }>(
      `SELECT state FROM stablecoin_intents WHERE order_id = ? AND payer = ?`,
      [orderId, accountA.address.toLowerCase()],
    );
    expect(closed[0]!.state).toBe('cancelled');
  });
});

describe('an order that can no longer be paid', () => {
  it('is not handed live transfer calldata', async () => {
    /*
     * `prepare` refused only `paid`. An order refunded after its quote was
     * issued still gave the wallet calldata to send money with, and the
     * payment that followed landed on an order `markOrderPaid` will not
     * accept — the feeder for the invisible-review defect.
     */
    const user = await h.createUser({ email: 'prep-refunded@example.jp' });
    await linkWallet(user, accountA);
    const q = await quote(user, {
      priceKey: 'drop_5',
      idempotencyKey: 'prep-refunded-0001',
      tokenKey: 'jpyc',
      payer: accountA.address,
    });
    const orderId = q.json().orderId as string;
    await query(`UPDATE orders SET status = 'refunded' WHERE id = ?`, [orderId]);

    const res = await prepare(user, orderId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/no longer be paid/);
  });
});

describe('one channel per order', () => {
  it('refuses a card checkout for an order already in stablecoin', async () => {
    const user = await h.createUser({ email: 'channel@example.jp' });
    const payer = await linkWallet(user, accountA);
    await quote(user, { priceKey: 'drop_5', idempotencyKey: 'shared-key-1', tokenKey: 'jpyc', payer });

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: { ...user.authHeader, ...freshIp() },
      payload: { priceKey: 'drop_5', idempotencyKey: 'shared-key-1' } as never,
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a stablecoin quote for an order already in card checkout', async () => {
    const user = await h.createUser({ email: 'channel2@example.jp' });
    const payer = await linkWallet(user, accountA);
    const card = await h.app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: { ...user.authHeader, ...freshIp() },
      payload: { priceKey: 'drop_5', idempotencyKey: 'shared-key-2' } as never,
    });
    expect(card.statusCode).toBe(200);

    const res = await quote(user, { priceKey: 'drop_5', idempotencyKey: 'shared-key-2', tokenKey: 'jpyc', payer });
    expect(res.statusCode).toBe(409);
  });
});

describe('with the switches off', () => {
  it('answers that the feature is unavailable, which is the default', async () => {
    // A separate server with default configuration: every switch off is the
    // state this ships in, and it has to be the state that refuses.
    const off = await createHarness();
    try {
      const user = await off.createUser({ email: 'off@example.jp' });
      const res = await off.app.inject({
        method: 'POST',
        url: '/v1/payments/stablecoin/quote',
        headers: { ...user.authHeader, ...freshIp() },
        payload: {
          priceKey: 'drop_5',
          idempotencyKey: 'switches-off-001',
          tokenKey: 'jpyc',
          payer: accountA.address,
        } as never,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.json())).toMatch(/not available/i);
    } finally {
      await off.close();
    }
  });
});

describe('called as a function, past the route schema', () => {
  /*
   * The route's zod enum already refuses anything but drop_5 and
   * market_license, so the service's own product check is unreachable over
   * HTTP — removing it broke no test, which was checked by doing it. It is
   * tested here because the service is what a future internal caller, or a
   * second route, would go through, and a subscription quoted in JPYC would
   * grant a month of credits for a one-off payment with no renewal behind it.
   */
  it('refuses a subscription even when nothing upstream filtered it', async () => {
    const user = await h.createUser({ email: 'sub-direct@example.jp' });
    const payer = await linkWallet(user, accountA);
    await expect(
      createStablecoinQuote(h.ctx, {
        userId: user.id,
        priceKey: 'pro_monthly',
        idempotencyKey: 'direct-sub-001',
        tokenKey: 'jpyc',
        payer,
      }),
    ).rejects.toThrow(/cannot be paid for in stablecoin/i);
  });
});
