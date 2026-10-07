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
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing: the session simply does not persist */
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * The request itself, and what a failure means — shared by the JSON and the
 * text callers.
 *
 * Split out when the accounting export needed CSV: a second copy of the
 * authorization header and the 401 handling is a second place for them to
 * drift, and the one that drifted would be the one nobody tested.
 */
async function request(path: string, opts: RequestOptions): Promise<{ res: Response; text: string }> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError(err);
  }
  return { res, text: res.status === 204 ? '' : await res.text() };
}

/**
 * A response that is not JSON — the accounting CSV.
 *
 * Deliberately not a plain `<a href>`: the console's endpoints need the
 * bearer token, and a link cannot carry one. A link would either download an
 * HTML error page named `.csv` or quietly produce nothing.
 */
export async function apiFetchText(path: string): Promise<string> {
  const { res, text } = await request(path, {});
  if (!res.ok) throw errorFrom(res, text);
  return text;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { res, text } = await request(path, opts);

  if (res.status === 204) return undefined as T;

  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) throw errorFrom(res, text);

  return json as T;
}

/** The error a failed response becomes, including what a 401 does to the session. */
function errorFrom(res: Response, text: string): ApiError {
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
  if (res.status === 401) {
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
