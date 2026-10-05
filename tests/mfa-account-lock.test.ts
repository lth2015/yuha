/**
 * The second-factor limit that follows the account, not the address.
 *
 * The existing one is twelve attempts a minute per IP. A challenge token lives
 * five minutes and is only spent on success, so a single challenge can be
 * tried against for its whole life, and the per-IP cap is multiplied by
 * however many addresses an attacker has. Six digits do not survive that for
 * long; a cap on the account does not move no matter how many addresses are
 * pointed at it.
 *
 * What is pinned: the lock arrives, it does not depend on where the attempts
 * came from, a correct code clears it, and a wrong guess never reveals whether
 * it was the guess or the lock that refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { base32Decode } from '../apps/api/src/auth/totp.js';
import { query } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

/** The same HOTP the implementation does, so a valid code can be produced. */
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

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 150));
  await resetData();
});
afterAll(async () => {
  await teardown(h);
});

/** Enrols a confirmed factor and returns a fresh challenge for that account. */
async function enrolled(user: TestUser): Promise<{ secret: string; challenge: () => Promise<string> }> {
  const enroll = await h.app.inject({ method: 'POST', url: '/v1/auth/mfa/enroll', headers: user.authHeader });
  const secret = enroll.json().secret as string;
  const confirm = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/confirm',
    headers: user.authHeader,
    payload: { code: totpAt(secret, Date.now()) } as never,
  });
  expect(confirm.statusCode).toBe(200);

  const challenge = async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { email: user.email, ageConfirmed: true, termsAccepted: true } as never,
    });
    expect(res.json().mfaRequired).toBe(true);
    return res.json().challengeToken as string;
  };
  return { secret, challenge };
}

const verify = (challengeToken: string, code: string, ip = '203.0.113.1') =>
  h.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/verify',
    headers: { 'x-forwarded-for': ip },
    payload: { challengeToken, code } as never,
  });

async function lockRow(userId: string): Promise<{ failed_attempts: number; locked_until: Date | null }> {
  const rows = await query<{ failed_attempts: number; locked_until: Date | null }>(
    `SELECT failed_attempts, locked_until FROM mfa_factors WHERE user_id = ?`,
    [userId],
  );
  return rows[0]!;
}

describe('five wrong codes in a row', () => {
  it('locks the account, and a sixth gets nowhere even with the right code', async () => {
    const user = await h.createUser({ email: 'lock@example.jp' });
    const { secret, challenge } = await enrolled(user);
    const token = await challenge();

    for (let i = 0; i < 5; i += 1) {
      const res = await verify(token, '000000');
      expect(res.statusCode, `attempt ${i + 1}`).toBeGreaterThanOrEqual(400);
    }

    // The real code, and still refused: the lock is on the account.
    const good = await verify(token, totpAt(secret, Date.now()));
    expect(good.statusCode).toBeGreaterThanOrEqual(400);
    expect(good.json().error?.message ?? good.json().message ?? '').toMatch(/wait a few minutes/);
  });

  it('four of them does not lock — the fifth is the one that does', async () => {
    // The off-by-one here was real: a single UPDATE that set
    // `failed_attempts = failed_attempts + 1` and then read `failed_attempts`
    // again in the CASE for `locked_until` saw the incremented value, so the
    // lock landed on the fourth wrong code and refused the fifth even when it
    // was correct. The count alone would not have caught it; the lock column
    // is what has to be asserted.
    const user = await h.createUser({ email: 'boundary@example.jp' });
    const { challenge } = await enrolled(user);
    const token = await challenge();

    for (let i = 0; i < 4; i += 1) await verify(token, '000000', `198.51.100.${40 + i}`);
    const after4 = await lockRow(user.id);
    expect(Number(after4.failed_attempts)).toBe(4);
    expect(after4.locked_until).toBeNull();

    await verify(token, '000000', '198.51.100.44');
    const after5 = await lockRow(user.id);
    expect(Number(after5.failed_attempts)).toBe(5);
    expect(after5.locked_until).not.toBeNull();
  });

  it('counts them wherever they come from', async () => {
    // This is the whole point. Five addresses, one account, same limit.
    const user = await h.createUser({ email: 'spread@example.jp' });
    const { secret, challenge } = await enrolled(user);
    const token = await challenge();

    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '198.51.100.4', '198.51.100.5']) {
      await verify(token, '000000', ip);
    }

    const good = await verify(token, totpAt(secret, Date.now()), '192.0.2.9');
    expect(good.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('does not say whether it was the code or the lock that refused', async () => {
    // A wrong guess that announces "and now you are locked" tells an attacker
    // exactly how many tries they have left and when to come back.
    const user = await h.createUser({ email: 'quiet@example.jp' });
    const { challenge } = await enrolled(user);
    const token = await challenge();

    const fourth = await verify(token, '000000');
    for (let i = 0; i < 3; i += 1) await verify(token, '000000');
    const fifth = await verify(token, '000000');

    expect(fourth.json().error?.code ?? fourth.json().code).toBe(fifth.json().error?.code ?? fifth.json().code);
  });
});

describe('a correct code', () => {
  it('clears the count, so four wrong ones never accumulate into a lock', async () => {
    const user = await h.createUser({ email: 'clear@example.jp' });
    const { secret, challenge } = await enrolled(user);

    // One address per round: the route also has a 12-a-minute per-IP cap that
    // is not tunable from the environment, and tripping it here would measure
    // that limit instead of this one.
    for (let round = 0; round < 3; round += 1) {
      const ip = `203.0.113.${20 + round}`;
      const token = await challenge();
      for (let i = 0; i < 4; i += 1) await verify(token, '000000', ip);
      const good = await verify(token, totpAt(secret, Date.now()), ip);
      expect(good.statusCode, `round ${round}`).toBe(200);
    }

    const rows = await query<{ failed_attempts: number; locked_until: Date | null }>(
      `SELECT failed_attempts, locked_until FROM mfa_factors WHERE user_id = ?`,
      [user.id],
    );
    expect(Number(rows[0]!.failed_attempts)).toBe(0);
    expect(rows[0]!.locked_until).toBeNull();
  });
});
