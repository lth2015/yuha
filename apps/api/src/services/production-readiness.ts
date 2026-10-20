import { ConfigError, loadConfig, resolveEnv } from '../config.js';

/**
 * Would this environment start in production mode, and if not, what is wrong
 * and where is it fixed?
 *
 * Run inside a pod of the deployment in question, it reads exactly what the
 * application reads — the pod's environment (manifest `env:` and ConfigMap)
 * plus the mounted secret files — and asks `loadConfig` the question with
 * RUN_MODE forced to production. Nothing is started, written or sent.
 *
 * Two checks are added that `loadConfig` deliberately does not make, because
 * making them at start-up would stop the integration deployment that is
 * serving people today: the Stripe keys must be a live pair, and the webhook
 * secret must look like one. Checkout fails on a mismatched pair however
 * valid each key is on its own.
 *
 * It reports variable names and kinds of value (`live`, `test`, `unset`),
 * never a value: its output goes to a terminal and possibly a ticket.
 */

/**
 * The keys the SecretProviderClass mounts from AWS Secrets Manager
 * (`deploy/k8s/qa/resources.yaml`). Anything else comes from the manifest or
 * the ConfigMap — putting it in the secret has no effect, and an `env:` or
 * ConfigMap value beats the secret even for these.
 */
const SECRET_KEYS = new Set([
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_SESSION_SECRET',
  'STORAGE_SIGNING_SECRET',
  'ALIGNMENT_API_KEY',
  'POLYGON_RPC_PRIMARY_URL',
  'POLYGON_RPC_SECONDARY_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'TOKENSTARS_API_KEY',
  'MUSIC_API_KEY',
  'LEGAL_ENTITY_NAME',
  'LEGAL_ENTITY_REPRESENTATIVE',
  'LEGAL_ENTITY_CONTACT',
  'LEGAL_ENTITY_PHONE',
  'DEV_AUTH_SECRET',
]);

/** Problems `loadConfig` states without naming the variable that fixes them. */
const IMPLIED: Array<[RegExp, string]> = [
  [/simulated payments/, 'PAYMENTS_ADAPTER'],
  [/dev auth adapter/, 'AUTH_ADAPTER'],
  [/demo \(fake\) music adapter/, 'MUSIC_ADAPTER'],
  [/log email adapter/, 'EMAIL_ADAPTER'],
  [/S3 storage/, 'STORAGE_ADAPTER'],
  [/TokenStars text adapter/, 'TEXT_ADAPTER'],
  [/staff second factor/, 'ADMIN_MFA_REQUIRED'],
];

export interface ReadinessProblem {
  what: string;
  /** Where the fix is made. */
  where: string;
}

export interface Readiness {
  ready: boolean;
  /** What the pod runs as now — the manifest's `env:` decides it. */
  currentMode: string;
  problems: ReadinessProblem[];
  /** Kinds of the Stripe values, never the values. */
  stripe: { secretKey: string; publishableKey: string; webhookSecret: string };
}

function kind(value: string | undefined, live: string, test: string): string {
  const v = value?.trim();
  if (!v) return 'unset';
  if (v.startsWith(live)) return 'live';
  if (v.startsWith(test)) return 'test';
  return 'unrecognised';
}

function whereFor(problem: string): string {
  if (/DEV_AUTH_SECRET/.test(problem)) {
    return 'secret and manifest — delete it from the secret; the cutover change removes its mount';
  }
  const vars = new Set(problem.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []);
  for (const [re, v] of IMPLIED) if (re.test(problem)) vars.add(v);
  const inSecret = [...vars].filter((v) => SECRET_KEYS.has(v));
  const inConfigMap = [...vars].filter((v) => !SECRET_KEYS.has(v));
  const parts: string[] = [];
  if (inConfigMap.length) parts.push(`ConfigMap: ${inConfigMap.join(', ')}`);
  if (inSecret.length) parts.push(`secret: ${inSecret.join(', ')}`);
  return parts.join('; ') || 'ConfigMap or secret';
}

/**
 * Removes anything that looks like a value from a `loadConfig` message. Its
 * messages are written to name variables, but one of them echoing a value
 * would put a secret into this report, so the report does not rely on it.
 */
export function scrub(message: string, env: NodeJS.ProcessEnv): string {
  let out = message;
  for (const [key, value] of Object.entries(env)) {
    // Secret-shaped variables only: scrubbing every value would also blank
    // the words the messages are made of ("simulated", "google").
    if (!value || value.length < 6) continue;
    if (!SECRET_KEYS.has(key) && !/SECRET|KEY|TOKEN|PASSWORD|_URL$|LEGAL_ENTITY/.test(key)) continue;
    out = out.split(value).join(`<${key}>`);
  }
  return out;
}

export function productionReadiness(env: NodeJS.ProcessEnv): Readiness {
  const problems: ReadinessProblem[] = [];
  let resolved: NodeJS.ProcessEnv = env;
  try {
    resolved = resolveEnv(env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    for (const p of err.problems) problems.push({ what: p, where: 'manifest (secret mount)' });
  }

  try {
    loadConfig({ ...env, RUN_MODE: 'production' });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    for (const p of err.problems) {
      const what = scrub(p, resolved);
      problems.push({ what, where: whereFor(what) });
    }
  }

  const stripe = {
    secretKey: kind(resolved.STRIPE_SECRET_KEY, 'sk_live_', 'sk_test_'),
    publishableKey: kind(resolved.STRIPE_PUBLISHABLE_KEY, 'pk_live_', 'pk_test_'),
    webhookSecret: resolved.STRIPE_WEBHOOK_SECRET?.trim()
      ? resolved.STRIPE_WEBHOOK_SECRET.trim().startsWith('whsec_')
        ? 'set'
        : 'unrecognised'
      : 'unset',
  };
  if (resolved.STRIPE_SECRET_KEY?.trim().startsWith('rk_live_')) stripe.secretKey = 'live';
  if (resolved.STRIPE_SECRET_KEY?.trim().startsWith('rk_test_')) stripe.secretKey = 'test';
  if (stripe.secretKey === 'test') {
    problems.push({ what: 'STRIPE_SECRET_KEY is a test key; production charges need a live key', where: 'secret: STRIPE_SECRET_KEY' });
  } else if (stripe.secretKey !== 'live') {
    problems.push({ what: 'STRIPE_SECRET_KEY is not a recognised live key (sk_live_ or rk_live_)', where: 'secret: STRIPE_SECRET_KEY' });
  }
  if (stripe.publishableKey !== 'live') {
    problems.push({
      what: `STRIPE_PUBLISHABLE_KEY is ${stripe.publishableKey}; production needs pk_live_ from the same Stripe account as the secret key`,
      where: 'ConfigMap: STRIPE_PUBLISHABLE_KEY',
    });
  }
  if (stripe.webhookSecret === 'unrecognised') {
    problems.push({
      what: 'STRIPE_WEBHOOK_SECRET does not look like a webhook signing secret (whsec_…)',
      where: 'secret: STRIPE_WEBHOOK_SECRET (from the live webhook endpoint in Stripe)',
    });
  }

  // De-duplicated: loadConfig and the checks above can describe one fault twice.
  const seen = new Set<string>();
  const unique = problems.filter((p) => (seen.has(p.what) ? false : (seen.add(p.what), true)));
  return { ready: unique.length === 0, currentMode: env.RUN_MODE ?? '(unset)', problems: unique, stripe };
}
