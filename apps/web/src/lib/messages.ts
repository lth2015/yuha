import { ERROR_CODES, type ErrorCode } from '@yuha/contracts';
import { ApiError, NetworkError } from './api';

/**
 * Every error code's copy, as dictionary keys rather than literal text.
 *
 * This file used to hold the strings themselves, and had drifted into a mix:
 * thirty entries in Japanese and three in English, so which language a failure
 * spoke depended on when that code was added. Errors are the surface a user
 * meets at their least patient moment; they are now translated like everything
 * else.
 *
 * The record is typed over the full ErrorCode union, so adding a code to the
 * contracts package without adding copy here is a compile error rather than a
 * silent blank in front of a user. `tone` stays here because it is behaviour,
 * not language.
 */
export interface UserMessage {
  titleKey: string;
  /** What to do now. UI-12 requires every failure state to have a next step. */
  nextKey: string;
  tone: 'error' | 'warn' | 'info';
}

const msg = (code: string, tone: UserMessage['tone']): UserMessage => ({
  titleKey: `err.${code}.title`,
  nextKey: `err.${code}.next`,
  tone,
});

export const ERROR_MESSAGES: Record<ErrorCode, UserMessage> = {
  MFA_INVALID_CODE: msg('MFA_INVALID_CODE', 'error'),
  MFA_NOT_ENROLLED: msg('MFA_NOT_ENROLLED', 'info'),
  AUTH_EXCHANGE_FAILED: msg('AUTH_EXCHANGE_FAILED', 'error'),
  UNAUTHENTICATED: msg('UNAUTHENTICATED', 'info'),
  FORBIDDEN: msg('FORBIDDEN', 'error'),
  AGE_NOT_CONFIRMED: msg('AGE_NOT_CONFIRMED', 'warn'),
  TERMS_NOT_ACCEPTED: msg('TERMS_NOT_ACCEPTED', 'warn'),
  VALIDATION_FAILED: msg('VALIDATION_FAILED', 'warn'),
  PROMPT_TOO_LONG: msg('PROMPT_TOO_LONG', 'warn'),
  PROMPT_BLOCKED: msg('PROMPT_BLOCKED', 'warn'),
  UNSUPPORTED_CAPABILITY: msg('UNSUPPORTED_CAPABILITY', 'warn'),
  NOT_FOUND: msg('NOT_FOUND', 'warn'),
  IDEMPOTENCY_KEY_REUSED: msg('IDEMPOTENCY_KEY_REUSED', 'warn'),
  CONFLICT: msg('CONFLICT', 'warn'),
  RATE_LIMITED: msg('RATE_LIMITED', 'warn'),
  INSUFFICIENT_CREDITS: msg('INSUFFICIENT_CREDITS', 'warn'),
  ENTITLEMENT_EXPIRED: msg('ENTITLEMENT_EXPIRED', 'warn'),
  JOB_NOT_CANCELLABLE: msg('JOB_NOT_CANCELLABLE', 'info'),
  UPSTREAM_UNAVAILABLE: msg('UPSTREAM_UNAVAILABLE', 'warn'),
  UPSTREAM_REJECTED: msg('UPSTREAM_REJECTED', 'warn'),
  UPSTREAM_TIMEOUT: msg('UPSTREAM_TIMEOUT', 'info'),
  OUTPUT_CHECK_FAILED: msg('OUTPUT_CHECK_FAILED', 'warn'),
  GENERATION_FAILED: msg('GENERATION_FAILED', 'error'),
  TRACK_NOT_DELIVERABLE: msg('TRACK_NOT_DELIVERABLE', 'info'),
  TRACK_SUSPENDED: msg('TRACK_SUSPENDED', 'warn'),
  CHECKOUT_UNAVAILABLE: msg('CHECKOUT_UNAVAILABLE', 'error'),
  PAYMENT_NOT_CONFIRMED: msg('PAYMENT_NOT_CONFIRMED', 'info'),
  SUBSCRIPTION_NOT_FOUND: msg('SUBSCRIPTION_NOT_FOUND', 'warn'),
  SUBSCRIPTION_ALREADY_ACTIVE: msg('SUBSCRIPTION_ALREADY_ACTIVE', 'info'),
  SUBSCRIPTIONS_DISABLED: msg('SUBSCRIPTIONS_DISABLED', 'info'),
  WEBHOOK_SIGNATURE_INVALID: msg('WEBHOOK_SIGNATURE_INVALID', 'error'),
  BUDGET_EXCEEDED: msg('BUDGET_EXCEEDED', 'warn'),
  SERVICE_DISABLED: msg('SERVICE_DISABLED', 'warn'),
  INTERNAL_ERROR: msg('INTERNAL_ERROR', 'error'),
};

const NETWORK_MESSAGE: UserMessage = msg('NETWORK', 'error');
const UNKNOWN_MESSAGE: UserMessage = msg('UNKNOWN', 'error');

export function messageFor(err: unknown): UserMessage {
  if (err instanceof NetworkError) return NETWORK_MESSAGE;
  if (err instanceof ApiError) return ERROR_MESSAGES[err.code] ?? UNKNOWN_MESSAGE;
  return UNKNOWN_MESSAGE;
}

/** Extra guidance for a blocked prompt, keyed by the server's hint (SEC-07). */
/**
 * The server names a hint; the dictionary holds its text. Same reason as the
 * error table above — these were half Japanese and half English.
 */
export const PROMPT_HINT_KEYS = [
  'prompt.tooLong',
  'prompt.noExistingLyrics',
  'prompt.noUrl',
  'prompt.noPersonalInfo',
  'prompt.rewriteAsMood',
  'prompt.noVoiceImitation',
  'prompt.noArtistOrTitle',
] as const;

export function isPromptHint(key: string): boolean {
  return (PROMPT_HINT_KEYS as readonly string[]).includes(key);
}

/** Compile-time completeness guard for the message table. */
const _exhaustive: readonly ErrorCode[] = ERROR_CODES;
void _exhaustive;

/*
 * JOB_PHASE_LABELS lived here with its own seven-phase vocabulary and no
 * consumer — the phase rail reads `lib/phases.ts` now. Removed rather than
 * translated: a second phase vocabulary is exactly what that unification
 * removed.
 */

/** Dictionary keys; the text lives in lib/i18n like everything else. */
export const SCENE_KEY = (scene: string): string => `scene.${scene}`;
export const TRACK_MOOD_KEY = (mood: string): string => `trackmood.${mood}`;

export const TRACK_STATE_TONES: Record<string, string> = {
  processing: 'badge--warn',
  deliverable: 'badge--ok',
  suspended: 'badge--warn',
  deleted: '',
};
export const TRACK_STATE_KEY = (state: string): string => `track.${state}`;
