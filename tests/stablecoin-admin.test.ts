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
import { balanceOf, createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

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
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await teardown();
});

/** A staff account that has done what the console now requires of staff. */
async function staffUser(email: string, role: 'support' | 'admin'): Promise<TestUser> {
  const user = await h.createUser({ email, role });
  const enroll = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/enroll',
    headers: { ...user.authHeader, ...freshIp() },
  });
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
