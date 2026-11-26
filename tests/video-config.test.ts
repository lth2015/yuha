/**
 * What the scene MV's video service may be configured as (apps/api/src/config.ts).
 *
 * Production: never the demo (test-pattern clips presented as the feature),
 * never plain http to a hostname, and plain http to the box's public IP only
 * when that exception is chosen explicitly (product owner, 2026-11-26).
 * Asserted on the problems the configuration reports, so other missing
 * production settings in these minimal environments do not decide the outcome.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@yuha/api';

const base = {
  DATABASE_URL: 'mysql://u:p@localhost:3306/x',
  LEGAL_ENTITY_NAME: 'テスト株式会社',
  LEGAL_ENTITY_CONTACT: 'support@example.test',
  DATABASE_SSL: 'true',
  RUN_MODE: 'production',
};

function videoProblems(env: Record<string, string>): string[] {
  try {
    loadConfig({ ...base, ...env } as never);
    return [];
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return err.problems.filter((p) => /video|LTX_API/i.test(p));
  }
}

describe('the video service in production', () => {
  it('is off unless configured, and never the demo', () => {
    expect(videoProblems({})).toEqual([]);
    expect(videoProblems({ VIDEO_ADAPTER: 'demo' })).toEqual(['production mode cannot use the demo video adapter']);
  });

  it('needs its address and key', () => {
    expect(videoProblems({ VIDEO_ADAPTER: 'http' })[0]).toMatch(/LTX_API_BASE_URL and LTX_API_KEY/);
  });

  it('takes plain http only to a public IP, and only when that exception is chosen', () => {
    const http = { VIDEO_ADAPTER: 'http', LTX_API_KEY: 'k' };
    expect(videoProblems({ ...http, LTX_API_BASE_URL: 'http://203.0.113.9:8100' })[0]).toMatch(/must use https/);
    expect(videoProblems({ ...http, LTX_API_BASE_URL: 'http://203.0.113.9:8100', VIDEO_ALLOW_INSECURE_SELF_HOSTED: 'true' })).toEqual([]);
    expect(videoProblems({ ...http, LTX_API_BASE_URL: 'http://video.example.com', VIDEO_ALLOW_INSECURE_SELF_HOSTED: 'true' })[0]).toMatch(/must use https/);
    // A private address is a development convenience, not something production may reach over http.
    expect(videoProblems({ ...http, LTX_API_BASE_URL: 'http://10.0.0.5:8100', VIDEO_ALLOW_INSECURE_SELF_HOSTED: 'true' })[0]).toMatch(/must use https/);
    expect(videoProblems({ ...http, LTX_API_BASE_URL: 'https://video.example.com' })).toEqual([]);
  });
});
