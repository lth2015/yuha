/**
 * From an observed transfer to a paid order, exactly once.
 *
 * This is where §15's acceptance cases are actually verified: a repeated
 * submission, a repeated log, two workers at once and a restart replay all
 * have to hand over one entitlement and no more. The chain evidence is
 * constructed directly, because the dual reader's agreement is tested
 * separately — mixing the two would make this file a test of a fake RPC.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { query } from '@yuha/db';
import { encodeTransferCalldata, type ChainObservation } from '@yuha/providers';
import { fulfilStablecoinOrder, settleStablecoinObservation } from '../apps/api/src/services/stablecoin-settle.js';
import { balanceOf, createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `192.0.2.${(callNo++ % 200) + 10}` });

const RECEIVER = '0x9999999999999999999999999999999999999999';
const JPYC = '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29';
const AMOUNT = 980n * 10n ** 18n;
const accountA = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PAYER = accountA.address.toLowerCase();

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
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await teardown();
});

async function quotedOrder(email: string): Promise<{ user: TestUser; orderId: string }> {
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
    payload: { priceKey: 'drop_5', idempotencyKey: `settle-${email}`, tokenKey: 'jpyc', payer: accountA.address } as never,
  });
  expect(q.statusCode).toBe(200);
  return { user, orderId: q.json().orderId as string };
}

function observe(over: { amount?: bigint; hash?: string; logIndex?: number; finalized?: bigint; blockMs?: number } = {}): ChainObservation {
  const amount = over.amount ?? AMOUNT;
  const hash = over.hash ?? '0xaa';
  const logIndex = over.logIndex ?? 2;
  return {
    transaction: {
      hash,
      chainId: 137,
      from: PAYER,
      to: JPYC,
      value: 0n,
      input: encodeTransferCalldata(RECEIVER, amount),
      nonce: 11,
      blockNumber: 500n,
      blockHash: '0xbb',
    },
    receipt: { status: 1, blockNumber: 500n, blockHash: '0xbb' },
    transferLogs: [{ token: JPYC, from: PAYER, to: RECEIVER, value: amount, logIndex, blockNumber: 500n }],
    block: { number: 500n, hash: '0xbb', timestampMs: over.blockMs ?? Date.now() },
    canonicalBlockHashAtHeight: '0xbb',
    finalizedBlockNumber: over.finalized ?? 600n,
  };
}

describe('a correct, finalized payment', () => {
  it('pays the order and hands over the credits once', async () => {
    const { user, orderId } = await quotedOrder('ok@example.jp');
    const out = await settleStablecoinObservation(h.ctx, observe());
    expect(out).toEqual({ kind: 'fulfilled', orderId });

    const orders = await query<{ status: string; entitlement_granted_at: Date | null }>(
      `SELECT status, entitlement_granted_at FROM orders WHERE id = ?`,
      [orderId],
    );
    expect(orders[0]!.status).toBe('paid');
    expect(orders[0]!.entitlement_granted_at).not.toBeNull();
    expect((await balanceOf(user.id)).available).toBe(5);
  });

  it('closes the intent, freeing the wallet for a next purchase', async () => {
    await quotedOrder('closed@example.jp');
    await settleStablecoinObservation(h.ctx, observe());
    const rows = await query<{ state: string; open_key: string | null }>(
      `SELECT state, open_key FROM stablecoin_intents WHERE payer = ?`,
      [PAYER],
    );
    expect(rows[0]!.state).toBe('confirmed');
    expect(rows[0]!.open_key).toBeNull();
  });
});

describe('seeing the same payment again', () => {
  it('is the normal case, and grants nothing extra', async () => {
    // The scanner re-reads overlapping block ranges on every pass, so this
    // happens constantly. It must not pay an order twice.
    const { user } = await quotedOrder('again@example.jp');
    expect((await settleStablecoinObservation(h.ctx, observe())).kind).toBe('fulfilled');
    const second = await settleStablecoinObservation(h.ctx, observe());
    expect(second.kind).toBe('already_settled');
    expect((await balanceOf(user.id)).available).toBe(5);
  });

  it('holds when two workers settle it at the same moment', async () => {
    const { user } = await quotedOrder('race@example.jp');
    const results = await Promise.allSettled([
      settleStablecoinObservation(h.ctx, observe()),
      settleStablecoinObservation(h.ctx, observe()),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect((await balanceOf(user.id)).available).toBe(5);
  });

  it('records the evidence exactly once', async () => {
    await quotedOrder('evidence@example.jp');
    await settleStablecoinObservation(h.ctx, observe());
    await settleStablecoinObservation(h.ctx, observe());
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chain_transfer_events WHERE tx_hash = '0xaa'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe('a payment that is not quite right', () => {
  it('waits while the block is not finalized, and grants nothing', async () => {
    const { user } = await quotedOrder('waiting@example.jp');
    const out = await settleStablecoinObservation(h.ctx, observe({ finalized: 499n }));
    expect(out.kind).toBe('waiting');
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('sends a short payment to review, leaves the order unpaid, keeps the record', async () => {
    const { user, orderId } = await quotedOrder('short@example.jp');
    const out = await settleStablecoinObservation(h.ctx, observe({ amount: AMOUNT - 1n }));
    expect(out.kind).toBe('review');

    const orders = await query<{ status: string }>(`SELECT status FROM orders WHERE id = ?`, [orderId]);
    expect(orders[0]!.status).toBe('pending');
    expect((await balanceOf(user.id)).available).toBe(0);
    // The money is still on the record even though nothing was delivered.
    const ev = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM chain_transfer_events`);
    expect(Number(ev[0]!.n)).toBe(1);
  });

  it('leaves the intent open after a rejected transaction', async () => {
    // A failed transaction is not this order's payment; closing the slot
    // would strand a customer who is still about to pay properly.
    await quotedOrder('failed@example.jp');
    const obs = observe();
    obs.receipt = { status: 0, blockNumber: 500n, blockHash: '0xbb' };
    const out = await settleStablecoinObservation(h.ctx, obs);
    expect(out.kind).toBe('rejected');

    const rows = await query<{ open_key: string | null }>(
      `SELECT open_key FROM stablecoin_intents WHERE payer = ?`,
      [PAYER],
    );
    expect(rows[0]!.open_key).not.toBeNull();
  });

  it('records the attempt even when it refuses it', async () => {
    await quotedOrder('attempt@example.jp');
    const obs = observe();
    obs.receipt = { status: 0, blockNumber: 500n, blockHash: '0xbb' };
    await settleStablecoinObservation(h.ctx, obs);
    const rows = await query<{ verdict: string }>(`SELECT verdict FROM stablecoin_attempts WHERE tx_hash = '0xaa'`);
    expect(rows[0]!.verdict).toBe('receipt_failed');
  });
});

describe('money from a wallet with nothing open', () => {
  it('is written down with no intent, not dropped', async () => {
    // A late payment on a cancelled quote, a second payment, or somebody who
    // read the address off a block explorer. None of those should be guessed
    // at, and none should make the row disappear.
    const out = await settleStablecoinObservation(h.ctx, observe());
    expect(out.kind).toBe('unattributed');
    const rows = await query<{ intent_id: string | null }>(`SELECT intent_id FROM chain_transfer_events`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.intent_id).toBeNull();
  });
});

describe('a card payment and an on-chain payment for one order', () => {
  it('delivers once, because exactly-once is on the order id', async () => {
    /*
     * §9's race. Both channels now run the same `grantEntitlementForOrder`,
     * and `entitlement_batches` is unique on (user, source, order id), so the
     * second settlement hands over nothing. The second payment is then a
     * duplicate to refund — not a second delivery.
     */
    const { user, orderId } = await quotedOrder('both@example.jp');
    await settleStablecoinObservation(h.ctx, observe());
    expect((await balanceOf(user.id)).available).toBe(5);

    // Simulate the other channel arriving afterwards and fulfilling again.
    await query(`UPDATE orders SET entitlement_granted_at = NULL WHERE id = ?`, [orderId]);
    await fulfilStablecoinOrder(orderId);
    expect((await balanceOf(user.id)).available).toBe(5);
  });
});

describe('what actually makes delivery exactly-once', () => {
  /*
   * Not the settlement function's own guards — removing those changes nothing
   * about the money, which was established by removing them. The guarantee is
   * `entitlement_batches` unique on (user, source, order id), taken under
   * `lockUserEntitlements`. These two tests go at it directly, because a test
   * that only drives the happy path cannot tell the difference between a
   * guard that works and a guard that is decorative.
   */
  it('grants once when fulfilment is called twice in parallel', async () => {
    const { user, orderId } = await quotedOrder('parallel-grant@example.jp');
    await settleStablecoinObservation(h.ctx, observe());
    // Clear the fast-path flag so both calls get past it and race on the key.
    await query(`UPDATE orders SET entitlement_granted_at = NULL WHERE id = ?`, [orderId]);
    await Promise.allSettled([fulfilStablecoinOrder(orderId), fulfilStablecoinOrder(orderId)]);
    expect((await balanceOf(user.id)).available).toBe(5);
  });

  it('grants once across many replays, the way a crash loop would', async () => {
    const { user, orderId } = await quotedOrder('replay-grant@example.jp');
    await settleStablecoinObservation(h.ctx, observe());
    for (let i = 0; i < 5; i += 1) {
      await query(`UPDATE orders SET entitlement_granted_at = NULL WHERE id = ?`, [orderId]);
      await fulfilStablecoinOrder(orderId);
    }
    expect((await balanceOf(user.id)).available).toBe(5);
    const batches = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM entitlement_batches WHERE user_id = ? AND source_ref = ?`,
      [user.id, orderId],
    );
    expect(Number(batches[0]!.n)).toBe(1);
  });
});

describe('a settlement that stopped halfway', () => {
  it('is finished by the recovery sweep, which does not care how it was paid', async () => {
    // Confirmation and delivery are two transactions on purpose: a crash
    // between them leaves a PAID order with nothing handed over, which is the
    // safe side to fail on. "Safe" only holds if something comes back for it.
    const { user, orderId } = await quotedOrder('halfway@example.jp');
    await settleStablecoinObservation(h.ctx, observe());
    await query(`UPDATE orders SET entitlement_granted_at = NULL WHERE id = ?`, [orderId]);
    await query(
      `DELETE FROM ledger_entries WHERE batch_id IN (SELECT id FROM entitlement_batches WHERE source_ref = ?)`,
      [orderId],
    );
    await query(`DELETE FROM entitlement_batches WHERE source_ref = ?`, [orderId]);
    expect((await balanceOf(user.id)).available).toBe(0);

    const { recoverUngrantedOrders } = await import('@yuha/api');
    await recoverUngrantedOrders(h.ctx);
    expect((await balanceOf(user.id)).available).toBe(5);
  });

});
