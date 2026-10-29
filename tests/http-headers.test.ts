/**
 * Browser hardening on what the API answers (security review YSEC04): not
 * framed, not sniffed, and no full URL in the referrer. The share preview is
 * the API's one HTML page, so it is checked too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, teardown, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

describe('security headers', () => {
  it.each(['/health', '/v1/share/songs/00000000-0000-0000-0000-000000000000'])('are on %s', async (url) => {
    const res = await h.app.inject({ method: 'GET', url, headers: { 'user-agent': 'Twitterbot/1.0' } });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });
});
