/**
 * Proving control of a wallet, and the constraints underneath it.
 *
 * A connected address is a claim the browser makes. Everything downstream —
 * the quote, the intent, the verifier's `verifiedPayer` — treats the payer as
 * established fact, so this is the one step where the client saying so must
 * not be enough.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { consumeWalletChallenge, query } from '@yuha/db';
import { verifyWalletChallenge } from '../apps/api/src/services/stablecoin-wallet.js';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
/** A fresh source per request, so the per-IP cap is not what is being tested. */
const freshIp = () => ({ 'x-forwarded-for': `203.0.113.${(callNo++ % 200) + 10}` });

const KEY_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const KEY_B = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
const accountA = privateKeyToAccount(KEY_A);
const accountB = privateKeyToAccount(KEY_B);

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await teardown();
});

async function challengeFor(user: TestUser, address: string) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-challenge',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { address, chainId: 137 } as never,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { nonce: string; message: string; expiresAt: string };
}

const verify = (user: TestUser, payload: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/payments/stablecoin/wallet-verify',
    headers: { ...user.authHeader, ...freshIp() },
    payload: payload as never,
  });

describe('the challenge', () => {
  it('names our own domain, not whatever the request asked for', async () => {
    // A signature is portable to any site that accepts a message naming that
    // site. The domain is the field that stops it, so it cannot come from the
    // request.
    const user = await h.createUser();
    const c = await challengeFor(user, accountA.address);
    expect(c.message).toContain('localhost:5173 wants you to sign in with your Ethereum account');
    expect(c.message).toContain('Chain ID: 137');
    expect(c.message).toContain(`Nonce: ${c.nonce}`);
    expect(c.message).toContain(accountA.address); // checksummed
  });

  it('says in the wallet that it authorises no transfer', async () => {
    const user = await h.createUser();
    const c = await challengeFor(user, accountA.address);
    expect(c.message).toMatch(/authorises no transfer/i);
  });

  it('refuses something that is not an address', async () => {
    const user = await h.createUser();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/payments/stablecoin/wallet-challenge',
      headers: { ...user.authHeader, ...freshIp() },
      payload: { address: '0xnope', chainId: 137 } as never,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('needs a session at all', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/payments/stablecoin/wallet-challenge',
      headers: freshIp(),
      payload: { address: accountA.address, chainId: 137 } as never,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('a correct signature', () => {
  it('links the wallet, and stores the address lowercased', async () => {
    const user = await h.createUser();
    const c = await challengeFor(user, accountA.address);
    const signature = await accountA.signMessage({ message: c.message });

    const res = await verify(user, { nonce: c.nonce, address: accountA.address, signature });
    expect(res.statusCode).toBe(200);
    // Returned checksummed for display, stored lowercased for comparison.
    expect(res.json().address).toBe(accountA.address);

    const rows = await query<{ address: string }>(
      `SELECT address FROM verified_wallets WHERE user_id = ?`,
      [user.id],
    );
    expect(rows[0]!.address).toBe(accountA.address.toLowerCase());
  });

  it('spends the nonce, so the same signature cannot be presented twice', async () => {
    const user = await h.createUser();
    const c = await challengeFor(user, accountA.address);
    const signature = await accountA.signMessage({ message: c.message });

    expect((await verify(user, { nonce: c.nonce, address: accountA.address, signature })).statusCode).toBe(200);
    const again = await verify(user, { nonce: c.nonce, address: accountA.address, signature });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('two verifications at once', () => {
  /*
   * Tested at the repository, not over HTTP. Two `app.inject` calls under
   * Promise.all do not actually interleave here — the suite passed with the
   * conditional UPDATE removed, which is how that was found — so an
   * HTTP-level "concurrency" test would have been a test of nothing.
   *
   * Sequentially, a replay is caught by reading `consumed_at` before
   * verifying. Concurrently, both reads see null and both signatures check
   * out; the guarantee is `consumeWalletChallenge`'s UPDATE matching only
   * while the row is unspent. Note also that `recordVerifiedWallet` is an
   * upsert, so counting wallet rows afterwards could never have failed either.
   */
  it('lets exactly one of two parallel consumptions win', async () => {
    const user = await h.createUser({ email: 'race@example.jp' });
    const c = await challengeFor(user, accountA.address);

    const [first, second] = await Promise.all([
      consumeWalletChallenge(c.nonce),
      consumeWalletChallenge(c.nonce),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('lets exactly one of two parallel verifications mint a link', async () => {
    /*
     * Called as a function, not over HTTP, because `app.inject` under
     * Promise.all does not interleave here — which is why the HTTP version of
     * this test passed with the conditional UPDATE removed. This one reaches
     * the path where the service ignores what `consumeWalletChallenge`
     * returned: the SQL still refuses the second consumption, but a caller
     * that does not look at the answer would hand out two proofs for one
     * nonce.
     */
    const user = await h.createUser({ email: 'parallel@example.jp' });
    const c = await challengeFor(user, accountA.address);
    const signature = await accountA.signMessage({ message: c.message });
    const args = { userId: user.id, nonce: c.nonce, address: accountA.address, signature };

    const settled = await Promise.allSettled([
      verifyWalletChallenge(h.ctx, args),
      verifyWalletChallenge(h.ctx, args),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses to consume an expired challenge at all', async () => {
    const user = await h.createUser({ email: 'stale@example.jp' });
    const c = await challengeFor(user, accountA.address);
    await query(`UPDATE wallet_challenges SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE nonce = ?`, [
      c.nonce,
    ]);
    expect(await consumeWalletChallenge(c.nonce)).toBe(false);
  });
});

describe('refused', () => {
  it('a signature from a different wallet than the message named', async () => {
    // B signs a message addressed to A. The recovery succeeds — it is a valid
    // signature — and it still proves nothing about A.
    const user = await h.createUser();
    const c = await challengeFor(user, accountA.address);
    const signature = await accountB.signMessage({ message: c.message });

    const res = await verify(user, { nonce: c.nonce, address: accountA.address, signature });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a valid signature presented for a different address than it signed', async () => {
    const user = await h.createUser();
    const c = await challengeFor(user, accountA.address);
    const signature = await accountA.signMessage({ message: c.message });

    const res = await verify(user, { nonce: c.nonce, address: accountB.address, signature });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('another account’s nonce, even with a perfectly good signature', async () => {
    const alice = await h.createUser({ email: 'alice@example.jp' });
    const bob = await h.createUser({ email: 'bob@example.jp' });
    const c = await challengeFor(alice, accountA.address);
    const signature = await accountA.signMessage({ message: c.message });

    const res = await verify(bob, { nonce: c.nonce, address: accountA.address, signature });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('an expired challenge', async () => {
    const user = await h.createUser();
    const c = await challengeFor(user, accountA.address);
    const signature = await accountA.signMessage({ message: c.message });
    await query(`UPDATE wallet_challenges SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE nonce = ?`, [
      c.nonce,
    ]);

    const res = await verify(user, { nonce: c.nonce, address: accountA.address, signature });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a signature over a message we did not issue', async () => {
    // The client never sends the message back, so this is the attack it
    // prevents: a message with our nonce but somebody else's domain.
    const user = await h.createUser();
    const c = await challengeFor(user, accountA.address);
    const forged = c.message.replace('localhost:5173', 'evil.example');
    const signature = await accountA.signMessage({ message: forged });

    const res = await verify(user, { nonce: c.nonce, address: accountA.address, signature });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a wallet already linked to somebody else', async () => {
    const alice = await h.createUser({ email: 'alice2@example.jp' });
    const bob = await h.createUser({ email: 'bob2@example.jp' });

    const ca = await challengeFor(alice, accountA.address);
    expect(
      (await verify(alice, { nonce: ca.nonce, address: accountA.address, signature: await accountA.signMessage({ message: ca.message }) })).statusCode,
    ).toBe(200);

    // Bob genuinely controls nothing here, but suppose he did: two accounts
    // holding one address would make an incoming transfer ambiguous between
    // two orders, and the one-open-intent rule would be guarding nothing.
    const cb = await challengeFor(bob, accountA.address);
    const res = await verify(bob, {
      nonce: cb.nonce,
      address: accountA.address,
      signature: await accountA.signMessage({ message: cb.message }),
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('the schema says no on its own', () => {
  /*
   * These are database constraints, not service checks, and they are tested
   * here because the first version of three of them could not fail: the
   * address columns were CHARACTER SET ascii, whose default collation is
   * case-INSENSITIVE, so `CHECK (payer = LOWER(payer))` was true for every
   * value including '0x...AAA'. They are COLLATE ascii_bin now.
   */
  it('refuses a mixed-case address in verified_wallets', async () => {
    const user = await h.createUser();
    await expect(
      query(`INSERT INTO verified_wallets (user_id, chain_id, address) VALUES (?, 137, ?)`, [
        user.id,
        '0x2222222222222222222222222222222222222AAA',
      ]),
    ).rejects.toThrow();
  });

  it('refuses an amount that is not digits', async () => {
    await expect(
      query(
        `INSERT INTO chain_transfer_events
           (id, chain_id, tx_hash, log_index, token_address, from_address, to_address, amount_atomic, block_number, block_hash)
         VALUES ('e-bad', 137, '0xaa', 0, ?, ?, ?, '98e18', 1, '0xbb')`,
        ['0x' + 'a'.repeat(40), '0x' + 'b'.repeat(40), '0x' + 'c'.repeat(40)],
      ),
    ).rejects.toThrow();
  });

  it('stores a full uint256 without losing a digit', async () => {
    const max = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    await query(
      `INSERT INTO chain_transfer_events
         (id, chain_id, tx_hash, log_index, token_address, from_address, to_address, amount_atomic, block_number, block_hash)
       VALUES ('e-max', 137, '0xcc', 0, ?, ?, ?, ?, 1, '0xbb')`,
      ['0x' + 'a'.repeat(40), '0x' + 'b'.repeat(40), '0x' + 'c'.repeat(40), max],
    );
    const rows = await query<{ amount_atomic: string }>(
      `SELECT amount_atomic FROM chain_transfer_events WHERE id = 'e-max'`,
    );
    expect(rows[0]!.amount_atomic).toBe(max);
  });

  it('refuses the same transfer evidence twice', async () => {
    const args = ['0x' + 'a'.repeat(40), '0x' + 'b'.repeat(40), '0x' + 'c'.repeat(40)];
    const insert = (id: string) =>
      query(
        `INSERT INTO chain_transfer_events
           (id, chain_id, tx_hash, log_index, token_address, from_address, to_address, amount_atomic, block_number, block_hash)
         VALUES (?, 137, '0xdd', 7, ?, ?, ?, '1', 1, '0xbb')`,
        [id, ...args],
      );
    await insert('e-1');
    await expect(insert('e-2')).rejects.toThrow();
  });
});
