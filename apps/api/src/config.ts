import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { GOOGLE_CALLBACK_PATH, GOOGLE_WEB_RETURN_PATH } from './auth/google-paths.js';
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

/**
 * An empty value in a .env file means "not set", the same way `bool` already
 * treats it.
 *
 * `z.coerce.number()` does not: Number('') is 0, so a variable left blank
 * became zero and then failed a `.positive()` check with a message about the
 * number being too small — for a line the author had deliberately left empty
 * to take the default. A blank line in a config file is the most ordinary
 * thing there is, and it should not be an error about arithmetic.
 */
/*
 * Trimmed, because `Number(' ')` is 0.
 *
 * A line left as `KEY= ` — a space after the equals, which editors and shell
 * heredocs produce without anybody meaning anything by it — is as empty as a
 * line with nothing after it, and reading it as zero is the same defect this
 * helper exists to fix, one character further on.
 */
const blank = (v: string | undefined) => v === undefined || v.trim() === '';

/**
 * The oldest Stripe API version this code is written for.
 *
 * Two separate reasons, both discovered the expensive way: an account with
 * Managed Payments refuses a Checkout Session on anything older, and the
 * webhook payload shape this version introduced is what
 * `services/webhooks.ts` reads — an Invoice's subscription under
 * `parent.subscription_details`, a Subscription's period on its items.
 */
export const STRIPE_API_VERSION_FLOOR = '2025-03-31.basil';

const num = (dflt: number) =>
  z
    .string()
    .optional()
    .transform((v) => (blank(v) ? dflt : Number(v!.trim())))
    .pipe(z.number().int());

const optionalNum = () =>
  z
    .string()
    .optional()
    .transform((v) => (blank(v) ? undefined : Number(v!.trim())))
    .pipe(z.number().int().min(0).optional());

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : v === 'true' || v === '1'));

/**
 * An optional secret. A blank one is absent, not empty.
 *
 * `.env` carried `GOOGLE_SESSION_SECRET=` — the key written, the value not —
 * and the fallback meant to cover that is
 * `cfg.GOOGLE_SESSION_SECRET ?? cfg.DEV_AUTH_SECRET`. `??` does not catch the
 * empty string, so the effective session signing key was `''`: every
 * Google-issued session signed with an empty secret, forgeable by anyone who
 * knows the token format. The storage signer has the same shape, where an
 * empty key means a download URL for any object can be minted.
 *
 * `bool` and `int` above already treat `''` as unset; plain `z.string()
 * .optional()` did not, so the two kinds of setting disagreed about what a
 * blank line in a .env file means. Whitespace counts as blank too — a key
 * someone "filled in" with a space is the same mistake wearing a coat.
 *
 * Production was never exposed: those checks use `!`, which does catch `''`,
 * and refuse to start. Every other environment was.
 */
const secret = () =>
  z
    .string()
    .optional()
    .transform((v) => {
      const t = v?.trim();
      return t ? t : undefined;
    });

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
  DEV_AUTH_SECRET: secret(),
  /** Restricts the dev sign-in; see auth/allowlist.ts. Empty = unrestricted. */
  DEV_LOGIN_ALLOWLIST: z.string().optional(),
  COGNITO_REGION: z.string().optional(),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_APP_CLIENT_ID: z.string().optional(),
  /** "Sign in with Google" (authorization code + PKCE; see auth/google.ts). */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: secret(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  /** Signing secret for Google-issued sessions; falls back to DEV_AUTH_SECRET outside production. */
  GOOGLE_SESSION_SECRET: secret(),
  /** Key material for encrypting TOTP secrets at rest. Falls back outside production. */
  MFA_ENCRYPTION_SECRET: secret(),
  /** Issuer shown in Google Authenticator. */
  MFA_ISSUER: z.string().default('YUHA'),
  /*
   * Staff accounts must carry a second factor.
   *
   * An operations console can compensate accounts, resolve rights cases and
   * read other people's orders, so a stolen staff password is a different
   * class of incident from a stolen customer password. Default on, and
   * production refuses to start with it off — the switch exists so a local
   * demo and the existing test suite can run without enrolling an
   * authenticator, not so it can be turned off where it matters.
   */
  ADMIN_MFA_REQUIRED: bool(true),

  /*
   * Stablecoin payments. Three switches, all off, and they stay off until the
   * business conclusions in docs/STABLECOIN_V1_PLAN.md are in hand — turning
   * one on is a decision about licensing, tax and terms, not a deployment
   * detail. Each currency has its own switch because JPYC and USDC differ in
   * what still has to be confirmed about them.
   *
   * Turning a switch OFF must not stop the scanner, pending fulfilment or
   * refunds; it closes the door to NEW payments only.
   */
  STABLECOIN_ENABLED: bool(false),
  STABLECOIN_JPYC_ENABLED: bool(false),
  STABLECOIN_USDC_ENABLED: bool(false),
  STABLECOIN_CHAIN_ID: num(137).pipe(z.number().int().positive()),
  STABLECOIN_RECEIVER_ADDRESS: z.string().optional(),
  /*
   * Two nodes, from two different companies.
   *
   * Two endpoints from one provider usually share a cluster and a view of the
   * chain, so "the nodes disagree" could never be true and the check that
   * rests on it would be a formality. Config cannot tell whose endpoint a URL
   * is, so this is enforced by the person setting it and written down in
   * docs/STABLECOIN_V1_PLAN.md — but identical URLs it CAN catch, and does.
   *
   * Secrets: they carry an API key. They belong in the deployment's secret
   * store and in a local .env, never in git.
   */
  POLYGON_RPC_PRIMARY_URL: z.string().optional(),
  POLYGON_RPC_SECONDARY_URL: z.string().optional(),
  /*
   * How far below the finalized head one eth_getLogs call may reach, and how
   * many blocks each pass re-reads.
   *
   * The span default is 450 rather than a round 500 because providers cap
   * eth_getLogs ranges and the caps differ by plan — one entry plan publishes
   * 500 — so the default has to sit below the lower of the two in use. Set it
   * from the actual caps once both providers are known.
   */
  STABLECOIN_SCAN_MAX_SPAN: num(450).pipe(z.number().int().min(1).max(10_000)),
  STABLECOIN_SCAN_OVERLAP: num(32).pipe(z.number().int().min(0).max(1_000)),
  STABLECOIN_SCAN_START_BLOCK: optionalNum(),
  STABLECOIN_QUOTE_TTL_SECONDS: num(600).pipe(z.number().int().min(60).max(3600)),
  /*
   * How long after a quote expires its payment slot is still held.
   *
   * Not a courtesy. A payment is only SEEN once its block is finalized and the
   * next scan pass reads it, so a payment made inside the quote window is
   * routinely first observed a minute or two after the window closed. Closing
   * the intent on the deadline turned those on-time payments into money from a
   * wallet with nothing open — paid in time, nothing delivered, no automatic
   * repair. The floor is finality plus one scan interval; the default is fifteen
   * minutes, because the cost of waiting is a held wallet slot and the cost of
   * not waiting is somebody's money.
   */
  STABLECOIN_INTENT_GRACE_SECONDS: num(900).pipe(z.number().int().min(60).max(86_400)),
  /*
   * The whitelist/receiver/rule version stamped onto every quote. Bump it when
   * any of those change, so an existing order keeps being verified against the
   * rules it was quoted under.
   */
  STABLECOIN_CONFIG_VERSION: num(1).pipe(z.number().int().positive()),

  // --- text model (TokenStars) -------------------------------------------
  TEXT_ADAPTER: z.enum(['local', 'tokenstars']).optional(),
  TOKENSTARS_BASE_URL: z.string().optional(),
  TOKENSTARS_API_KEY: secret(),
  TOKENSTARS_MODEL_ID: z.string().optional(),
  TOKENSTARS_CHAT_PATH: z.string().optional(),
  TOKENSTARS_REQUEST_ID_HEADER: z.string().optional(),
  TOKENSTARS_STRUCTURED_OUTPUTS: bool(false),
  TOKENSTARS_TIMEOUT_MS: int(20_000),
  TOKENSTARS_COST_MINOR_PER_REQUEST: int(1),
  /** Written lyrics: about one short line per this many seconds (2-10, default 4.5). */
  LYRIC_SECONDS_PER_LINE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 4.5 : Number(v)))
    .pipe(z.number().min(2).max(10)),

  // --- music provider -----------------------------------------------------
  /** 'glm' = the GLM preset over the generic HTTP adapter (music/glm.ts). */
  MUSIC_ADAPTER: z.enum(['demo', 'glm', 'http']).optional(),
  MUSIC_PROVIDER_ID: z.string().optional(),
  MUSIC_BASE_URL: z.string().optional(),
  MUSIC_API_KEY: secret(),
  MUSIC_MODEL: z.string().optional(),
  MUSIC_CONTRACT_VERSION: z.string().optional(),
  MUSIC_LICENSE_VERSION: z.string().optional(),
  MUSIC_SUBMIT_PATH: z.string().optional(),
  MUSIC_POLL_PATH: z.string().optional(),
  MUSIC_CANCEL_PATH: z.string().optional(),
  MUSIC_REQUEST_ID_FIELD: z.string().optional(),
  MUSIC_STATUS_FIELD: z.string().optional(),
  MUSIC_AUDIO_URL_FIELD: z.string().optional(),
  /**
   * `from-origin=>to-origin` for an audio link whose host only resolves on the
   * provider's own network. Optional, and inert unless the advertised origin
   * matches the left-hand side exactly.
   */
  MUSIC_AUDIO_URL_REWRITE: z.string().optional(),
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
  STORAGE_SIGNING_SECRET: secret(),
  S3_REGION: z.string().optional(),
  S3_QUARANTINE_BUCKET: z.string().optional(),
  S3_DELIVERY_BUCKET: z.string().optional(),
  S3_KMS_KEY_ID: secret(),
  DOWNLOAD_URL_TTL_SECONDS: int(300),

  // --- queue --------------------------------------------------------------
  QUEUE_ADAPTER: z.enum(['local', 'sqs']).optional(),
  QUEUE_NAME: z.string().default('loopscene-generation'),
  SQS_QUEUE_URL: z.string().optional(),
  SQS_REGION: z.string().optional(),

  // --- payments -----------------------------------------------------------
  PAYMENTS_ADAPTER: z.enum(['simulated', 'stripe']).optional(),

  // ---- outbound email. SES, SendGrid and Resend all speak SMTP, so the
  // choice between them is an account decision and not one this code makes.
  EMAIL_ADAPTER: z.enum(['log', 'smtp', 'ses']).optional(),
  /** The From: header, e.g. `YUHA <no-reply@yuha.studio>`. */
  EMAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587),
  /** Implicit TLS (465). Leave false for STARTTLS on 587; never send plaintext. */
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /**
   * SES through its own API. No key or secret here on purpose: the cluster has
   * IRSA, so the pod's role is the credential and there is nothing to store.
   */
  SES_REGION: z.string().optional(),
  /** Optional SES configuration set, for bounce and complaint events. */
  SES_CONFIGURATION_SET: z.string().optional(),
  STRIPE_SECRET_KEY: secret(),
  STRIPE_WEBHOOK_SECRET: secret(),
  STRIPE_PUBLISHABLE_KEY: secret(),
  /**
   * The Stripe API version every request and every webhook payload is pinned
   * to. Checked for shape and floor against `STRIPE_API_VERSION_FLOOR`. Required in production — see the check in `validate`. Unset falls back
   * to whatever the installed SDK pins, which is a dependency bump away from
   * changing the shape of live events.
   */
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
  ALIGNMENT_API_KEY: secret(),
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
  /**
   * Where the aligner can find a song's audio, with `{id}` standing for the
   * music provider's request id — e.g. http://10.5.0.7:8583/v1/audio/{id}.mp3
   * for a self-hosted model that keeps its renders. Unset, the http aligner
   * has no audio to work from and every song keeps the estimated timeline.
   */
  ALIGNMENT_AUDIO_URL_TEMPLATE: z.string().optional(),

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
  /*
   * How much one account may buy in a rolling day, and how many orders it may
   * start.
   *
   * docs/FRAUD_PREVENTION.md ticked "velocity / amount limits per account" on
   * the strength of the two limits above, and said so plainly in its own
   * "what is still not true" section: those cap generation and export, which
   * protect CAPACITY. A stolen card buying forty DROP packs in an hour met no
   * limit at all, on the channel that carries every payment today.
   *
   * Two numbers because the two abuses look different. A stolen card that
   * works is VALUE — few orders, each one real money. Card testing is COUNT —
   * many attempts, most of them declined, which a value cap never sees
   * because nothing is ever paid.
   *
   * The value default is deliberately generous: ¥50,000 a day is fifty DROP
   * packs, which no real customer reaches and a card thief does. A cap that
   * stops a genuine purchase is its own kind of failure, so the number is set
   * where the damage is bounded rather than where abuse begins. Zero switches
   * either cap off, which is what a deployment with no card channel wants.
   *
   * A rolling window, not a calendar day: a cap that resets at midnight is a
   * cap with a known gap in it.
   */
  PURCHASE_CAP_JPY_PER_DAY: int(50_000),
  PURCHASE_CAP_ORDERS_PER_DAY: int(20),
  /*
   * Holding a paid card order until a person has looked at it.
   *
   * ⑥ in docs/FRAUD_PREVENTION.md was real for the stablecoin channel and
   * absent for the card one. What is held is DELIVERY, never the payment:
   * Stripe has taken it already, and the thing that cannot be undone is the
   * song someone downloaded, not the charge.
   *
   * The thresholds are set so that almost nothing is held, because a hold on a
   * legitimate purchase is a customer who paid and got nothing — at this scale
   * the worse of the two failures. A brand-new account spending ¥5,000 in its
   * first hour is roughly five DROP packs before anything has been listened
   * to; ten orders started in a day is where a person would have begun to
   * wonder, while the purchase cap stops the twentieth.
   *
   * Zero switches a signal off individually; CARD_REVIEW_ENABLED=false stops
   * all of it, which is what a deployment with no card channel wants.
   */
  CARD_REVIEW_ENABLED: bool(true),
  CARD_REVIEW_NEW_ACCOUNT_MINUTES: int(60),
  CARD_REVIEW_NEW_ACCOUNT_VALUE_MINOR: int(5_000),
  CARD_REVIEW_VELOCITY_ORDERS: int(10),

  // --- generation tuning --------------------------------------------------
  JOB_LEASE_SECONDS: int(90),
  JOB_DELAY_WARNING_SECONDS: int(180),
  JOB_VERIFY_DEADLINE_SECONDS: int(900),
  /*
   * How long a job may sit in a state where the provider has accepted it —
   * SUBMITTED or PROCESSING — before it is failed and the credit released.
   *
   * There was no such deadline. The only sweeper covers UNKNOWN, `pollJob`
   * returns on `pending` without touching the row, and SUBMITTED has no
   * transition to CANCELLED, so a provider that accepted a job and then lost
   * it left the reservation held and the job non-terminal for good. With
   * MAX_CONCURRENT_JOBS_PER_USER at 2, two of those end the account's ability
   * to generate anything, ever, with no path back for the user or an
   * operator — and `expireBatches` skips a batch with `reserved_units > 0`,
   * so the rest of the pack never expires either.
   *
   * An hour is well past any real generation (minutes, for up to four minutes
   * of audio) so a slow-but-working job is never raced, and it bounds the
   * lockout at an hour instead of forever.
   */
  JOB_UPSTREAM_DEADLINE_SECONDS: int(3600),
  AUDIO_DURATION_TOLERANCE_MS: int(750),
  /**
   * How long a song the owner deleted stays recoverable before its audio is
   * really removed.
   *
   * A soft delete has always kept the file — that is what makes deleting the
   * wrong song survivable — and nothing ever came back for it, so every song
   * anyone ever deleted is still stored. 90 days is the product's answer to
   * "how long is a mistake fixable", decided rather than inherited; 0 disables
   * the sweep for an operator who wants to keep everything.
   */
  TRACK_RETENTION_DAYS: int(90),
  AUDIO_MIN_MEAN_VOLUME_DB: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? -45 : Number.parseFloat(v))),
  AUDIO_MIN_BYTES: int(8_000),
  EXPIRED_BATCH_COMPENSATION_DAYS: int(30),

  // --- credits an operator gives away -----------------------------------
  /*
   * A credit is a generation, and a generation is provider cost. So an
   * operator who can gift without limit can spend real money without limit,
   * and the three numbers below are what bounds that rather than trust.
   *
   * The per-gift cap is the typing-mistake guard: 500 instead of 50 is one
   * keystroke. The daily cap is the account-compromise guard, and it is the
   * one that matters — a per-gift cap alone bounds nothing, because fifty
   * gifts of fifty is still two and a half thousand. The validity is so a
   * giveaway clears off the books instead of sitting there as a liability
   * nobody remembers agreeing to.
   */
  /** Most units one gift may carry. **0 switches gifting off entirely.** */
  ADMIN_GRANT_MAX_UNITS: int(100),
  /**
   * Most units one operator may give away in a rolling day.
   *
   * **0 means NO DAILY LIMIT**, not "no gifting" — the opposite of the zero
   * above it, which is why this says so twice. The two were documented with
   * the same four words ("0 disables"), and `docs/OPERATIONS.md` calls this
   * the limit that matters if an operator account is compromised: the one
   * setting somebody would reach for to tighten it instead removed it.
   * Negative values are refused in `validate` rather than quietly meaning the
   * same thing.
   */
  ADMIN_GRANT_MAX_UNITS_PER_DAY: int(500),
  /**
   * How long gifted credits last, in days, and the ceiling an operator may
   * narrow to. Must be at least 1: zero made every gift fail with "validity
   * must be between 1 and 0 days".
   */
  ADMIN_GRANT_VALIDITY_DAYS: int(90),
  /**
   * Most units one operator may compensate in a rolling day. 0 means no daily
   * limit, as above.
   *
   * Compensation is capped at 20 per call and was capped at nothing per day,
   * while the gift path's daily cap was described as the protection against a
   * compromised operator account. Bounded per call is not bounded: twenty at a
   * time, repeated, is unbounded, and compensation is open to `support` where
   * gifting is not. Set higher than the gift allowance because a real outage
   * means compensating many people at once.
   */
  ADMIN_COMPENSATION_MAX_UNITS_PER_DAY: int(2000),

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
    /**
     * `log` writes the notice and delivers nothing. It is the default
     * everywhere but production, so eight colleagues testing the office build
     * cannot be emailed by accident and a deploy needs no mail account.
     */
    email: 'log' | 'smtp' | 'ses';
  };
  alignment: 'estimated' | 'http';
  legalEntityConfigured: boolean;
}

/** Defaults per mode. An explicit env var may narrow these, never widen them. */
const MODE_DEFAULT_ADAPTERS: Record<RunMode, AppConfig['adapters']> = {
  demo: { auth: 'dev', text: 'local', music: 'demo', storage: 'local', queue: 'local', payments: 'simulated', email: 'log' },
  integration: {
    auth: 'dev',
    text: 'local',
    music: 'demo',
    storage: 'local',
    queue: 'local',
    payments: 'simulated',
    email: 'log',
  },
  production: {
    auth: 'cognito',
    text: 'tokenstars',
    music: 'glm',
    storage: 's3',
    queue: 'sqs',
    payments: 'stripe',
    email: 'ses',
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

type MysqlCredentials = {
  host?: string;
  port?: number | string;
  username?: string;
  password?: string;
  dbname?: string;
  database?: string;
};

function databaseUrlFromFile(): string | undefined {
  const file =
    process.env.DATABASE_SECRET_FILE ?? join(process.cwd(), 'secrets', 'mysql-credentials.json');
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as MysqlCredentials;
    const host = value.host ?? process.env.DATABASE_HOST;
    const port = value.port ?? process.env.DATABASE_PORT ?? 3306;
    const database = value.dbname ?? value.database ?? process.env.DATABASE_NAME;
    if (!host || !value.username || value.password === undefined || !database) return undefined;
    return `mysql://${encodeURIComponent(value.username)}:${encodeURIComponent(value.password)}@${host}:${port}/${encodeURIComponent(database)}`;
  } catch {
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configEnv = { ...env };
  if (!configEnv.DATABASE_URL) {
    const databaseUrl = databaseUrlFromFile();
    if (databaseUrl) configEnv.DATABASE_URL = databaseUrl;
  }
  const parsed = envSchema.safeParse(configEnv);
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
    email: e.EMAIL_ADAPTER ?? defaults.email,
  };

  const problems: string[] = [];

  // ---- production must not contain any development affordance (SEC-03) ----
  if (mode === 'production') {
    if (adapters.auth === 'dev') problems.push('production mode cannot use the dev auth adapter');
    if (adapters.music === 'demo') problems.push('production mode cannot use the demo (fake) music adapter');
    if (adapters.payments !== 'stripe') problems.push('production mode cannot use simulated payments');
    if (!e.ADMIN_MFA_REQUIRED) problems.push('production mode cannot disable the staff second factor');
    if (adapters.email === 'log') {
      problems.push(
        'production mode cannot use the log email adapter: it delivers nothing, and the sign-in ' +
          'and account-change notices are a fraud measure this business has declared',
      );
    }
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
    if (!e.GOOGLE_REDIRECT_URI) {
      problems.push('GOOGLE_REDIRECT_URI is required for the google auth adapter');
    }
  } else if (!e.DEV_AUTH_SECRET) {
    problems.push('DEV_AUTH_SECRET is required for the dev auth adapter');
  }

  /*
   * The Google flow is gated on CREDENTIALS, not on the adapter — so its
   * checks have to be too.
   *
   * `routes/auth.ts` registers `/v1/auth/google/*` whenever the three
   * variables are present, deliberately, "so Sign in with Google can coexist
   * with the dev login in integration mode". Every check below used to live
   * inside `adapters.auth === 'google'`, which means the configuration
   * `.env.example` itself ships — `AUTH_ADAPTER=dev` with the three Google
   * values filled — had a live OAuth endpoint and no validation of any of it.
   * The redirect-URI check was written to make a wrong value impossible to
   * deploy and was absent in the most common way to run the flow.
   *
   * Worse for the session secret: `stateSecret()` is
   * `GOOGLE_SESSION_SECRET ?? DEV_AUTH_SECRET ?? ''`, and production forbids
   * `DEV_AUTH_SECRET`. With a non-google adapter in production the secret
   * check did not run, so the OAuth `state` would have been signed with the
   * empty string — forgeable — which is the exact defect
   * `tests/blank-secrets.test.ts` exists for, one layer along.
   */
  const googleRedirect = e.GOOGLE_REDIRECT_URI;
  const googleFlowLive = !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && googleRedirect);
  if (googleFlowLive && googleRedirect) {
    {
      /*
       * Checked for shape, not just presence — because the failure mode has
       * no logs.
       *
       * Google compares `redirect_uri` against its registered list byte for
       * byte and answers `redirect_uri_mismatch` on its own page, before the
       * request reaches us. Nothing is written anywhere on our side; the only
       * evidence is the address bar. So the two plausible mistakes are worth
       * refusing at start-up, where the message can name them:
       *
       *   - the SPA's path (`/auth/google/callback`) instead of the API's.
       *     That route exists and is part of the flow — it is where we send
       *     the browser afterwards with a one-time code — so it reads like
       *     the callback;
       *   - a host carried over from the previous deployment. The variable is
       *     an absolute URL because Google needs the origin, so moving
       *     environments means every copy of it is stale.
       */
      let parsed: URL | null = null;
      try {
        parsed = new URL(googleRedirect);
      } catch {
        problems.push(`GOOGLE_REDIRECT_URI must be an absolute URL (got "${googleRedirect}")`);
      }
      if (parsed) {
        /*
         * A query string or a fragment is a different URI to Google, which
         * compares the whole thing byte for byte — so
         * `…/callback?env=prod` passes every other check here and then fails
         * at Google with the logless mismatch this block exists to prevent.
         */
        if (parsed.search || parsed.hash) {
          problems.push(
            'GOOGLE_REDIRECT_URI must carry no query string and no fragment — Google compares the whole URI byte for byte',
          );
        }
        if (parsed.pathname !== GOOGLE_CALLBACK_PATH) {
          problems.push(
            `GOOGLE_REDIRECT_URI must end in ${GOOGLE_CALLBACK_PATH} (got "${parsed.pathname}")` +
              (parsed.pathname === GOOGLE_WEB_RETURN_PATH
                ? ' — that is the web app\'s own return path, which Google must never be given'
                : ''),
          );
        }
        if (mode === 'production' && parsed.protocol !== 'https:') {
          problems.push('GOOGLE_REDIRECT_URI must be https in production');
        }
        /*
         * And it must be OUR api's origin. `PUBLIC_API_URL` is what the
         * deployment says the API is reachable at, so a redirect URI pointing
         * somewhere else is either a stale host or the web origin — and the
         * second one is the mistake above wearing a different hat, since the
         * SPA and the API can share a hostname.
         */
        const apiOrigin = new URL(e.PUBLIC_API_URL).origin;
        if (parsed.origin !== apiOrigin) {
          problems.push(
            `GOOGLE_REDIRECT_URI points at ${parsed.origin} but PUBLIC_API_URL says the API is at ${apiOrigin} — it must be ${apiOrigin}${GOOGLE_CALLBACK_PATH}`,
          );
        }
      }
    }
    if (mode === 'production' && !e.GOOGLE_SESSION_SECRET) {
      problems.push('GOOGLE_SESSION_SECRET is required whenever the Google sign-in is configured in production');
    }
  }

  /*
   * The email adapter's requirements were nested INSIDE the tokenstars block.
   *
   * A brace in the wrong place, so with any non-TokenStars text adapter none
   * of `SES_REGION`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_USER` or `SMTP_PASS` was
   * checked at all — a deployment with `EMAIL_ADAPTER=ses` and no region
   * started happily and silently could not send the sign-in and
   * account-change notices this same file calls "a fraud measure this
   * business has declared". Two adapter checks that could not fail, which is
   * the shape CLAUDE.md records as this repository's recurring defect.
   */
  if (adapters.email === 'ses') {
    if (!e.SES_REGION) problems.push('SES_REGION is required for the ses email adapter');
    if (!e.EMAIL_FROM) problems.push('EMAIL_FROM is required for the ses email adapter');
  }

  if (adapters.email === 'smtp') {
    if (!e.SMTP_HOST) problems.push('SMTP_HOST is required for the smtp email adapter');
    if (!e.SMTP_USER) problems.push('SMTP_USER is required for the smtp email adapter');
    if (!e.SMTP_PASS) problems.push('SMTP_PASS is required for the smtp email adapter');
    if (!e.EMAIL_FROM) problems.push('EMAIL_FROM is required for the smtp email adapter');
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
    /*
     * Every product in the catalogue, not the two somebody remembered.
     *
     * `createCheckout` throws "product X has no Stripe price id configured" at
     * the moment a customer clicks buy — so a missing id was not a boot
     * failure but a 500 on the one page that takes money, found by whoever
     * tried to buy a licence first. All four products are live in the Stripe
     * dashboard (DROP, Licence, CREATOR, STUDIO); the list below is the same
     * four, and `tests/stripe-webhook-path.test.ts` holds a scripted
     * invariant that `catalogue.ts` and this list name the same set, because
     * the next product added is the next one to be missing here.
     *
     * Note what is NOT required unconditionally: the two subscription ids are
     * needed only when `FEATURE_SUBSCRIPTIONS_ENABLED`, because a deployment
     * with subscriptions closed cannot sell them. Anything that checks these
     * ids has to know that — the Stripe price check in `seed.ts` treated a
     * missing id as fatal and so refused to seed the documented
     * stripe-with-subscriptions-off configuration.
     */
    if (!e.STRIPE_PRICE_ID_DROP_5) problems.push('STRIPE_PRICE_ID_DROP_5 is required for the stripe payments adapter');
    if (!e.STRIPE_PRICE_ID_MARKET_LICENSE) {
      problems.push('STRIPE_PRICE_ID_MARKET_LICENSE is required for the stripe payments adapter (the market licence is on sale and has no feature switch)');
    }
    if (e.FEATURE_SUBSCRIPTIONS_ENABLED && !e.STRIPE_PRICE_ID_PRO_MONTHLY) {
      problems.push('STRIPE_PRICE_ID_PRO_MONTHLY is required when subscriptions are enabled');
    }
    if (e.FEATURE_SUBSCRIPTIONS_ENABLED && !e.STRIPE_PRICE_ID_PREMIER_MONTHLY) {
      problems.push('STRIPE_PRICE_ID_PREMIER_MONTHLY is required when subscriptions are enabled');
    }
    /*
     * The webhook secret is a shape we can check without knowing the value.
     *
     * Endpoint secrets are `whsec_...`. The two things most easily pasted into
     * this variable instead are the restricted API key (`rk_...`) and the
     * secret key (`sk_...`), and both produce a signature that never verifies
     * — which surfaces as every event rejected with 400 and looks, from the
     * Stripe dashboard, exactly like our server being broken. Checking the
     * prefix costs nothing and never reveals the secret: no value is pushed
     * into the problem text here or anywhere else.
     */
    if (e.STRIPE_WEBHOOK_SECRET && !e.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
      problems.push('STRIPE_WEBHOOK_SECRET does not look like a Stripe endpoint signing secret (expected a whsec_ prefix)');
    }
    /*
     * The API version is a deployment decision in production, not a default.
     *
     * The event payloads this code reads depend on it: an Invoice's
     * subscription moved under `parent.subscription_details` and a
     * Subscription's period moved onto its items, both handled in
     * services/webhooks.ts, both version-dependent. Left unset, the version is
     * whatever this SDK happens to pin — 2025-02-24.acacia today — so a
     * routine `stripe` bump would silently change the shape of every live
     * event. It also has to be 2025-03-31.basil or greater for an account with
     * Managed Payments, which is only discovered by a failing live checkout.
     */
    if (mode === 'production' && !e.STRIPE_API_VERSION) {
      problems.push('STRIPE_API_VERSION must be set explicitly in production (the webhook payload shape depends on it; 2025-03-31.basil is the version this code is written against)');
    }
    /*
     * And it has to be a version, not a string.
     *
     * Requiring only that the variable is non-empty would accept `basil`, or
     * `2024-06-20` — a version older than the Checkout minimum, which fails at
     * the first live purchase and nowhere earlier. Stripe's versions are
     * date-ordered with a codename suffix, so the date compares
     * lexicographically and `STRIPE_API_VERSION_FLOOR` is the one this code is
     * written against. Newer is allowed and unverified: the SDK's types are
     * generated against its own version, so a newer account version is a
     * deliberate choice somebody makes, not an accident this check should
     * block.
     */
    if (e.STRIPE_API_VERSION) {
      const shape = /^(\d{4}-\d{2}-\d{2})(\.[a-z]+)?$/.exec(e.STRIPE_API_VERSION.trim());
      if (!shape) {
        problems.push(
          `STRIPE_API_VERSION is not a Stripe API version (expected YYYY-MM-DD or YYYY-MM-DD.codename, e.g. ${STRIPE_API_VERSION_FLOOR})`,
        );
      } else if (shape[1]! < STRIPE_API_VERSION_FLOOR.slice(0, 10)) {
        problems.push(
          `STRIPE_API_VERSION ${e.STRIPE_API_VERSION} is older than ${STRIPE_API_VERSION_FLOOR}, which Checkout requires on an account with Managed Payments and which this code's webhook handling is written against`,
        );
      }
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
  /*
   * A negative limit is not a smaller limit.
   *
   * `int()` accepts any integer, and every one of these is compared with
   * `> 0` to decide whether it applies — so `-1` reads as "no limit", which
   * is the opposite of what anybody typing a minus sign intends. Refused by
   * name rather than clamped, because clamping would hide the typo.
   */
  /*
   * The message has to say what 0 means for THAT key, because it means
   * opposite things: 0 on the per-gift cap switches gifting off, 0 on either
   * daily total removes the limit. A single message saying "0 is the
   * documented way to switch it off" sent anybody who hit it on the daily cap
   * towards removing the cap — which `docs/OPERATIONS.md` calls the limit that
   * matters if an operator account is compromised.
   */
  for (const [key, zeroMeans] of [
    ['ADMIN_GRANT_MAX_UNITS', 'switches gifting off entirely'],
    ['ADMIN_GRANT_MAX_UNITS_PER_DAY', 'removes the daily limit'],
    ['ADMIN_COMPENSATION_MAX_UNITS_PER_DAY', 'removes the daily limit'],
  ] as const) {
    if (e[key] < 0) problems.push(`${key} cannot be negative (0 ${zeroMeans})`);
  }
  if (e.ADMIN_GRANT_VALIDITY_DAYS < 1) {
    problems.push('ADMIN_GRANT_VALIDITY_DAYS must be at least 1 — zero makes every gift impossible rather than permanent');
  }

  if (e.STABLECOIN_ENABLED) {
    if (!e.STABLECOIN_RECEIVER_ADDRESS) {
      problems.push('STABLECOIN_RECEIVER_ADDRESS is required when stablecoin payments are enabled');
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(e.STABLECOIN_RECEIVER_ADDRESS)) {
      problems.push('STABLECOIN_RECEIVER_ADDRESS is not an Ethereum address');
    }
    if (!e.STABLECOIN_JPYC_ENABLED && !e.STABLECOIN_USDC_ENABLED) {
      problems.push('stablecoin payments are enabled but no currency is');
    }
    /*
     * Both nodes are required, and they must not be the same URL.
     *
     * One node cannot disagree with itself, so a single endpoint used twice
     * turns "hold when the nodes disagree" into a line that always passes —
     * the exact shape of check this project keeps finding in its own work.
     * Whether two different URLs are really two different companies is not
     * something config can see; that one is on the person setting it.
     */
    if (!e.POLYGON_RPC_PRIMARY_URL || !e.POLYGON_RPC_SECONDARY_URL) {
      problems.push('stablecoin payments need POLYGON_RPC_PRIMARY_URL and POLYGON_RPC_SECONDARY_URL');
    } else if (e.POLYGON_RPC_PRIMARY_URL === e.POLYGON_RPC_SECONDARY_URL) {
      problems.push('the two Polygon RPC URLs are identical; a node cannot disagree with itself');
    }
    /*
     * USDC needs a rate source and there is no fallback by design: quoting it
     * from a hardcoded number would charge a customer the wrong amount for a
     * product priced in yen. Until the provider is implemented and its usage
     * rights confirmed, enabling USDC is refused rather than approximated.
     */
    if (e.STABLECOIN_USDC_ENABLED) {
      problems.push('USDC is not quotable yet: no rate provider is implemented (see docs/STABLECOIN_V1_PLAN.md)');
    }
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
