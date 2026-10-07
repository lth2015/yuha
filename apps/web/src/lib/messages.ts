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
  MFA_REQUIRED: msg('MFA_REQUIRED', 'warn'),
  AUTH_EXCHANGE_FAILED: msg('AUTH_EXCHANGE_FAILED', 'error'),
  UNAUTHENTICATED: msg('UNAUTHENTICATED', 'info'),
  FORBIDDEN: msg('FORBIDDEN', 'error'),
  EMAIL_NOT_ALLOWED: msg('EMAIL_NOT_ALLOWED', 'warn'),
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
  PURCHASE_CAP_REACHED: msg('PURCHASE_CAP_REACHED', 'warn'),
  SERVICE_DISABLED: msg('SERVICE_DISABLED', 'warn'),
  INTERNAL_ERROR: msg('INTERNAL_ERROR', 'error'),
};

const NETWORK_MESSAGE: UserMessage = msg('NETWORK', 'error');
const UNKNOWN_MESSAGE: UserMessage = msg('UNKNOWN', 'error');

/**
 * A refused title is not a refused prompt.
 *
 * Rename reuses PROMPT_BLOCKED — same rules, same appeal machinery — and so
 * inherited its words, which are about generating. A title with a URL in it
 * told the reader "this content cannot be used to generate" about a song that
 * already exists, and then offered the description box's advice for a box that
 * is not on the page. The server already says which field it refused; this is
 * the only thing that reads it.
 */
const BLOCKED_TITLE_MESSAGE: UserMessage = {
  titleKey: 'err.PROMPT_BLOCKED.titleField.title',
  nextKey: 'err.PROMPT_BLOCKED.titleField.next',
  tone: 'warn',
};

export function messageFor(err: unknown): UserMessage {
  if (err instanceof NetworkError) return NETWORK_MESSAGE;
  if (err instanceof ApiError) {
    if (err.code === 'PROMPT_BLOCKED' && blockedField(err) === 'title') {
      return BLOCKED_TITLE_MESSAGE;
    }
    return ERROR_MESSAGES[err.code] ?? UNKNOWN_MESSAGE;
  }
  return UNKNOWN_MESSAGE;
}

function blockedField(err: ApiError): string | undefined {
  const field = (err.details as { field?: unknown } | undefined)?.field;
  return typeof field === 'string' ? field : undefined;
}

/** Composer fields that live inside the collapsed "more settings" panel. */
export const FIELDS_IN_MORE_PANEL = ['title'] as const;

export type FocusField = 'prompt' | 'lyrics' | 'instructions' | 'title';

/**
 * Which box to send the writer back to after a refusal.
 *
 * This lived inside Create.tsx, out of reach of any test, and had drifted in
 * two directions at once. It did not know `field: 'title'`, which the server
 * began sending when titles started being screened, so a blocked title fell
 * through to the catch-all and focused the description — the exact bug this
 * function exists to prevent, arriving from the other side. And its caller
 * opened the "more settings" panel for `lyrics`, on the strength of a comment
 * saying the lyrics field is unmounted while that panel is shut. It has not
 * been since b8f26b3 took the lyrics out of the drawer; the field still in
 * there is the title, and nothing opened the panel for it.
 *
 * Only the server knows which text it screened, so a named field wins. An
 * older API that names nothing falls back to the box in view.
 */
export function focusFieldFor(err: unknown, editing: boolean): FocusField | null {
  if (!(err instanceof ApiError)) return null;
  const named = blockedField(err);
  if (named === 'title') return 'title';
  if (named === 'lyrics') return 'lyrics';
  if (named === 'prompt') return editing ? 'instructions' : 'prompt';
  if (err.code === 'PROMPT_BLOCKED') return editing ? 'instructions' : 'prompt';
  return null;
}

/** Extra guidance for a blocked prompt, keyed by the server's hint (SEC-07). */
/**
 * The server names a hint; the dictionary holds its text. Same reason as the
 * error table above — these were half Japanese and half English.
 */
export const PROMPT_HINT_KEYS = [
  'prompt.tooLong',
  'lyrics.tooLong',
  'title.tooLong',
  // Shared rules, title-shaped wording: the prompt versions of these two end
  // by telling the reader to describe a mood, which is not what a name is.
  'title.noUrl',
  'title.rewriteAsName',
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

/**
 * The single next-step line a failure should show.
 *
 * The panel used to render the generic next step *and* the server's hint, so a
 * description that was merely too long was told first to "rewrite it in terms
 * of mood, instruments and tempo" — advice for a different refusal, read first
 * and therefore acted on. The specific reason replaces the generic one; the
 * generic one remains for failures that arrive without a hint.
 *
 * An unrecognised key falls back rather than being passed to `t()`: the hint
 * names a dictionary entry, and the names come from a response.
 */
export function nextLineKey(genericKey: string, hintKey: string | undefined): string {
  return hintKey && isPromptHint(hintKey) ? hintKey : genericKey;
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

export const TRACK_STATE_KEY = (state: string): string => `track.${state}`;
