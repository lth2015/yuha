/**
 * The operations console needs a second factor.
 *
 * A staff account can compensate users, resolve rights cases and read other
 * people's orders, so a stolen staff password is a different class of incident
 * from a stolen customer password. This is Stripe's anti-fraud measure ②, and
 * it was previously true of nothing: MFA was entirely opt-in, admins included.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { base32Decode } from '../apps/api/src/auth/totp.js';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `198.51.100.${(callNo++ % 200) + 10}` });

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
  h = await createHarness({ ADMIN_MFA_REQUIRED: 'true' });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await teardown();
});

const overview = (user: TestUser) =>
  h.app.inject({ method: 'GET', url: '/v1/admin/overview', headers: { ...user.authHeader, ...freshIp() } });

async function enrolMfa(user: TestUser): Promise<void> {
  const enroll = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/enroll',
    headers: { ...user.authHeader, ...freshIp() },
  });
  expect(enroll.statusCode).toBe(200);
  const confirm = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/confirm',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { code: totpAt(enroll.json().secret as string, Date.now()) } as never,
  });
  expect(confirm.statusCode).toBe(200);
}

describe('an admin without a second factor', () => {
  it('cannot reach the console', async () => {
    const admin = await h.createUser({ email: 'bare-admin@example.jp', role: 'admin' });
    const res = await overview(admin);
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('MFA_REQUIRED');
  });

  it('is told what to do about it, not just refused', async () => {
    const admin = await h.createUser({ email: 'told-admin@example.jp', role: 'admin' });
    const res = await overview(admin);
    expect(JSON.stringify(res.json())).toMatch(/enrol/i);
  });

  it('can still enrol, so the refusal is not a lock-out', async () => {
    /*
     * Checked at the role gate rather than at sign-in, which is what makes an
     * account GIVEN a staff role later unable to use the console until it
     * enrols. The way out has to stay open, and enrolment is an ordinary
     * authenticated route rather than a staff one.
     */
    const admin = await h.createUser({ email: 'enrolling-admin@example.jp', role: 'admin' });
    expect((await overview(admin)).statusCode).toBe(403);
    await enrolMfa(admin);
    expect((await overview(admin)).statusCode).toBe(200);
  });
});

describe('the requirement is about staff, not about everybody', () => {
  it('leaves ordinary customers alone', async () => {
    const user = await h.createUser({ email: 'customer@example.jp' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/entitlements',
      headers: { ...user.authHeader, ...freshIp() },
    });
    expect(res.statusCode).toBe(200);
  });

  it('covers support, not only admin', async () => {
    // Support can read other people's orders, which is the thing being
    // protected; the role name is not what makes an account sensitive.
    const support = await h.createUser({ email: 'bare-support@example.jp', role: 'support' });
    expect((await overview(support)).statusCode).toBe(403);
  });

  it('still refuses a non-staff account with a second factor', async () => {
    // MFA is not a role. Enrolling must not be a way in.
    const user = await h.createUser({ email: 'mfa-but-customer@example.jp' });
    await enrolMfa(user);
    expect((await overview(user)).statusCode).toBe(403);
    expect((await overview(user)).json().error?.code).toBe('FORBIDDEN');
  });
});

describe('the switch', () => {
  it('exists for local demos and this suite, and production refuses it off', async () => {
    const { loadConfig } = await import('@yuha/api');
    expect(() =>
      loadConfig({
        RUN_MODE: 'production',
        NODE_ENV: 'production',
        DATABASE_URL: 'mysql://u:p@localhost:3306/x',
        PUBLIC_WEB_URL: 'https://example.jp',
        PUBLIC_API_URL: 'https://api.example.jp',
        ADMIN_MFA_REQUIRED: 'false',
      }),
    ).toThrow(/cannot disable the staff second factor/);
  });
});
