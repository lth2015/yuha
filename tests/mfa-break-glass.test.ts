/**
 * Getting back into an account whose second factor has gone wrong.
 *
 * Two ways back, both for the account's owner:
 * - a recovery code, which must not depend on the authenticator secret being
 *   readable — it is the way back for exactly the case where that secret is
 *   gone (a rotated key, a corrupted row), and it used to be checked only
 *   after the secret was decrypted, so an unreadable secret answered every
 *   recovery code with a 500;
 * - an operator reset from inside the cluster (`cli.js mfa-reset`), which
 *   removes the factor and records why.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { execute, getMfaFactor, query, resetMfaFactor } from '@yuha/db';
import { base32Decode } from '../apps/api/src/auth/totp.js';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

function totp(secret: string): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(Date.now() / 30_000), 4);
  const d = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = d[d.length - 1]! & 0x0f;
  const n = ((d[o]! & 0x7f) << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

async function enrolled(email: string) {
  const user = await h.createUser({ email });
  const { secret } = (await h.app.inject({ method: 'POST', url: '/v1/auth/mfa/enroll', headers: user.authHeader })).json();
  const confirm = await h.app.inject({ method: 'POST', url: '/v1/auth/mfa/confirm', headers: user.authHeader, payload: { code: totp(secret) } as never });
  return { user, recoveryCodes: confirm.json().recoveryCodes as string[] };
}

async function challenge(email: string): Promise<string> {
  const login = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/dev-login',
    payload: { email, ageConfirmed: true, termsAccepted: true, marketingOptIn: false } as never,
  });
  return login.json().challengeToken as string;
}

// Well-formed, but sealed under some other key: what a rotated MFA_ENCRYPTION_SECRET leaves behind.
const unreadable = (userId: string) =>
  execute(`UPDATE mfa_factors SET secret_encrypted = ? WHERE user_id = ?`, [
    `${Buffer.alloc(12, 1).toString('base64url')}.${Buffer.alloc(16, 2).toString('base64url')}.${Buffer.alloc(24, 3).toString('base64url')}`,
    userId,
  ]);

describe('a recovery code when the authenticator secret cannot be read', () => {
  it('still signs in, once', async () => {
    const email = 'bg-a@example.test';
    const { user, recoveryCodes } = await enrolled(email);
    await unreadable(user.id);

    const res = await h.app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', payload: { challengeToken: await challenge(email), code: recoveryCodes[0]! } as never });
    expect(res.statusCode).toBe(200);
    expect(res.json().usedRecoveryCode).toBe(true);
    expect((await getMfaFactor(user.id))!.recovery_codes).toHaveLength(recoveryCodes.length - 1);
  });

  it('a wrong code is a wrong code, not a server error', async () => {
    const email = 'bg-b@example.test';
    const { user } = await enrolled(email);
    await unreadable(user.id);

    const res = await h.app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', payload: { challengeToken: await challenge(email), code: '123456' } as never });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MFA_INVALID_CODE');
  });
});

describe('the operator reset', () => {
  it('removes the factor, so the next sign-in is a session, and records who asked and why', async () => {
    const email = 'bg-c@example.test';
    const { user } = await enrolled(email);
    expect(await challenge(email)).toBeTruthy();

    const out = await resetMfaFactor({ email: 'BG-C@example.test ', reason: 'owner lost their authenticator' });
    expect(out).toMatchObject({ userId: user.id, removed: true, wasEnabled: true, recoveryCodesLeft: 8 });

    expect(await getMfaFactor(user.id)).toBeUndefined();
    const login = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { email, ageConfirmed: true, termsAccepted: true, marketingOptIn: false } as never,
    });
    expect(login.json().challengeToken).toBeUndefined();
    expect(login.json().token).toBeTruthy();

    const audit = await query<{ action: string; reason: string; actor_role: string }>(
      `SELECT action, reason, actor_role FROM audit_logs WHERE subject_type = 'user' AND subject_id = ?`,
      [user.id],
    );
    expect(audit).toEqual([{ action: 'mfa.reset', reason: 'owner lost their authenticator', actor_role: 'operator' }]);
  });

  it('says so, and changes nothing, for an address with no account or no factor', async () => {
    await h.createUser({ email: 'bg-d@example.test' });
    expect(await resetMfaFactor({ email: 'nobody@example.test', reason: 'r' })).toBeNull();
    expect(await resetMfaFactor({ email: 'bg-d@example.test', reason: 'r' })).toMatchObject({ removed: false });
    expect(await query(`SELECT id FROM audit_logs WHERE action = 'mfa.reset'`)).toEqual([]);
  });

  it('refuses without a reason', async () => {
    await expect(resetMfaFactor({ email: 'x@example.test', reason: '  ' })).rejects.toThrow(/reason/);
  });
});
