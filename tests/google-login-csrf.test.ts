/**
 * A Google sign-in belongs to the browser that started it.
 *
 * The OAuth `state` was entirely self-contained — a signed blob carrying the
 * PKCE verifier — and its docstring called that "binding the callback to the
 * start request". It bound the callback to *a* start request from *any*
 * browser, which is login CSRF:
 *
 *   1. the attacker runs `/start` and completes Google consent as themselves;
 *   2. rather than following the redirect they keep the callback URL, which
 *      carries Google's `code` and our signed `state`;
 *   3. the victim opens that URL. The API exchanges the code, resolves the
 *      ATTACKER's identity, mints a one-time code and hands it to the
 *      victim's browser, which signs itself into the attacker's account —
 *      where it may then enter payment details or upload work.
 *
 * PKCE does not help: the verifier was inside the state the attacker held.
 *
 * The fix is a nonce split in two — half in the signed state, half in an
 * HttpOnly cookie set on the `/start` response — and these tests are about
 * the refusal, which happens before any call to Google. The successful half
 * of the flow cannot be tested offline (it needs Google's token endpoint), so
 * what is asserted is that a callback WITHOUT the matching cookie is refused
 * at the binding and not somewhere later by accident.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, teardown, type Harness } from './helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({
    // The flow is registered on credential presence, not on AUTH_ADAPTER —
    // which is the configuration `.env.example` itself ships.
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:4000/v1/auth/google/callback',
    GOOGLE_SESSION_SECRET: 'google-state-secret-0123456789abcdef',
  });
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

async function start() {
  const res = await h.app.inject({ method: 'GET', url: '/v1/auth/google/start' });
  expect(res.statusCode).toBe(302);
  const location = res.headers['location'] as string;
  const state = new URL(location).searchParams.get('state');
  const setCookie = String(res.headers['set-cookie'] ?? '');
  return { state: state!, setCookie, location };
}

const callback = (state: string, cookie?: string) =>
  h.app.inject({
    method: 'GET',
    url: `/v1/auth/google/callback?code=whatever&state=${encodeURIComponent(state)}`,
    ...(cookie ? { headers: { cookie } } : {}),
  });

describe('starting a Google sign-in', () => {
  it('hands the browser a nonce it keeps, and Google a state it echoes', async () => {
    const { state, setCookie, location } = await start();
    expect(location.startsWith('https://accounts.google.com/')).toBe(true);
    expect(state).toBeTruthy();

    expect(setCookie).toContain('yuha_oauth_state=');
    // HttpOnly so a script cannot read it; Lax rather than Strict because the
    // callback is a cross-site top-level GET from accounts.google.com, which
    // Strict would drop — the sign-in would simply never work.
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    // Narrow enough that it is sent on the callback and nowhere else.
    expect(setCookie).toContain('Path=/v1/auth/google');

    // The nonce is not derivable from the state anybody can see.
    const nonce = /yuha_oauth_state=([^;]+)/.exec(setCookie)![1]!;
    expect(state).not.toContain(nonce);
  });
});

describe('a callback that arrives in a different browser', () => {
  it('is refused when the cookie is absent', async () => {
    /*
     * The attack, exactly: a state the API itself signed, replayed with no
     * cookie. Before the fix this proceeded to Google's token endpoint.
     */
    const { state } = await start();
    const res = await callback(state);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.message).toContain('different browser');
  });

  it('is refused when the cookie belongs to another sign-in', async () => {
    // Two starts, cookies crossed. Both nonces are valid; neither matches the
    // other's state.
    const first = await start();
    const second = await start();
    const res = await callback(first.state, second.setCookie.split(';')[0]);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.message).toContain('different browser');
  });

  it('is refused when the cookie is a near miss', async () => {
    const { state, setCookie } = await start();
    const nonce = /yuha_oauth_state=([^;]+)/.exec(setCookie)![1]!;
    for (const forged of [nonce.slice(0, -1), `${nonce}x`, '', 'AAAAAAAAAAAAAAAAAAAAAA']) {
      const res = await callback(state, `yuha_oauth_state=${forged}`);
      expect(res.statusCode, `nonce ${JSON.stringify(forged)} must not pass`).toBeGreaterThanOrEqual(400);
    }
  });

  it('gets past the binding with its own cookie, and only then talks to Google', async () => {
    /*
     * The other side of the assertion, and the reason the three above are not
     * passing for the wrong reason. With the matching cookie the request
     * reaches the token exchange — which fails here, because there is no
     * Google to answer — and the error must therefore be a DIFFERENT one.
     */
    const { state, setCookie } = await start();
    const res = await callback(state, setCookie.split(';')[0]);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.message).not.toContain('different browser');
  });

  it('clears the nonce once it has been used, so the URL cannot be replayed', async () => {
    // A nonce is single use. Left set, the same callback URL would work twice
    // in the browser that owns it.
    const { state, setCookie } = await start();
    const res = await callback(state, setCookie.split(';')[0]);
    expect(String(res.headers['set-cookie'] ?? '')).toContain('Max-Age=0');
  });
});
