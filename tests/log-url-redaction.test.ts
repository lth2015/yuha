/**
 * A signed URL in a query string is a credential in a query string.
 *
 * SEC-06 says prompts, tokens, cookies and card-ish fields never reach the log,
 * and the redaction list holds the authorization header, the cookie, the
 * Stripe signature and the prompt. It does not hold `req.url`, and the local
 * storage adapter serves every download through
 * `/v1/files?zone=…&key=…&expires=…&sig=…` — so the request log carried a
 * working download link for each one. Anyone reading those logs could fetch
 * that object until the signature expired.
 *
 * Only the local adapter is affected: with S3 the browser fetches a signed S3
 * url directly and it never passes through here. That makes it a development
 * exposure rather than a production one, which is a reason to fix it cheaply,
 * not a reason to leave it.
 *
 * The path is kept. The point of a request log is knowing what was asked for.
 */
import { describe, expect, it } from 'vitest';
import { redactUrlSecrets } from '../apps/api/src/log-redaction.js';

describe('redacting secrets out of a logged url', () => {
  it('removes a storage signature but keeps the route and the object', () => {
    const got = redactUrlSecrets(
      '/v1/files?zone=delivery&key=abc%2Fdef.mp3&expires=1791081524&sig=2099201edad5a6954b28c7d9',
    );
    expect(got).toContain('/v1/files');
    expect(got).toContain('zone=delivery');
    expect(got).toContain('key=abc');
    expect(got).not.toContain('2099201edad5a6954b28c7d9');
    expect(got).toContain('sig=[redacted]');
  });

  it('removes every name a credential travels under', () => {
    for (const name of ['sig', 'signature', 'token', 'access_token', 'code', 'state', 'key_secret']) {
      const out = redactUrlSecrets(`/x?${name}=supersecretvalue123`);
      expect(out, name).not.toContain('supersecretvalue123');
    }
  });

  it('leaves an ordinary url alone', () => {
    expect(redactUrlSecrets('/v1/tracks?limit=20&cursor=abc')).toBe('/v1/tracks?limit=20&cursor=abc');
    expect(redactUrlSecrets('/v1/me')).toBe('/v1/me');
  });

  it('does not throw on anything a request can carry', () => {
    // A logger that throws takes the request with it.
    for (const weird of ['', '/', '//', '/x?', '/x?=1', '/x?a', '%%%', '/x?sig=']) {
      expect(() => redactUrlSecrets(weird), JSON.stringify(weird)).not.toThrow();
    }
  });

  it('keeps the OAuth code out, which is the one that buys a session', () => {
    const out = redactUrlSecrets('/v1/auth/google/callback?code=4/0AY0e-g7&scope=email');
    expect(out).not.toContain('4/0AY0e-g7');
    expect(out).toContain('scope=email');
  });
});
