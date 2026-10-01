/**
 * Stable machine-readable error codes. The web app maps every one of these to a
 * Japanese message and a concrete next step (UI-12), so adding a code here
 * without adding a message is a type error on the front end.
 */
export const ERROR_CODES = [
  // auth / access
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'AGE_NOT_CONFIRMED',
  'TERMS_NOT_ACCEPTED',
  'AUTH_EXCHANGE_FAILED',
  'MFA_INVALID_CODE',
  'MFA_NOT_ENROLLED',
  'EMAIL_NOT_ALLOWED',
  // request shape
  'VALIDATION_FAILED',
  'PROMPT_TOO_LONG',
  'PROMPT_BLOCKED',
  'UNSUPPORTED_CAPABILITY',
  'NOT_FOUND',
  // idempotency / concurrency
  'IDEMPOTENCY_KEY_REUSED',
  'CONFLICT',
  'RATE_LIMITED',
  // entitlements
  'INSUFFICIENT_CREDITS',
  'ENTITLEMENT_EXPIRED',
  // generation
  'JOB_NOT_CANCELLABLE',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_REJECTED',
  'UPSTREAM_TIMEOUT',
  'OUTPUT_CHECK_FAILED',
  'GENERATION_FAILED',
  'TRACK_NOT_DELIVERABLE',
  'TRACK_SUSPENDED',
  // billing
  'CHECKOUT_UNAVAILABLE',
  'PAYMENT_NOT_CONFIRMED',
  'SUBSCRIPTION_NOT_FOUND',
  'SUBSCRIPTION_ALREADY_ACTIVE',
  'SUBSCRIPTIONS_DISABLED',
  'WEBHOOK_SIGNATURE_INVALID',
  // platform
  'BUDGET_EXCEEDED',
  'SERVICE_DISABLED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    /** Developer-facing English message. User-facing Japanese text lives in the web app. */
    message: string;
    /** Optional structured detail; never contains secrets or raw prompts. */
    details?: unknown;
    requestId?: string;
  };
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  AGE_NOT_CONFIRMED: 403,
  TERMS_NOT_ACCEPTED: 403,
  AUTH_EXCHANGE_FAILED: 401,
  MFA_INVALID_CODE: 401,
  MFA_NOT_ENROLLED: 400,
  EMAIL_NOT_ALLOWED: 403,
  VALIDATION_FAILED: 400,
  PROMPT_TOO_LONG: 400,
  PROMPT_BLOCKED: 422,
  UNSUPPORTED_CAPABILITY: 422,
  NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INSUFFICIENT_CREDITS: 402,
  ENTITLEMENT_EXPIRED: 402,
  JOB_NOT_CANCELLABLE: 409,
  UPSTREAM_UNAVAILABLE: 503,
  UPSTREAM_REJECTED: 422,
  UPSTREAM_TIMEOUT: 504,
  OUTPUT_CHECK_FAILED: 422,
  GENERATION_FAILED: 500,
  TRACK_NOT_DELIVERABLE: 409,
  TRACK_SUSPENDED: 423,
  CHECKOUT_UNAVAILABLE: 503,
  PAYMENT_NOT_CONFIRMED: 409,
  SUBSCRIPTION_NOT_FOUND: 404,
  // 409: the request is well formed, the account's state is what refuses it.
  SUBSCRIPTION_ALREADY_ACTIVE: 409,
  SUBSCRIPTIONS_DISABLED: 403,
  WEBHOOK_SIGNATURE_INVALID: 400,
  BUDGET_EXCEEDED: 429,
  SERVICE_DISABLED: 503,
  INTERNAL_ERROR: 500,
};

export function httpStatusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = httpStatusFor(code);
    this.details = details;
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
        ...(requestId === undefined ? {} : { requestId }),
      },
    };
  }
}
