import type { ErrorCode } from '@yuha/contracts';

/**
 * Where the API is, from the browser's point of view.
 *
 * Empty means "same origin", which in development is the Vite proxy in
 * `vite.config.ts` and needs no CORS at all. It used to default to
 * `http://localhost:4000`: a cross-origin call that some browsers refuse
 * outright, and — worse — a literal `localhost` baked into any production
 * bundle built without `VITE_API_URL`, which is every build today.
 *
 * It is re-exported at the bottom of this file because the Google sign-in link
 * is a full-page navigation rather than a fetch, so it cannot go through
 * `apiFetch` and needs the same answer. It used to carry its own copy of this
 * expression, complete with its own `http://localhost:4000`.
 */
const API_BASE = import.meta.env['VITE_API_URL'] ?? '';
const TOKEN_KEY = 'loopscene.token';
// PR-A is an anonymous preview. Native authentication and Keychain arrive in
// PR-B; never import a Web session or accidentally enable paid operations.
const IOS_PREVIEW = import.meta.env['VITE_APP_PLATFORM'] === 'ios';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Raised when the browser could not reach the API at all (UI-12: network loss). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('network unreachable');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export function getToken(): string | null {
  if (IOS_PREVIEW) return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Fired when the server rejects the stored token.
 *
 * A plain DOM event rather than a callback registry: the fetch layer must not
 * import React, and the session provider is the only listener there will ever
 * be.
 */
export const SESSION_EXPIRED_EVENT = 'yuha:session-expired';

export function setToken(token: string | null): void {
  if (IOS_PREVIEW) throw new Error('iOS preview: authentication is not enabled');
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing: the session simply does not persist */
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function retryPause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('request aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * The request itself, and what a failure means — shared by the JSON and the
 * text callers.
 *
 * Split out when the accounting export needed CSV: a second copy of the
 * authorization header and the 401 handling is a second place for them to
 * drift, and the one that drifted would be the one nobody tested.
 */
async function request(path: string, opts: RequestOptions): Promise<{ res: Response; text: string; token: string | null }> {
  if (IOS_PREVIEW && ((opts.method ?? 'GET') !== 'GET' ||
    !['/v1/runtime', '/v1/explore', '/v1/legal/business-disclosure', '/v1/products'].includes(path))) {
    throw new Error('iOS preview: this operation is not enabled');
  }
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  if (opts.signal?.aborted) throw new DOMException('request aborted', 'AbortError');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  // Reads should recover promptly; mutations can include a text-model call.
  const timeout = setTimeout(onAbort, (opts.method ?? 'GET') === 'GET' ? 15_000 : 60_000);
  try {
    const readOnly = (opts.method ?? 'GET') === 'GET';
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${API_BASE}${path}`, {
          method: opts.method ?? 'GET',
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        });
        const text = res.status === 204 ? '' : await res.text();
        if (!readOnly || attempt > 0 || ![502, 503, 504].includes(res.status)) return { res, text, token };
      } catch (err) {
        if (!readOnly || attempt > 0 || controller.signal.aborted) throw err;
      }
      // Read recovery stays inside the original deadline. Never replay writes:
      // a lost response does not mean a generation/payment was not accepted.
      await retryPause(controller.signal);
    }
  } catch (err) {
    if (opts.signal?.aborted) throw new DOMException('request aborted', 'AbortError');
    throw new NetworkError(err);
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * A response that is not JSON — the accounting CSV.
 *
 * Deliberately not a plain `<a href>`: the console's endpoints need the
 * bearer token, and a link cannot carry one. A link would either download an
 * HTML error page named `.csv` or quietly produce nothing.
 */
export async function apiFetchText(path: string): Promise<string> {
  const { res, text, token } = await request(path, {});
  if (!res.ok) throw errorFrom(res, text, token);
  return text;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { res, text, token } = await request(path, opts);

  if (res.status === 204) return undefined as T;
  if (!res.ok) throw errorFrom(res, text, token);

  try {
    return JSON.parse(text) as T;
  } catch {
    // A proxy can answer an API path with the SPA shell and HTTP 200.
    // Never turn that into successful null data and a later render crash.
    throw new ApiError('INTERNAL_ERROR', 'invalid JSON response', 502);
  }
}

/** The error a failed response becomes, including what a 401 does to the session. */
function errorFrom(res: Response, text: string, requestToken: string | null): ApiError {
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const body = json as { error?: { code?: ErrorCode; message?: string; details?: unknown } } | null;
  const code = body?.error?.code ?? 'INTERNAL_ERROR';
  /*
   * An expired or revoked session drops the stale token — and says so.
   *
   * Dropping it silently was half a sign-out: the token went, but the session
   * provider still held `me`, so the header kept showing the person's name and
   * credits, the protected routes kept admitting them, and every single action
   * failed with "you need to sign in" until they found Sign out in the menu or
   * reloaded by hand. The event is what turns that into an actual sign-out.
   */
  // A suspension is the same for the session: the token is no use any more,
  // and the sign-in page is where the reason can be shown.
  if ((res.status === 401 || code === 'ACCOUNT_SUSPENDED') && requestToken && getToken() === requestToken) {
    setToken(null);
    try {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    } catch {
      /* no window: nothing is rendering, so nothing needs telling */
    }
  }
  return new ApiError(code, body?.error?.message ?? res.statusText, res.status, body?.error?.details);
}

/**
 * A per-attempt idempotency key.
 *
 * Generated once when the user opens the create form and reused for every retry
 * of that same submission, so a double tap or a flaky network cannot produce two
 * jobs or two charges (GEN-01).
 */
export function newIdempotencyKey(prefix = 'gen'): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.slice(0, 128);
}

export { API_BASE };
