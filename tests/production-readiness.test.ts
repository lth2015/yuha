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
