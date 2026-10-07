/**
 * What a person can do about a payment the system would not decide alone.
 *
 * Accepting a short payment delivers goods for money that did not match the
 * quote. That is a judgement an operator is allowed to make — a customer who
 * underpaid by a hundredth of a yen should not be stuck — and it is exactly
 * why it is not automatic, needs a reason, and leaves an audit row naming who
 * did it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { query } from '@yuha/db';
import { encodeTransferCalldata, type ChainObservation } from '@yuha/providers';
import { base32Decode } from '../apps/api/src/auth/totp.js';
import { settleStablecoinObservation } from '../apps/api/src/services/stablecoin-settle.js';
import { decideStablecoinReview } from '../apps/api/src/services/stablecoin-admin.js';
import { balanceOf, createHarness, resetData, teardown, type Harness, type TestUser, seedScanCursor, verifiedChainStub } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `203.0.113.${(callNo++ % 200) + 10}` });

const RECEIVER = '0x9999999999999999999999999999999999999999';
const JPYC = '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29';
const AMOUNT = 980n * 10n ** 18n;
const accountA = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PAYER = accountA.address.toLowerCase();

function totpAt(secret: string, atMs: number): string {
  const counter = Math.floor(atMs / 30_000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

beforeAll(async () => {
  h = await createHarness({
    STABLECOIN_ENABLED: 'true',
    STABLECOIN_JPYC_ENABLED: 'true',
    STABLECOIN_RECEIVER_ADDRESS: RECEIVER,
    POLYGON_RPC_PRIMARY_URL: 'https://primary.invalid/rpc',
    POLYGON_RPC_SECONDARY_URL: 'https://secondary.invalid/rpc',
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

/*
 * Emails are short and distinct in their FIRST TWELVE characters.
 *
 * The harness derives a user's external id from `hex(email).slice(0, 24)`,
 * which is twelve characters of the address — so `orphan-role-admin@…` and
 * `orphan-role-support@…` are the same account, and the second enrolment
 * answered "two-factor is already enabled". A test asserting a role boundary
 * between two users that were one user is worse than no test.
 */

/** A staff account that has done what the console now requires of staff. */
async function staffUser(email: string, role: 'support' | 'admin'): Promise<TestUser> {
  const user = await h.createUser({ email, role });
  const enroll = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/enroll',
    headers: { ...user.authHeader, ...freshIp() },
  });
  expect(enroll.statusCode, enroll.body).toBe(200);
  await h.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/confirm',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { code: totpAt(enroll.json().secret as string, Date.now()) } as never,
  });
  return user;
}

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
    payload: { priceKey: 'drop_5', idempotencyKey: `admin-${email}`, tokenKey: 'jpyc', payer: accountA.address } as never,
  });
  expect(q.statusCode).toBe(200);
  return { user, orderId: q.json().orderId as string };
}

function observe(amount: bigint, hash = '0xaa'): ChainObservation {
  return {
    transaction: {
      hash, chainId: 137, from: PAYER, to: JPYC, value: 0n,
      input: encodeTransferCalldata(RECEIVER, amount), nonce: 11,
      blockNumber: 500n, blockHash: '0xbb',
    },
    receipt: { status: 1, blockNumber: 500n, blockHash: '0xbb' },
    transferLogs: [{ token: JPYC, from: PAYER, to: RECEIVER, value: amount, logIndex: 2, blockNumber: 500n }],
    block: { number: 500n, hash: '0xbb', timestampMs: Date.now() },
    canonicalBlockHashAtHeight: '0xbb',
    finalizedBlockNumber: 600n,
  };
}

const queue = (user: TestUser) =>
  h.app.inject({ method: 'GET', url: '/v1/admin/stablecoin-payments', headers: { ...user.authHeader, ...freshIp() } });

const decide = (user: TestUser, intentId: string, body: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/admin/stablecoin-payments/${intentId}/review`,
    headers: { ...user.authHeader, ...freshIp() },
    payload: body as never,
  });

async function shortPaymentInReview(email: string) {
  const { user, orderId } = await quoted(email);
  const out = await settleStablecoinObservation(h.ctx, observe(AMOUNT - 1n));
  expect(out.kind).toBe('review');
  const rows = await query<{ id: string }>(`SELECT id FROM stablecoin_intents WHERE order_id = ?`, [orderId]);
  return { user, orderId, intentId: rows[0]!.id };
}

describe('the review queue', () => {
  it('shows what was asked for beside what arrived', async () => {
    await shortPaymentInReview('q-short@example.jp');
    const staff = await staffUser('q-staff@example.jp', 'support');
    const res = await queue(staff);
    expect(res.statusCode).toBe(200);
    const item = res.json().payments[0];
    expect(item.expected_atomic).toBe(AMOUNT.toString());
    expect(item.received_atomic).toBe((AMOUNT - 1n).toString());
    expect(item.order_status).toBe('pending');
  });

  it('lists money that arrived with nothing to attach it to', async () => {
    // No quote at all: somebody read the address off a block explorer.
    await settleStablecoinObservation(h.ctx, observe(AMOUNT, '0xcc'));
    const staff = await staffUser('q-orphan@example.jp', 'support');
    const res = await queue(staff);
    expect(res.json().unattributed).toHaveLength(1);
    expect(res.json().unattributed[0].amountAtomic).toBe(AMOUNT.toString());
  });

  it('is not open to customers', async () => {
    const user = await h.createUser({ email: 'q-nosy@example.jp' });
    expect((await queue(user)).statusCode).toBe(403);
  });
});

describe('deciding', () => {
  it('accepting a short payment delivers, once, and leaves an audit row', async () => {
    const { user, orderId, intentId } = await shortPaymentInReview('d-accept@example.jp');
    const admin = await staffUser('d-admin@example.jp', 'admin');

    const res = await decide(admin, intentId, { decision: 'accept_as_paid', reason: '0.000000000000000001 short; goodwill' });
    expect(res.statusCode).toBe(200);
    expect((await balanceOf(user.id)).available).toBe(5);

    const orders = await query<{ status: string }>(`SELECT status FROM orders WHERE id = ?`, [orderId]);
    expect(orders[0]!.status).toBe('paid');

    const audit = await query<{ action: string; reason: string; actor_id: string }>(
      `SELECT action, reason, actor_id FROM audit_logs WHERE subject_id = ?`,
      [intentId],
    );
    expect(audit[0]!.action).toBe('stablecoin_payment.accept_as_paid');
    expect(audit[0]!.actor_id).toBe(admin.id);
    expect(audit[0]!.reason).toMatch(/goodwill/);
  });

  it('refuses a decision with no reason, because the audit row is the point', async () => {
    const { intentId } = await shortPaymentInReview('d-noreason@example.jp');
    const admin = await staffUser('d-admin2@example.jp', 'admin');
    const res = await decide(admin, intentId, { decision: 'accept_as_paid', reason: '  ' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('cannot be done twice, so a double click does not grant twice', async () => {
    const { user, intentId } = await shortPaymentInReview('d-twice@example.jp');
    const admin = await staffUser('d-admin3@example.jp', 'admin');
    expect((await decide(admin, intentId, { decision: 'accept_as_paid', reason: 'first' })).statusCode).toBe(200);
    const again = await decide(admin, intentId, { decision: 'accept_as_paid', reason: 'second' });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
    expect((await balanceOf(user.id)).available).toBe(5);
  });

  it('rejecting delivers nothing and leaves the order unpaid', async () => {
    const { user, orderId, intentId } = await shortPaymentInReview('d-reject@example.jp');
    const admin = await staffUser('d-admin4@example.jp', 'admin');
    expect((await decide(admin, intentId, { decision: 'reject', reason: 'refunding instead' })).statusCode).toBe(200);
    expect((await balanceOf(user.id)).available).toBe(0);
    const orders = await query<{ status: string }>(`SELECT status FROM orders WHERE id = ?`, [orderId]);
    expect(orders[0]!.status).toBe('pending');
    // And the evidence is still there: a rejected payment is still money that
    // arrived, and it does not disappear from the record.
    const ev = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM chain_transfer_events`);
    expect(Number(ev[0]!.n)).toBe(1);
  });

  it('is not something support can do', async () => {
    // Reading what arrived and deciding a disputed payment are different
    // authorities.
    const { intentId } = await shortPaymentInReview('d-support@example.jp');
    const support = await staffUser('d-support-user@example.jp', 'support');
    expect((await decide(support, intentId, { decision: 'accept_as_paid', reason: 'nope' })).statusCode).toBe(403);
  });
});

describe('money an operator has to attach by hand', () => {
  /*
   * The repair path the design was missing.
   *
   * The unattributed queue existed and nothing could act on it:
   * `decideStablecoinReview` only matched intents already in state `review`,
   * so a payment that arrived with nothing open — after its quote expired,
   * in the wrong currency, or straight off a block explorer — had no action
   * anywhere in the product. An independent review reached that state three
   * different ways without an attacker, and each one was a customer's money
   * sitting in the wallet with SQL by hand as the only remedy.
   */
  const transfers = (user: TestUser) =>
    h.app.inject({ method: 'GET', url: '/v1/admin/stablecoin-payments', headers: { ...user.authHeader, ...freshIp() } });

  const decideTransfer = (user: TestUser, id: string, body: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: `/v1/admin/stablecoin-transfers/${id}/decide`,
      headers: { ...user.authHeader, ...freshIp() },
      payload: body as never,
    });

  it('is listed with an id, and attaching it delivers what the order bought', async () => {
    // The payment arrives before there is anything to attribute it to.
    const first = await settleStablecoinObservation(h.ctx, observe(AMOUNT));
    expect(first.kind).toBe('unattributed');

    // The customer then quotes — the ordinary "I paid, where is it" sequence.
    const { user, orderId } = await quoted('oatt-user@example.jp');
    const admin = await staffUser('oatt-admin@example.jp', 'admin');

    const listed = await transfers(admin);
    expect(listed.statusCode).toBe(200);
    const row = listed.json().unattributed[0];
    expect(row.id).toBeTruthy();
    expect(row.amountAtomic).toBe(AMOUNT.toString());
    expect(row.reason).toBe('no_open_intent');

    const res = await decideTransfer(admin, row.id as string, {
      decision: 'attach_to_order',
      orderId,
      reason: 'customer paid before quoting; hash matches the wallet on file',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().orderId).toBe(orderId);

    const orders = await query<{ status: string; granted: Date | null }>(
      `SELECT status, entitlement_granted_at AS granted FROM orders WHERE id = ?`,
      [orderId],
    );
    expect(orders[0]!.status).toBe('paid');
    expect(orders[0]!.granted).not.toBeNull();
    expect((await balanceOf(user.id)).available).toBe(5);

    // And it leaves the queue, with who did it and why on the audit row.
    expect((await transfers(admin)).json().unattributed).toHaveLength(0);
    const audit = await query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit_logs WHERE subject_type = 'stablecoin_orphan_transfer'`,
    );
    expect(audit[0]!.action).toBe('stablecoin_orphan.attach_to_order');
    expect(audit[0]!.reason).toMatch(/before quoting/);
  });

  it('cannot be attached twice, because the anti-replay key is still the anti-replay key', async () => {
    await settleStablecoinObservation(h.ctx, observe(AMOUNT));
    const { user, orderId } = await quoted('otw-a@example.jp');
    const admin = await staffUser('otw-admin@example.jp', 'admin');
    const id = (await transfers(admin)).json().unattributed[0].id as string;

    const firstAttach = await decideTransfer(admin, id, {
      decision: 'attach_to_order',
      orderId,
      reason: 'first attachment',
    });
    expect(firstAttach.statusCode, firstAttach.body).toBe(200);

    /*
     * A second order for the SAME customer, because a wallet belongs to one
     * account — which is itself load-bearing — and the slot is free again now
     * that the first attachment confirmed its intent.
     */
    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/payments/stablecoin/quote',
      headers: { ...user.authHeader, ...freshIp() },
      payload: { priceKey: 'drop_5', idempotencyKey: 'otw-second', tokenKey: 'jpyc', payer: accountA.address } as never,
    });
    expect(second.statusCode, second.body).toBe(200);
    const other = second.json().orderId as string;

    const again = await decideTransfer(admin, id, {
      decision: 'attach_to_order',
      orderId: other,
      reason: 'trying to spend it again',
    });
    expect(again.statusCode).toBe(409);
    const orders = await query<{ status: string }>(`SELECT status FROM orders WHERE id = ?`, [other]);
    expect(orders[0]!.status).toBe('pending');
    // And the customer was credited exactly once for the one real payment.
    expect((await balanceOf(user.id)).available).toBe(5);
  });

  it('refuses to attach money in a different currency, which is a refund question', async () => {
    const usdc = observe(AMOUNT);
    usdc.transaction.to = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
    usdc.transferLogs = [
      { token: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', from: PAYER, to: RECEIVER, value: AMOUNT, logIndex: 2, blockNumber: 500n },
    ];
    expect((await settleStablecoinObservation(h.ctx, usdc)).kind).toBe('unattributed');

    const { orderId } = await quoted('ousdc-user@example.jp');
    const admin = await staffUser('ousdc-adm@example.jp', 'admin');
    const id = (await transfers(admin)).json().unattributed[0].id as string;
    const res = await decideTransfer(admin, id, {
      decision: 'attach_to_order',
      orderId,
      reason: 'looks like the same customer',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/different currency/);
  });

  it('can be written off instead, with a reason', async () => {
    await settleStablecoinObservation(h.ctx, observe(AMOUNT));
    const admin = await staffUser('odis-admin@example.jp', 'admin');
    const id = (await transfers(admin)).json().unattributed[0].id as string;
    expect(
      (await decideTransfer(admin, id, { decision: 'dismiss', reason: 'dust from an unknown wallet' })).statusCode,
    ).toBe(200);
    expect((await transfers(admin)).json().unattributed).toHaveLength(0);
  });

  it('needs a reason, and needs an order to attach to', async () => {
    await settleStablecoinObservation(h.ctx, observe(AMOUNT));
    const admin = await staffUser('oarg-admin@example.jp', 'admin');
    const id = (await transfers(admin)).json().unattributed[0].id as string;
    expect((await decideTransfer(admin, id, { decision: 'dismiss', reason: '' })).statusCode).toBe(400);
    expect((await decideTransfer(admin, id, { decision: 'attach_to_order', reason: 'no order given' })).statusCode).toBe(
      400,
    );
  });

  it('is admin-only, like every other decision about money', async () => {
    await settleStablecoinObservation(h.ctx, observe(AMOUNT));
    const admin = await staffUser('orole-adm@example.jp', 'admin');
    const support = await staffUser('orole-sup@example.jp', 'support');
    const id = (await transfers(admin)).json().unattributed[0].id as string;
    expect((await decideTransfer(support, id, { decision: 'dismiss', reason: 'support should not decide' })).statusCode).toBe(
      403,
    );
  });
});

describe('a review decision that cannot move the order', () => {
  it('is refused rather than reported as accepted', async () => {
    /*
     * The same defect the settle path was fixed for one round earlier, in the
     * console copy that was missed: `markOrderPaid` matches only
     * pending/failed/canceled, and its `changed` was discarded here. Accepting
     * a payment on a refunded order moved nothing, delivered nothing, told the
     * operator it had been accepted, and took the item out of the only queue
     * that would have brought it back.
     */
    const { user, orderId, intentId } = await shortPaymentInReview('dref-user@example.jp');
    await query(`UPDATE orders SET status = 'refunded' WHERE id = ?`, [orderId]);
    const admin = await staffUser('dref-adm@example.jp', 'admin');

    const res = await decide(admin, intentId, { decision: 'accept_as_paid', reason: 'customer says they paid' });
    expect(res.statusCode).toBe(409);
    expect((await balanceOf(user.id)).available).toBe(0);

    // Still in review: the transaction rolled back, so it is still in front
    // of a person rather than silently resolved.
    const rows = await query<{ state: string }>(`SELECT state FROM stablecoin_intents WHERE id = ?`, [intentId]);
    expect(rows[0]!.state).toBe('review');
    expect((await queue(admin)).json().payments).toHaveLength(1);
  });

  it('records a refund as owed when a payment is rejected', async () => {
    /*
     * Rejecting changed a state and nothing else: the evidence kept its
     * intent, so it was not unattributed, and the state was no longer
     * 'review', so it was not in the queue. The money left every list with
     * nothing saying it was owed. Stablecoin refunds are deliberately manual,
     * which is exactly why the obligation has to be recorded.
     */
    const { intentId } = await shortPaymentInReview('drej-user@example.jp');
    const admin = await staffUser('drej-adm@example.jp', 'admin');
    expect((await decide(admin, intentId, { decision: 'reject', reason: 'not our payment' })).statusCode).toBe(200);

    const owed = (await queue(admin)).json().refundsOwed;
    expect(owed).toHaveLength(1);
    expect(owed[0].amountAtomic).toBe((AMOUNT - 1n).toString());
  });
});

describe('finding the payment a decision is about', () => {
  it('does not depend on it being inside a page of the queue', async () => {
    /*
     * `decideStablecoinReview` found its subject with
     * `listStablecoinReviews(500).find(...)` over a list ordered
     * oldest-first — so past five hundred payments in review, a decision about
     * real money answered NOT_FOUND for a payment plainly there, and the
     * console listed a hundred, so the two disagreed about what existed. A
     * page of zero is the cheap way to say the same thing.
     */
    /*
     * A hundred older payments in review, and ours after them. The console
     * lists a hundred by default, so a decision path that searches a page of
     * the queue cannot see the hundred-and-first — which is a decision about
     * real money answering NOT_FOUND. Rows are inserted directly because what
     * is under test is the lookup, not how they got there.
     */
    const filler = await h.createUser({ email: 'byid-filler@example.jp' });
    for (let i = 0; i < 100; i += 1) {
      await query(
        `INSERT INTO orders (id, user_id, price_key, price_version, kind, amount_minor, currency,
                             idempotency_key, metadata, payment_method)
         VALUES (UUID(), ?, 'drop_5', 2, 'one_time', 980, 'jpy', ?, '{}', 'stablecoin')`,
        [filler.id, `byid-filler-${i}`],
      );
      const [order] = await query<{ id: string }>(`SELECT id FROM orders WHERE idempotency_key = ?`, [
        `byid-filler-${i}`,
      ]);
      const payer = `0x${i.toString(16).padStart(40, '0')}`;
      await query(
        `INSERT INTO stablecoin_quotes (id, order_id, user_id, token_key, chain_id, token_address,
                                        token_decimals, receiver, payer, price_jpy, amount_atomic,
                                        rounded_up, start_block, config_version, expires_at)
         VALUES (UUID(), ?, ?, 'jpyc', 137, ?, 18, ?, ?, 980, ?, 0, 1, 1, UTC_TIMESTAMP(3))`,
        [order!.id, filler.id, JPYC, RECEIVER.toLowerCase(), payer, AMOUNT.toString()],
      );
      const [quote] = await query<{ id: string }>(`SELECT id FROM stablecoin_quotes WHERE order_id = ?`, [order!.id]);
      await query(
        `INSERT INTO stablecoin_intents (id, quote_id, order_id, chain_id, payer, state)
         VALUES (UUID(), ?, ?, 137, ?, 'review')`,
        [quote!.id, order!.id, payer],
      );
    }

    const { intentId } = await shortPaymentInReview('byid@example.jp');
    const { getStablecoinReviewItem, listStablecoinReviews } = await import('@yuha/db');
    const page = await listStablecoinReviews();
    expect(page).toHaveLength(100);
    expect(page.some((q) => q.intent_id === intentId)).toBe(false);

    const item = await getStablecoinReviewItem(intentId);
    expect(item?.intent_id).toBe(intentId);

    // And a decision about it goes through, which is the point.
    const admin = await staffUser('byid-adm@example.jp', 'admin');
    const res = await decide(admin, intentId, { decision: 'accept_as_paid', reason: 'short by a rounding unit' });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('the accounting export', () => {
  it('keeps the two dates apart and emits no revenue date at all', async () => {
    /*
     * §13: the revenue-recognition date per SKU is the tax accountant's to
     * set. A column here would decide it, so there is deliberately none —
     * payment_received_at and service_delivered_at go out separately.
     */
    const { orderId } = await quoted('acc-ok@example.jp');
    await settleStablecoinObservation(h.ctx, observe(AMOUNT));
    const staff = await staffUser('acc-staff@example.jp', 'support');

    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/admin/accounting/stablecoin-export?from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`,
      headers: { ...staff.authHeader, ...freshIp() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);

    const [header, row] = res.body.trim().split('\n');
    expect(header).toContain('payment_received_at_utc');
    expect(header).toContain('service_delivered_at_utc');
    expect(header).not.toMatch(/revenue/i);
    expect(row).toContain(orderId);
    expect(row).toContain(AMOUNT.toString());
  });

  it('leaves out a payment still in review', async () => {
    await shortPaymentInReview('acc-review@example.jp');
    const staff = await staffUser('acc-staff2@example.jp', 'support');
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/admin/accounting/stablecoin-export?from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`,
      headers: { ...staff.authHeader, ...freshIp() },
    });
    expect(res.body.trim().split('\n')).toHaveLength(1); // header only
  });
});

describe('called as a function, past the route', () => {
  /*
   * Two checks in the service are unreachable over HTTP: the route's zod
   * schema refuses a blank reason first, and after one decision the item
   * leaves the review queue so a second call cannot find it. Both were
   * confirmed unreachable by deleting them and watching nothing fail. They
   * are tested here because a second operator clicking at the same moment,
   * or any future caller that is not this route, reaches them.
   */
  it('refuses a blank reason even when nothing upstream filtered it', async () => {
    const { intentId } = await shortPaymentInReview('fn-noreason@example.jp');
    const admin = await staffUser('fn-admin@example.jp', 'admin');
    await expect(
      decideStablecoinReview({
        intentId,
        decision: 'accept_as_paid',
        reason: '   ',
        actorId: admin.id,
        actorRole: 'admin',
      }),
    ).rejects.toThrow(/reason is required/);
  });

  it('lets only one of two decisions through', async () => {
    // Sequentially this is the queue lookup refusing the second. The genuinely
    // simultaneous case — both reads seeing 'review' — could not be produced
    // here; `resolveReview`'s conditional UPDATE is what would decide it, and
    // the service says so rather than this test pretending to cover it.
    const { user, intentId } = await shortPaymentInReview('fn-race@example.jp');
    const admin = await staffUser('fn-admin2@example.jp', 'admin');
    const args = {
      intentId,
      decision: 'accept_as_paid' as const,
      reason: 'two operators, one payment',
      actorId: admin.id,
      actorRole: 'admin',
    };

    const settled = await Promise.allSettled([decideStablecoinReview(args), decideStablecoinReview(args)]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await balanceOf(user.id)).available).toBe(5);
  });
});
