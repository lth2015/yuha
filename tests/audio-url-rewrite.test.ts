/**
 * The address a provider advertises is not always the address we can reach.
 *
 * Found on the first real ACE-Step generation from outside the office network.
 * The job reached the Spark, the model ran, and the service reported
 * `succeeded` — then the worker failed with
 *
 *   audio_fetch_failed: host 10.5.0.7 is not in the provider allow-list
 *
 * because the service builds `audio_url` from its own `AUDIO_BASE_URL`, which
 * is its LAN address. Correct on that network, unreachable from anywhere else.
 * The same signed path answers fine on the box's public address — the signature
 * covers the path and expiry, not the host — so the only thing wrong is the
 * origin, and the client already knows the one that works.
 *
 * Rewriting is opt-in and names both sides. The tempting version — "if the host
 * is private, swap in `baseUrl`" — guesses, and would silently redirect a
 * provider that genuinely serves audio from a second host to the wrong place.
 * The allow-list still applies afterwards, so a rewrite cannot smuggle in a
 * host the operator never named.
 */
import { describe, expect, it } from 'vitest';
import { rewriteAudioOrigin } from '@yuha/providers';

const RULE = 'http://10.5.0.7:8583=>http://121.101.82.116:8583';
const SIGNED =
  '/v1/audio/97fb7d31.mp3?exp=1791035954&sig=501c787109824bdf2df5c6933e333829ad2ff10c136d61ee7c8572e72c0f5419';

describe('audio url origin rewrite', () => {
  it('replaces the advertised origin and keeps path, query and signature', () => {
    expect(rewriteAudioOrigin(`http://10.5.0.7:8583${SIGNED}`, RULE)).toBe(
      `http://121.101.82.116:8583${SIGNED}`,
    );
  });

  it('leaves every other origin alone', () => {
    for (const url of [
      `http://10.5.0.8:8583${SIGNED}`, // neighbouring host, not the one named
      `http://10.5.0.7:9999${SIGNED}`, // same host, different port
      `https://cdn.example.com${SIGNED}`,
    ]) {
      expect(rewriteAudioOrigin(url, RULE)).toBe(url);
    }
  });

  it('does nothing when no rule is configured', () => {
    const url = `http://10.5.0.7:8583${SIGNED}`;
    expect(rewriteAudioOrigin(url, undefined)).toBe(url);
    expect(rewriteAudioOrigin(url, '')).toBe(url);
  });

  it('passes a malformed url and a malformed rule through untouched', () => {
    // Never throw on the delivery path: a url we cannot parse is the fetcher's
    // problem to report, with its own error, not something to crash on here.
    expect(rewriteAudioOrigin('not a url', RULE)).toBe('not a url');
    expect(rewriteAudioOrigin(`http://10.5.0.7:8583${SIGNED}`, 'nonsense')).toBe(
      `http://10.5.0.7:8583${SIGNED}`,
    );
  });

  it('ignores a trailing slash on either side of the rule', () => {
    expect(rewriteAudioOrigin(`http://10.5.0.7:8583${SIGNED}`, 'http://10.5.0.7:8583/=>http://121.101.82.116:8583/')).toBe(
      `http://121.101.82.116:8583${SIGNED}`,
    );
  });
});
