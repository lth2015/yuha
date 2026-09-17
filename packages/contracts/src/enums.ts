import { z } from 'zod';

/**
 * Runtime mode. PROJECT_TASK.md §3.1 — three explicit modes, never a soup of
 * booleans that can contradict each other. The API refuses to boot when the
 * mode and the adapter selection disagree.
 */
export const RunMode = z.enum(['demo', 'integration', 'production']);
export type RunMode = z.infer<typeof RunMode>;

/** Generation job state machine. PROJECT_TASK.md §6.1 / design doc §25. */
export const JobState = z.enum([
  'VALIDATING',
  'RESERVED',
  'QUEUED',
  'SUBMITTED',
  'UNKNOWN',
  'PROCESSING',
  'DELIVERED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
]);
export type JobState = z.infer<typeof JobState>;

export const TERMINAL_JOB_STATES: readonly JobState[] = ['DELIVERED', 'FAILED', 'REJECTED', 'CANCELLED'];

/** States from which the job has (or may have) reached the upstream provider. */
export const UPSTREAM_ENGAGED_STATES: readonly JobState[] = ['SUBMITTED', 'UNKNOWN', 'PROCESSING'];

export function isTerminal(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

/**
 * Legal state transitions. Anything not listed here is rejected by the
 * repository layer, so a buggy worker cannot walk a delivered job backwards.
 */
export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  VALIDATING: ['RESERVED', 'FAILED', 'REJECTED'],
  RESERVED: ['QUEUED', 'FAILED', 'REJECTED', 'CANCELLED'],
  // REJECTED is reachable from QUEUED because a provider can refuse the request
  // at submission time, before it ever reaches SUBMITTED.
  QUEUED: ['SUBMITTED', 'UNKNOWN', 'FAILED', 'REJECTED', 'CANCELLED', 'QUEUED'],
  SUBMITTED: ['PROCESSING', 'UNKNOWN', 'FAILED', 'REJECTED', 'SUBMITTED'],
  UNKNOWN: ['PROCESSING', 'SUBMITTED', 'DELIVERED', 'FAILED', 'REJECTED', 'UNKNOWN'],
  PROCESSING: ['DELIVERED', 'FAILED', 'REJECTED', 'UNKNOWN', 'PROCESSING'],
  DELIVERED: [],
  FAILED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return (JOB_TRANSITIONS[from] ?? []).includes(to);
}

/** Coarse phase shown to the user. UI-04 forbids a fake precise percentage. */
export const JobPhase = z.enum(['validating', 'queued', 'generating', 'processing', 'verifying', 'done', 'failed']);
export type JobPhase = z.infer<typeof JobPhase>;

export const JOB_STATE_TO_PHASE: Record<JobState, JobPhase> = {
  VALIDATING: 'validating',
  RESERVED: 'validating',
  QUEUED: 'queued',
  SUBMITTED: 'generating',
  UNKNOWN: 'verifying',
  PROCESSING: 'processing',
  DELIVERED: 'done',
  FAILED: 'failed',
  REJECTED: 'failed',
  CANCELLED: 'failed',
};

/** Launch scenes. Night + daily-life first, outfit/gaming as comparison templates. */
export const Scene = z.enum(['night_walk', 'daily_log', 'outfit', 'gaming']);
export type Scene = z.infer<typeof Scene>;

export const SCENES: readonly Scene[] = ['night_walk', 'daily_log', 'outfit', 'gaming'];

export const Mood = z.enum(['calm', 'dreamy', 'warm', 'melancholic', 'confident', 'playful', 'tense', 'uplifting']);
export type Mood = z.infer<typeof Mood>;

export const TempoHint = z.enum(['slow', 'medium', 'fast']);
export type TempoHint = z.infer<typeof TempoHint>;

/**
 * Instrumental-only was the 2026-09 MVP scope; the product now also generates
 * sung songs. The value stays explicit in every stored record and in every
 * upstream request, rather than being an unstated assumption a provider
 * default could silently flip.
 */
export const VocalMode = z.enum(['instrumental', 'with_vocals']);
export type VocalMode = z.infer<typeof VocalMode>;

/** Whether a delivered song appears on the public Explore feed. */
export const Visibility = z.enum(['private', 'public']);
export type Visibility = z.infer<typeof Visibility>;

export const AudioFormat = z.enum(['mp3', 'wav']);
export type AudioFormat = z.infer<typeof AudioFormat>;

export const AssetKind = z.enum(['master', 'quarantine', 'export']);
export type AssetKind = z.infer<typeof AssetKind>;

export const TrackState = z.enum(['processing', 'deliverable', 'suspended', 'deleted']);
export type TrackState = z.infer<typeof TrackState>;

/** Ledger entry types. Append-only; PROJECT_TASK.md §6.2. */
export const LedgerEntryType = z.enum([
  'grant',
  'reserve',
  'consume',
  'release',
  'revoke',
  'compensate',
  'adjust',
]);
export type LedgerEntryType = z.infer<typeof LedgerEntryType>;

export const EntitlementSource = z.enum([
  'one_time_order',
  'subscription_period',
  'promo_trial',
  'compensation',
  'manual_adjustment',
]);
export type EntitlementSource = z.infer<typeof EntitlementSource>;

export const BatchStatus = z.enum(['active', 'expired', 'revoked']);
export type BatchStatus = z.infer<typeof BatchStatus>;

export const OrderKind = z.enum(['one_time', 'subscription']);
export type OrderKind = z.infer<typeof OrderKind>;

export const OrderStatus = z.enum(['pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'canceled']);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const SubscriptionStatus = z.enum([
  'incomplete',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

export const UserRole = z.enum(['user', 'support', 'admin']);
export type UserRole = z.infer<typeof UserRole>;

export const RightsCaseStatus = z.enum([
  'received',
  'under_review',
  'suspended',
  'dismissed',
  'upheld',
  'restored',
]);
export type RightsCaseStatus = z.infer<typeof RightsCaseStatus>;

/**
 * Upstream cost events. Whether a failure is billable is a contract question,
 * so it is recorded per event rather than assumed free (AI-06).
 */
export const ProviderCostEventType = z.enum([
  'success',
  'failure',
  'rejected',
  'retry',
  'late_success',
  'cancelled',
]);
export type ProviderCostEventType = z.infer<typeof ProviderCostEventType>;
