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
export const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
