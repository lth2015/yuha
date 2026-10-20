/**
 * "Everything is in the secret, so it should work" — checked, not believed.
 *
 * yuha.studio is the service people use and runs RUN_MODE=integration with
 * simulated payments. The production values were put into the AWS secret and
 * changed nothing: RUN_MODE is set in the manifest, which beats any secret;
 * PAYMENTS_ADAPTER and the price ids are read from the ConfigMap; and the
 * secret mount carries fifteen named keys, none of them those. This report is
 * what the application itself would say about the same environment in
 * production mode, run inside the pod before anyone flips the mode.
 */
import { describe, expect, it } from 'vitest';
import { productionReadiness, scrub } from '../apps/api/src/services/production-readiness.js';
import { StripePaymentsAdapter } from '../packages/providers/src/payments/stripe.js';
import { loadConfig } from '../apps/api/src/config.js';
import { assertSafeUrl } from '../packages/providers/src/net/fetch-audio.js';

/** Roughly what yuha.studio's API pod reads today, with invented values. */
const today = {
  RUN_MODE: 'integration',
  NODE_ENV: 'production',
  DATABASE_URL: 'mysql://dbuser:dbpassword-must-not-print@localhost:3306/yuha',
  AUTH_ADAPTER: 'google',
  GOOGLE_CLIENT_ID: 'gid',
  GOOGLE_CLIENT_SECRET: 'gsecret-should-not-print',
  GOOGLE_REDIRECT_URI: 'https://yuha.example/v1/auth/google/callback',
  GOOGLE_SESSION_SECRET: 'session-secret-should-not-print-0123456789',
  PAYMENTS_ADAPTER: 'simulated',
  STRIPE_PUBLISHABLE_KEY: 'pk_live_abcdefghijklmnop',
  STRIPE_SECRET_KEY: 'sk_test_secretvaluethatmustnotprint',
  DEV_AUTH_SECRET: 'dev-secret-should-not-print',
  LEGAL_ENTITY_NAME: 'テスト事業主',
  LEGAL_ENTITY_CONTACT: 'legal@example.com',
};

const text = (r: ReturnType<typeof productionReadiness>) => JSON.stringify(r);

describe('production readiness of an environment', () => {
  it('names what stops the switch, as the application would refuse it', () => {
    const r = productionReadiness(today);
    expect(r.ready).toBe(false);
    const all = r.problems.map((p) => p.what).join('\n');
    expect(all).toMatch(/simulated payments/);
    expect(all).toMatch(/DEV_AUTH_SECRET/);
    expect(all).toMatch(/DATABASE_SSL/);
  });

  it('catches a live publishable key paired with a test secret key', () => {
    // Allowed outside production on purpose (the site runs that way today),
    // so it is not a start-up check — but Checkout cannot work with the pair.
    const all = productionReadiness(today).problems.map((p) => p.what).join('\n');
    expect(all).toMatch(/STRIPE_SECRET_KEY is a test key/);
  });

  it('recognises a restricted live key as live in the production preflight', () => {
    const r = productionReadiness({ ...today, STRIPE_SECRET_KEY: 'rk_live_example' });
    expect(r.stripe.secretKey).toBe('live');
    expect(r.problems.map((p) => p.what).join('\n')).not.toMatch(/STRIPE_SECRET_KEY is a test key/);
  });

  it('reports a restricted test key as test and an unknown key as invalid', () => {
    const test = productionReadiness({ ...today, STRIPE_SECRET_KEY: 'rk_test_example' });
    expect(test.stripe.secretKey).toBe('test');
    expect(test.problems.map((p) => p.what).join('\n')).toMatch(/STRIPE_SECRET_KEY is a test key/);
    const unknown = productionReadiness({ ...today, STRIPE_SECRET_KEY: 'unknown_example' });
    expect(unknown.ready).toBe(false);
    expect(unknown.problems.map((p) => p.what).join('\n')).toMatch(/not a recognised live key/);
  });

  it('accepts a restricted live key only in production', () => {
    const options = { secretKey: 'rk_live_example', webhookSecret: 'whsec_example' };
    expect(() => new StripePaymentsAdapter({ ...options, expectLiveMode: true })).not.toThrow();
    expect(() => new StripePaymentsAdapter({ ...options, expectLiveMode: false })).toThrow(/outside production/);
    expect(() => new StripePaymentsAdapter({ ...options, secretKey: 'rk_test_example', expectLiveMode: true }))
      .toThrow(/live Stripe/);
    expect(() => new StripePaymentsAdapter({ ...options, secretKey: 'unknown_example', expectLiveMode: true }))
      .toThrow(/live Stripe/);
  });

  it('keeps restricted live keys out of non-production mode even with simulated payments', () => {
    const env = {
      ...today,
      AUTH_ADAPTER: 'dev',
      STORAGE_SIGNING_SECRET: 'storage-secret-example',
      PUBLIC_API_URL: 'https://yuha.example',
    };
    expect(() => loadConfig({ ...env, STRIPE_SECRET_KEY: 'rk_live_example' }))
      .toThrow(/live Stripe key/);
    expect(() => loadConfig({ ...env, STRIPE_SECRET_KEY: 'rk_test_example' }))
      .not.toThrow();
  });

  it('permits the configured HTTP Spark host in production but not a different host', () => {
    const spark = {
      ...today,
      MUSIC_ADAPTER: 'http',
      MUSIC_PROVIDER_ID: 'ace-step-spark',
      MUSIC_BASE_URL: 'http://121.101.82.116:8583',
      MUSIC_ALLOWED_AUDIO_HOSTS: '121.101.82.116',
      MUSIC_ALLOW_INSECURE_SELF_HOSTED: 'true',
    };
    const accepted = productionReadiness(spark).problems.map((p) => p.what).join('\n');
    expect(accepted).not.toMatch(/MUSIC_ALLOW_INSECURE_SELF_HOSTED/);
    const rejected = productionReadiness({ ...spark, MUSIC_ALLOWED_AUDIO_HOSTS: '169.254.169.254' })
      .problems.map((p) => p.what).join('\n');
    expect(rejected).toMatch(/MUSIC_ALLOW_INSECURE_SELF_HOSTED/);
    const privateBase = productionReadiness({
      ...spark,
      MUSIC_BASE_URL: 'http://169.254.169.254:8583',
      MUSIC_ALLOWED_AUDIO_HOSTS: '169.254.169.254',
    }).problems.map((p) => p.what).join('\n');
    expect(privateBase).toMatch(/MUSIC_ALLOW_INSECURE_SELF_HOSTED/);
  });

  it('still blocks private and metadata addresses when allowing HTTP in production', async () => {
    const options = {
      allowedHosts: ['8.8.8.8', '169.254.169.254'],
      maxBytes: 1024,
      timeoutMs: 1000,
      allowInsecureSelfHosted: true,
      allowPrivateAddresses: false,
    };
    await expect(assertSafeUrl('http://8.8.8.8/audio.mp3', options)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data/', options))
      .rejects.toThrow(/non-public/);
  });

  it('says where each fix is made: the ConfigMap, the secret, or the manifest', () => {
    for (const p of productionReadiness(today).problems) {
      expect(p.where, p.what).toMatch(/ConfigMap|secret|manifest|Stripe/);
    }
  });

  it('flags a webhook secret that is not one', () => {
    const all = productionReadiness({ ...today, STRIPE_WEBHOOK_SECRET: 'sk_live_oops' })
      .problems.map((p) => p.what)
      .join('\n');
    expect(all).toMatch(/STRIPE_WEBHOOK_SECRET does not look like a webhook signing secret/);
  });

  it('never prints a value', () => {
    const out = text(productionReadiness({ ...today, STRIPE_WEBHOOK_SECRET: 'whsec_mustnotprint' }));
    for (const secret of [
      'sk_test_secretvaluethatmustnotprint',
      'pk_live_abcdefghijklmnop',
      'dev-secret-should-not-print',
      'gsecret-should-not-print',
      'session-secret-should-not-print',
      'whsec_mustnotprint',
      'dbpassword-must-not-print',
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  it('reports the mode the pod runs in now, because the manifest decides it', () => {
    const r = productionReadiness(today);
    expect(r.currentMode).toBe('integration');
  });

  it('scrubs a secret out of any message that echoes one', () => {
    // No loadConfig message echoes a secret today; the report does not rely
    // on that staying true.
    const env = { STRIPE_SECRET_KEY: 'sk_live_echoedvalue', PAYMENTS_ADAPTER: 'simulated' };
    expect(scrub('key sk_live_echoedvalue is wrong', env)).toBe('key <STRIPE_SECRET_KEY> is wrong');
    // And only secret-shaped variables: the words messages are made of stay.
    expect(scrub('cannot use simulated payments', env)).toBe('cannot use simulated payments');
  });
});
