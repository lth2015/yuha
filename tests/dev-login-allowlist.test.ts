/**
 * The dev sign-in allowlist. The DGX intranet build runs the dev adapter, which
 * signs in any address with no password; DEV_LOGIN_ALLOWLIST is the fence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devLoginAllowed, parseDevLoginAllowlist } from '@yuha/api';
import { query } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

describe('parseDevLoginAllowlist / devLoginAllowed', () => {
  it('is unrestricted when unset or blank', () => {
    for (const raw of [undefined, '', ' , ']) {
      const list = parseDevLoginAllowlist(raw);
      expect(list.restricted).toBe(false);
      expect(devLoginAllowed('anyone@anywhere.test', list)).toBe(true);
    }
  });

  it('admits a whole domain, exactly that domain, case-insensitively', () => {
    const list = parseDevLoginAllowlist('@NetStars.co.jp');
    expect(devLoginAllowed('colleague@netstars.co.jp', list)).toBe(true);
    expect(devLoginAllowed('Someone@NETSTARS.CO.JP', list)).toBe(true);
    expect(devLoginAllowed('x@mail.netstars.co.jp', list)).toBe(false);
    expect(devLoginAllowed('x@netstars.co.jp.evil.test', list)).toBe(false);
    expect(devLoginAllowed('admin@example.jp', list)).toBe(false);
  });

  it('admits exact addresses alongside domains', () => {
    const list = parseDevLoginAllowlist('@netstars.co.jp, guest@example.com');
    expect(list.domains).toEqual(['netstars.co.jp']);
    expect(devLoginAllowed('guest@example.com', list)).toBe(true);
    expect(devLoginAllowed('other@example.com', list)).toBe(false);
  });
});

describe('POST /v1/auth/dev-login behind an allowlist', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ DEV_LOGIN_ALLOWLIST: '@netstars.co.jp' });
    await resetData();
  });
  afterAll(async () => {
    await h?.close();
    await teardown();
  });

  const login = (email: string) =>
    h.app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { email, ageConfirmed: true, termsAccepted: true } as never,
    });

  it('signs in an allowed address', async () => {
    const res = await login('colleague@netstars.co.jp');
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it('refuses any other address and leaves no account behind', async () => {
    const res = await login('admin@example.jp');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('EMAIL_NOT_ALLOWED');
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE email = ?`, ['admin@example.jp']);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('tells the sign-in page the domains, never the exact addresses', async () => {
    const cfg = (await h.app.inject({ method: 'GET', url: '/v1/auth/config' })).json();
    expect(cfg.devLoginRestricted).toBe(true);
    expect(cfg.devLoginDomains).toEqual(['netstars.co.jp']);
  });
});
