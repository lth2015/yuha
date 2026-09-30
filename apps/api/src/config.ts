import { z } from 'zod';
import { RunMode } from '@yuha/contracts';

/**
 * Configuration and mode validation (PROJECT_TASK.md §3).
 *
 * The central rule: a run mode is a single explicit value, and the adapter
 * selection must be *consistent* with it. Rather than a bag of booleans that
 * can contradict each other, `loadConfig` derives the adapters from the mode
 * and then refuses to start when a combination is illegal — for example a
 * development login, simulated payments or the demo audio adapter in
 * production (SEC-03), or a live Stripe key outside production.
 */

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : v === 'true' || v === '1'));

const int = (dflt: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const envSchema = z.object({
  RUN_MODE: RunMode.default('demo'),
  NODE_ENV: z.string().default('development'),
  PORT: int(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: int(10),
  DATABASE_SSL: bool(false),

  // --- identity -----------------------------------------------------------
  AUTH_ADAPTER: z.enum(['dev', 'google', 'cognito']).optional(),
  /** Signing secret for the local dev session token. Never valid in production. */
  DEV_AUTH_SECRET: z.string().optional(),
  COGNITO_REGION: z.string().optional(),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_APP_CLIENT_ID: z.string().optional(),
  /** "Sign in with Google" (authorization code + PKCE; see auth/google.ts). */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  /** Signing secret for Google-issued sessions; falls back to DEV_AUTH_SECRET outside production. */
  GOOGLE_SESSION_SECRET: z.string().optional(),
  /** Key material for encrypting TOTP secrets at rest. Falls back outside production. */
  MFA_ENCRYPTION_SECRET: z.string().optional(),
  /** Issuer shown in Google Authenticator. */
  MFA_ISSUER: z.string().default('YUHA'),

  // --- text model (TokenStars) -------------------------------------------
  TEXT_ADAPTER: z.enum(['local', 'tokenstars']).optional(),
  TOKENSTARS_BASE_URL: z.string().optional(),
  TOKENSTARS_API_KEY: z.string().optional(),
  TOKENSTARS_MODEL_ID: z.string().optional(),
  TOKENSTARS_CHAT_PATH: z.string().optional(),
  TOKENSTARS_REQUEST_ID_HEADER: z.string().optional(),
  TOKENSTARS_STRUCTURED_OUTPUTS: bool(false),
  TOKENSTARS_TIMEOUT_MS: int(20_000),
  TOKENSTARS_COST_MINOR_PER_REQUEST: int(1),

  // --- music provider -----------------------------------------------------
  /** 'glm' = the GLM preset over the generic HTTP adapter (music/glm.ts). */
  MUSIC_ADAPTER: z.enum(['demo', 'glm', 'http']).optional(),
  MUSIC_PROVIDER_ID: z.string().optional(),
  MUSIC_BASE_URL: z.string().optional(),
  MUSIC_API_KEY: z.string().optional(),
  MUSIC_MODEL: z.string().optional(),
  MUSIC_CONTRACT_VERSION: z.string().optional(),
  MUSIC_LICENSE_VERSION: z.string().optional(),
  MUSIC_SUBMIT_PATH: z.string().optional(),
  MUSIC_POLL_PATH: z.string().optional(),
  MUSIC_CANCEL_PATH: z.string().optional(),
  MUSIC_REQUEST_ID_FIELD: z.string().optional(),
  MUSIC_STATUS_FIELD: z.string().optional(),
  MUSIC_AUDIO_URL_FIELD: z.string().optional(),
  MUSIC_STATUS_MAP: z.string().optional(),
  MUSIC_IDEMPOTENCY_HEADER: z.string().optional(),
  MUSIC_ALLOWED_AUDIO_HOSTS: z.string().optional(),
  MUSIC_SUPPORTS_INSTRUMENTAL: bool(false),
  MUSIC_SUPPORTS_CANCEL: bool(false),
  MUSIC_SUPPORTS_WEBHOOK: bool(false),
  MUSIC_SUPPORTS_STATUS_QUERY: bool(true),
  MUSIC_COMMERCIAL_DELIVERY: bool(false),
  MUSIC_MAX_CONCURRENCY: int(4),
  MUSIC_DATA_REGION: z.string().default('unconfirmed'),
  MUSIC_COST_MINOR_PER_REQUEST: int(45),
  MUSIC_BILL_FAILED_REQUESTS: bool(true),
  MUSIC_COST_IS_ESTIMATE: bool(true),
  MUSIC_TIMEOUT_MS: int(60_000),
  MUSIC_MAX_AUDIO_BYTES: int(25 * 1024 * 1024),
  /**
   * Fetch audio from a model server we run ourselves on the local network.
   *
   * Such a server is reachable only as `http://192.168.x.x:8000`, which the
   * SSRF guard refuses twice over — not https, and a private address. This
   * lifts exactly those two checks for hosts already on
   * `MUSIC_ALLOWED_AUDIO_HOSTS`; see the note in providers/net/fetch-audio.ts
   * for what that gives up. Refused outright in production below.
   */
  MUSIC_ALLOW_INSECURE_SELF_HOSTED: bool(false),
  DEMO_FIXTURES_DIR: z.string().optional(),
  DEMO_LATENCY_MS: int(1500),

  // --- storage ------------------------------------------------------------
  STORAGE_ADAPTER: z.enum(['local', 's3']).optional(),
  STORAGE_LOCAL_ROOT: z.string().default('./var/storage'),
  STORAGE_SIGNING_SECRET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_QUARANTINE_BUCKET: z.string().optional(),
  S3_DELIVERY_BUCKET: z.string().optional(),
  S3_KMS_KEY_ID: z.string().optional(),
  DOWNLOAD_URL_TTL_SECONDS: int(300),

  // --- queue --------------------------------------------------------------
  QUEUE_ADAPTER: z.enum(['local', 'sqs']).optional(),
  QUEUE_NAME: z.string().default('loopscene-generation'),
  SQS_QUEUE_URL: z.string().optional(),
  SQS_REGION: z.string().optional(),

  // --- payments -----------------------------------------------------------
  PAYMENTS_ADAPTER: z.enum(['simulated', 'stripe']).optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  /** Only set when the account needs a version newer than the SDK's default. */
  STRIPE_API_VERSION: z.string().optional(),
  STRIPE_PRICE_ID_DROP_5: z.string().optional(),
  /**
   * QR wallets (Alipay, WeChat Pay) on one-time checkouts.
   *
   * Off unless asked for: both must be enabled on the Stripe account first,
   * and listing a method the account cannot take fails at the checkout page
   * rather than at boot. They are single-use methods, so they are never
   * offered for subscriptions — Stripe rejects the session outright.
   */
  STRIPE_WALLETS_ENABLED: bool(false),
  STRIPE_PRICE_ID_PRO_MONTHLY: z.string().optional(),
  STRIPE_PRICE_ID_PREMIER_MONTHLY: z.string().optional(),

  // --- lyric alignment ------------------------------------------------------
  /** estimated = deterministic line timings (labelled as such); http = real model. */
  ALIGNMENT_ADAPTER: z.enum(['estimated', 'http']).optional(),
  ALIGNMENT_PROVIDER_ID: z.string().optional(),
  ALIGNMENT_BASE_URL: z.string().optional(),
  ALIGNMENT_API_KEY: z.string().optional(),
  ALIGNMENT_SUBMIT_PATH: z.string().optional(),
  ALIGNMENT_LINES_FIELD: z.string().optional(),
  ALIGNMENT_LINE_TEXT_FIELD: z.string().optional(),
  ALIGNMENT_LINE_START_FIELD: z.string().optional(),
  ALIGNMENT_LINE_END_FIELD: z.string().optional(),
  ALIGNMENT_WORDS_FIELD: z.string().optional(),
  ALIGNMENT_WORD_TEXT_FIELD: z.string().optional(),
  ALIGNMENT_WORD_START_FIELD: z.string().optional(),
  ALIGNMENT_WORD_END_FIELD: z.string().optional(),
  ALIGNMENT_SECTION_FIELD: z.string().optional(),
  ALIGNMENT_TIMEOUT_MS: int(60_000),

  // --- Market monetization -------------------------------------------------
  STRIPE_PRICE_ID_MARKET_LICENSE: z.string().optional(),

  // --- operational switches (§3.2 "运营") ---------------------------------
  FEATURE_SUBSCRIPTIONS_ENABLED: bool(true),
  FEATURE_FREE_TRIAL_ENABLED: bool(true),
  FEATURE_WAV_EXPORT_ENABLED: bool(false),
  FREE_TRIAL_UNITS: int(2),
  MAX_CONCURRENT_JOBS_PER_USER: int(2),
  DAILY_BUDGET_MINOR: int(50_000),
  GENERATION_RATE_LIMIT_PER_HOUR: int(30),
  EXPORT_RATE_LIMIT_PER_HOUR: int(60),

  // --- generation tuning --------------------------------------------------
  JOB_LEASE_SECONDS: int(90),
  JOB_DELAY_WARNING_SECONDS: int(180),
  JOB_VERIFY_DEADLINE_SECONDS: int(900),
  AUDIO_DURATION_TOLERANCE_MS: int(750),
  AUDIO_MIN_MEAN_VOLUME_DB: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? -45 : Number.parseFloat(v))),
  AUDIO_MIN_BYTES: int(8_000),
  EXPIRED_BATCH_COMPENSATION_DAYS: int(30),

  // --- legal disclosure (SEC-13) -----------------------------------------
  LEGAL_ENTITY_NAME: z.string().optional(),
  LEGAL_ENTITY_REPRESENTATIVE: z.string().optional(),
  LEGAL_ENTITY_ADDRESS: z.string().optional(),
  LEGAL_ENTITY_CONTACT: z.string().optional(),
  LEGAL_ENTITY_PHONE: z.string().optional(),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig extends RawEnv {
  mode: RunMode;
  isDemo: boolean;
  adapters: {
    auth: 'dev' | 'google' | 'cognito';
    text: 'local' | 'tokenstars';
    music: 'demo' | 'glm' | 'http';
    storage: 'local' | 's3';
    queue: 'local' | 'sqs';
    payments: 'simulated' | 'stripe';
  };
  alignment: 'estimated' | 'http';
  legalEntityConfigured: boolean;
}

/** Defaults per mode. An explicit env var may narrow these, never widen them. */
const MODE_DEFAULT_ADAPTERS: Record<RunMode, AppConfig['adapters']> = {
  demo: { auth: 'dev', text: 'local', music: 'demo', storage: 'local', queue: 'local', payments: 'simulated' },
  integration: {
    auth: 'dev',
    text: 'local',
    music: 'demo',
    storage: 'local',
    queue: 'local',
    payments: 'simulated',
  },
  production: {
    auth: 'cognito',
    text: 'tokenstars',
    music: 'glm',
    storage: 's3',
    queue: 'sqs',
    payments: 'stripe',
  },
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const mode = e.RUN_MODE;
  const defaults = MODE_DEFAULT_ADAPTERS[mode];
  const adapters: AppConfig['adapters'] = {
    auth: e.AUTH_ADAPTER ?? defaults.auth,
    text: e.TEXT_ADAPTER ?? defaults.text,
    music: e.MUSIC_ADAPTER ?? defaults.music,
    storage: e.STORAGE_ADAPTER ?? defaults.storage,
    queue: e.QUEUE_ADAPTER ?? defaults.queue,
    payments: e.PAYMENTS_ADAPTER ?? defaults.payments,
  };

  const problems: string[] = [];

  // ---- production must not contain any development affordance (SEC-03) ----
  if (mode === 'production') {
    if (adapters.auth === 'dev') problems.push('production mode cannot use the dev auth adapter');
    if (adapters.music === 'demo') problems.push('production mode cannot use the demo (fake) music adapter');
    if (adapters.payments !== 'stripe') problems.push('production mode cannot use simulated payments');
    if (adapters.storage !== 's3') problems.push('production mode requires S3 storage');
    if (adapters.text !== 'tokenstars') {
      problems.push('production mode requires the TokenStars text adapter (AI-01)');
    }
    if (e.DEV_AUTH_SECRET) problems.push('DEV_AUTH_SECRET must not be set in production');
    if (e.MUSIC_ALLOW_INSECURE_SELF_HOSTED) {
      problems.push(
        'MUSIC_ALLOW_INSECURE_SELF_HOSTED must not be set in production: it turns off the https ' +
          'and private-address checks on provider audio URLs (SEC-05)',
      );
    }
    if (!e.LEGAL_ENTITY_NAME || !e.LEGAL_ENTITY_ADDRESS || !e.LEGAL_ENTITY_CONTACT) {
      // SEC-13: placeholder disclosure is fine for a demo, never for real selling.
      problems.push(
        'production mode requires LEGAL_ENTITY_NAME, LEGAL_ENTITY_ADDRESS and LEGAL_ENTITY_CONTACT ' +
          '(特定商取引法 disclosure must not be a placeholder)',
      );
    }
    if (!e.DATABASE_SSL) problems.push('production mode requires DATABASE_SSL=true');
  }

  // ---- per-adapter requirements -----------------------------------------
  if (adapters.auth === 'cognito') {
    if (!e.COGNITO_REGION) problems.push('COGNITO_REGION is required for the cognito auth adapter');
    if (!e.COGNITO_USER_POOL_ID) problems.push('COGNITO_USER_POOL_ID is required for the cognito auth adapter');
    if (!e.COGNITO_APP_CLIENT_ID) problems.push('COGNITO_APP_CLIENT_ID is required for the cognito auth adapter');
  } else if (adapters.auth === 'google') {
    if (!e.GOOGLE_CLIENT_ID) problems.push('GOOGLE_CLIENT_ID is required for the google auth adapter');
    if (!e.GOOGLE_CLIENT_SECRET) problems.push('GOOGLE_CLIENT_SECRET is required for the google auth adapter');
    if (!e.GOOGLE_REDIRECT_URI) problems.push('GOOGLE_REDIRECT_URI is required for the google auth adapter');
    if (mode === 'production' && !e.GOOGLE_SESSION_SECRET) {
      problems.push('GOOGLE_SESSION_SECRET is required for google auth in production');
    }
  } else if (!e.DEV_AUTH_SECRET) {
    problems.push('DEV_AUTH_SECRET is required for the dev auth adapter');
  }

  if (adapters.text === 'tokenstars') {
    if (!e.TOKENSTARS_BASE_URL) problems.push('TOKENSTARS_BASE_URL is required for the tokenstars adapter');
    if (!e.TOKENSTARS_API_KEY) problems.push('TOKENSTARS_API_KEY is required for the tokenstars adapter');
    if (!e.TOKENSTARS_MODEL_ID) {
      problems.push('TOKENSTARS_MODEL_ID is required — the model id must come from TokenStars, not a guess');
    }
    if (!e.TOKENSTARS_CHAT_PATH) {
      problems.push('TOKENSTARS_CHAT_PATH is required — endpoint paths are never assumed');
    }
  }

  if (adapters.music === 'glm') {
    // The GLM preset (providers/music/glm.ts) carries defaults for everything
    // except the credential; the endpoint mapping remains overridable.
    if (!e.MUSIC_API_KEY) problems.push('MUSIC_API_KEY is required for the glm music adapter (GLM API key)');
  }

  if (adapters.music === 'http') {
    const required: Array<[string, string | undefined]> = [
      ['MUSIC_PROVIDER_ID', e.MUSIC_PROVIDER_ID],
      ['MUSIC_BASE_URL', e.MUSIC_BASE_URL],
      ['MUSIC_API_KEY', e.MUSIC_API_KEY],
      ['MUSIC_MODEL', e.MUSIC_MODEL],
      ['MUSIC_CONTRACT_VERSION', e.MUSIC_CONTRACT_VERSION],
      ['MUSIC_LICENSE_VERSION', e.MUSIC_LICENSE_VERSION],
      ['MUSIC_SUBMIT_PATH', e.MUSIC_SUBMIT_PATH],
      ['MUSIC_POLL_PATH', e.MUSIC_POLL_PATH],
      ['MUSIC_REQUEST_ID_FIELD', e.MUSIC_REQUEST_ID_FIELD],
      ['MUSIC_STATUS_FIELD', e.MUSIC_STATUS_FIELD],
      ['MUSIC_AUDIO_URL_FIELD', e.MUSIC_AUDIO_URL_FIELD],
      ['MUSIC_STATUS_MAP', e.MUSIC_STATUS_MAP],
      ['MUSIC_ALLOWED_AUDIO_HOSTS', e.MUSIC_ALLOWED_AUDIO_HOSTS],
    ];
    for (const [name, value] of required) {
      if (!value) {
        problems.push(`${name} is required for the http music adapter (fill in from the signed API docs)`);
      }
    }
    if (e.MUSIC_STATUS_MAP) {
      try {
        const map = JSON.parse(e.MUSIC_STATUS_MAP) as Record<string, unknown>;
        for (const k of ['pending', 'completed', 'failed', 'rejected']) {
          if (!Array.isArray(map[k])) problems.push(`MUSIC_STATUS_MAP.${k} must be an array of provider status strings`);
        }
      } catch {
        problems.push('MUSIC_STATUS_MAP must be valid JSON');
      }
    }
  }

  if (adapters.storage === 's3') {
    if (!e.S3_REGION) problems.push('S3_REGION is required for the s3 storage adapter');
    if (!e.S3_QUARANTINE_BUCKET) problems.push('S3_QUARANTINE_BUCKET is required for the s3 storage adapter');
    if (!e.S3_DELIVERY_BUCKET) problems.push('S3_DELIVERY_BUCKET is required for the s3 storage adapter');
    if (e.S3_QUARANTINE_BUCKET && e.S3_QUARANTINE_BUCKET === e.S3_DELIVERY_BUCKET) {
      problems.push('the quarantine and delivery buckets must be different access boundaries');
    }
  } else if (!e.STORAGE_SIGNING_SECRET) {
    problems.push('STORAGE_SIGNING_SECRET is required for the local storage adapter');
  }

  if (adapters.queue === 'sqs') {
    if (!e.SQS_QUEUE_URL) problems.push('SQS_QUEUE_URL is required for the sqs queue adapter');
    if (!e.SQS_REGION) problems.push('SQS_REGION is required for the sqs queue adapter');
  }

  if (adapters.payments === 'stripe') {
    if (!e.STRIPE_SECRET_KEY) problems.push('STRIPE_SECRET_KEY is required for the stripe payments adapter');
    if (!e.STRIPE_WEBHOOK_SECRET) problems.push('STRIPE_WEBHOOK_SECRET is required for webhook verification');
    if (!e.STRIPE_PRICE_ID_DROP_5) problems.push('STRIPE_PRICE_ID_DROP_5 is required for the stripe payments adapter');
    if (e.FEATURE_SUBSCRIPTIONS_ENABLED && !e.STRIPE_PRICE_ID_PRO_MONTHLY) {
      problems.push('STRIPE_PRICE_ID_PRO_MONTHLY is required when subscriptions are enabled');
    }
    if (e.STRIPE_SECRET_KEY?.startsWith('sk_live_') && mode !== 'production') {
      problems.push(`a live Stripe key cannot be used in ${mode} mode`);
    }
    if (e.STRIPE_SECRET_KEY?.startsWith('sk_test_') && mode === 'production') {
      problems.push('production mode requires a live Stripe key, not a test key');
    }
  } else if (mode !== 'production' && e.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
    problems.push('a live Stripe key is present outside production mode — remove it');
  }

  // ---- cross-cutting sanity ---------------------------------------------
  if (adapters.music === 'demo' && e.MUSIC_COMMERCIAL_DELIVERY) {
    // The demo provider has no agreement behind it; it can never license output.
    problems.push('MUSIC_COMMERCIAL_DELIVERY cannot be true while the demo music adapter is in use (SEC-09)');
  }
  if (e.FEATURE_WAV_EXPORT_ENABLED && adapters.music === 'demo') {
    problems.push(
      'FEATURE_WAV_EXPORT_ENABLED requires a provider that delivers native lossless audio (UI-07) — ' +
        'the demo adapter produces MP3 only',
    );
  }
  if (e.FEATURE_FREE_TRIAL_ENABLED && e.FREE_TRIAL_UNITS > 2) {
    problems.push('FREE_TRIAL_UNITS must not exceed 2 (§7)');
  }

  if (problems.length) throw new ConfigError(problems);

  const alignment = e.ALIGNMENT_ADAPTER ?? 'estimated';
  if (alignment === 'http') {
    const alignmentDeps = [e.ALIGNMENT_PROVIDER_ID, e.ALIGNMENT_BASE_URL, e.ALIGNMENT_API_KEY, e.ALIGNMENT_SUBMIT_PATH,
      e.ALIGNMENT_LINES_FIELD, e.ALIGNMENT_LINE_TEXT_FIELD, e.ALIGNMENT_LINE_START_FIELD, e.ALIGNMENT_LINE_END_FIELD];
    for (const [i, value] of alignmentDeps.entries()) {
      if (!value) {
        problems.push(
          `ALIGNMENT_* field ${i + 1} is required for the http alignment adapter (fill in from the model documentation)`,
        );
        break;
      }
    }
  }

  return {
    ...e,
    mode,
    isDemo: mode === 'demo',
    adapters,
    alignment,
    legalEntityConfigured: !!(e.LEGAL_ENTITY_NAME && e.LEGAL_ENTITY_ADDRESS && e.LEGAL_ENTITY_CONTACT),
  };
}

/**
 * Feature switches, combining static configuration with the operator-editable
 * runtime settings table. Nothing here can turn ON something the mode forbids —
 * a switch can only narrow what configuration already permits.
 */
export interface FeatureFlags {
  subscriptionsEnabled: boolean;
  freeTrialEnabled: boolean;
  wavExportEnabled: boolean;
  commercialDeliveryEnabled: boolean;
  realPaymentsEnabled: boolean;
  generationEnabled: boolean;
}

export function baseFeatures(cfg: AppConfig): FeatureFlags {
  return {
    // Subscriptions are built and tested but default OFF until repeat purchase
    // is demonstrated (§7).
    subscriptionsEnabled: cfg.FEATURE_SUBSCRIPTIONS_ENABLED,
    freeTrialEnabled: cfg.FEATURE_FREE_TRIAL_ENABLED,
    wavExportEnabled: cfg.FEATURE_WAV_EXPORT_ENABLED,
    // SEC-09: no signed agreement means no commercial delivery, regardless of
    // what anyone sets in the environment.
    commercialDeliveryEnabled: cfg.MUSIC_COMMERCIAL_DELIVERY && cfg.adapters.music !== 'demo',
    realPaymentsEnabled: cfg.adapters.payments === 'stripe',
    generationEnabled: true,
  };
}
