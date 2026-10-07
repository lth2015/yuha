import { z } from 'zod';
import { RunMode, UserRole } from './enums.js';

export const meView = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: UserRole,
  ageConfirmed: z.boolean(),
  marketingOptIn: z.boolean(),
  /** Credit balance snapshot so every screen can show it without a second call. */
  creditsAvailable: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type MeView = z.infer<typeof meView>;

/**
 * Public runtime descriptor. The web app renders the demo banner from this and
 * disables anything the current mode does not actually support (§3.1).
 * It carries no secrets — only publishable configuration.
 */
export const runtimeInfo = z.object({
  mode: RunMode,
  demo: z.boolean(),
  /**
   * True only when songs come from the built-in synthetic generator. Demo run
   * mode and synthetic audio used to be read as one thing, so a demo-mode
   * deployment wired to a real model (the DGX intranet build) labelled every
   * real song 「音频为合成示例」.
   */
  syntheticAudio: z.boolean(),
  features: z.object({
    subscriptionsEnabled: z.boolean(),
    freeTrialEnabled: z.boolean(),
    /**
     * How many credits a new account actually receives. The pricing page used
     * to hard-code "2"; an operator lowering FREE_TRIAL_UNITS would have made
     * that page state a number the product does not honour.
     */
    freeTrialUnits: z.number().int().nonnegative(),
    wavExportEnabled: z.boolean(),
    commercialDeliveryEnabled: z.boolean(),
    realPaymentsEnabled: z.boolean(),
    /**
     * This deployment accepts Alipay and WeChat Pay. Declarative only — the
     * methods are enabled on the Stripe account, and this just lets the
     * pricing page say so before a buyer clicks through. One-time purchases
     * only: both are single-use and cannot back a subscription.
     */
    qrWalletsEnabled: z.boolean(),
  }),
  adapters: z.object({
    auth: z.string(),
    text: z.string(),
    music: z.string(),
    storage: z.string(),
    queue: z.string(),
    payments: z.string(),
  }),
  /** Publishable Stripe key when Stripe is wired; never a secret key. */
  stripePublishableKey: z.string().nullable(),
  /** Legal entity disclosure state; "placeholder" is not allowed in production. */
  legalEntityConfigured: z.boolean(),
  /**
   * The stablecoin channel, as configured.
   *
   * The interface must not offer a payment method the running configuration
   * does not have, and it must not carry its own copy of a chain id or a
   * token address: both decide where money goes. `tokens` is empty and
   * `enabled` false on every deployment where the switches are off, which is
   * all of them until the business conclusions in
   * docs/STABLECOIN_V1_PLAN.md are in hand.
   *
   * `decimals` here is for labels only. The amount a customer is asked to pay
   * is always rendered from the decimals on the QUOTE, which is the number the
   * server computed that amount with and which the startup check compared
   * against the contract itself.
   */
  stablecoin: z.object({
    enabled: z.boolean(),
    chainId: z.number().int().positive(),
    tokens: z.array(
      z.object({
        key: z.enum(['jpyc', 'usdc']),
        address: z.string(),
        decimals: z.number().int().nonnegative(),
        label: z.string(),
      }),
    ),
  }),
  /** Login methods the web app should render. */
  authMethods: z.object({
    dev: z.boolean(),
    google: z.boolean(),
    googleConfigured: z.boolean(),
    cognito: z.boolean(),
  }),
});
export type RuntimeInfo = z.infer<typeof runtimeInfo>;

export const projectView = z.object({
  projectId: z.string().uuid(),
  title: z.string(),
  scene: z.string(),
  trackCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/** Idempotency key header used by POST /v1/generations and /v1/checkout. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/*
 * The message matters as much as the rule. A 7-character key — `ret-old`,
 * say — answered "a valid idempotency-key header is required", which names no
 * constraint at all; two of my own tests died on it and the error told me
 * nothing. Zod's own text is more use than the generic line the route prints.
 */
export const idempotencyKeySchema = z
  .string()
  .min(8, 'idempotency-key must be at least 8 characters')
  .max(128, 'idempotency-key must be at most 128 characters')
  .regex(/^[A-Za-z0-9._:-]+$/, 'idempotency-key may use letters, digits and . _ : - only');

/**
 * A crash reported by the browser.
 *
 * Deliberately narrow. The error boundary makes a crash *look* handled, which
 * means nobody complains about it any more — so something has to record it, and
 * what gets recorded has to be safe to keep.
 *
 * `route` is a normalised path (`/song/:id`), never `location.href`: the query
 * string on this product carries drafts and edit targets. There is no user id,
 * no user agent and no full stack. §11.1 applies to this as to every other
 * analytics event — never the raw prompt, the email address or any card data.
 */
export const clientErrorReport = z.object({
  /** The thrown message, truncated client-side. */
  message: z.string().trim().min(1).max(300),
  /** Path with ids collapsed, so the same crash groups across users. */
  route: z.string().trim().max(120),
  /** The nearest component name from the React stack, if one was readable. */
  component: z.string().trim().max(80).nullable().default(null),
  lang: z.string().trim().max(8).nullable().default(null),
});
export type ClientErrorReport = z.infer<typeof clientErrorReport>;

/**
 * "Somebody actually listened to this song."
 *
 * Reported once per song per page load, after ten seconds of audio has really
 * been heard — the activation metric in `reporting.ts` reads
 * `analytics_events` for `preview_10s`, and it is the difference between
 * knowing a song was generated and knowing it was worth hearing.
 *
 * The body is one id. No position, no dwell time, nothing about the listener:
 * the question this answers is yes/no, and anything more would be data we
 * collected because we could.
 */
export const previewReport = z.object({
  trackId: z.string().uuid(),
});
export type PreviewReport = z.infer<typeof previewReport>;
