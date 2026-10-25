import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, SESSION_EXPIRED_EVENT, apiFetch, apiFetchText, getToken, setToken } from '../apps/web/src/lib/api.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('reports a proxy HTML response as a request failure instead of successful null data', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><title>YUHA</title>', {
    status: 200, headers: { 'content-type': 'text/html' },
  })));
  await expect(apiFetch('/v1/runtime')).rejects.toBeInstanceOf(ApiError);
});

it('keeps a new session when an older in-flight request expires', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  let respond!: (response: Response) => void;
  vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { respond = resolve; }));
  setToken('old-session');
  const oldRequest = apiFetch('/v1/me');
  setToken('new-session');
  respond(Response.json({ error: { code: 'AUTH_REQUIRED', message: 'expired' } }, { status: 401 }));
  await expect(oldRequest).rejects.toMatchObject({ status: 401 });
  expect(getToken()).toBe('new-session');
});

it('ends a stalled request rather than leaving the visitor loading indefinitely', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const result = apiFetch('/v1/runtime').catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await Promise.race([result, Promise.resolve('still loading')])).toBeInstanceOf(NetworkError);
});

it('keeps the deadline active while reading a stalled response body', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  })));
  const result = apiFetch('/v1/runtime').catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await Promise.race([result, Promise.resolve('still loading')])).toBeInstanceOf(NetworkError);
});

it('allows a slow write to continue past the read deadline but stops it at its own deadline', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const result = apiFetch('/v1/lyrics', { method: 'POST', body: { prompt: 'gentle piano' } }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(45_000);
  expect(await Promise.race([result, Promise.resolve('still waiting')])).toBe('still waiting');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await Promise.race([result, Promise.resolve('still waiting')])).toBeInstanceOf(NetworkError);
});

it('recovers a single temporary gateway failure on a read request', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response('gateway unavailable', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ mode: 'production' }));
  vi.stubGlobal('fetch', fetch);
  const result = apiFetch('/v1/runtime').catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ mode: 'production' });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['connection', 'response-body'])('recovers one interrupted %s read', async (failure) => {
  vi.useFakeTimers();
  const fetch = vi.fn();
  if (failure === 'connection') fetch.mockRejectedValueOnce(new TypeError('connection lost'));
  else fetch.mockResolvedValueOnce(new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('body interrupted')); },
  })));
  fetch.mockResolvedValueOnce(Response.json({ items: [] }));
  vi.stubGlobal('fetch', fetch);
  const result = apiFetch('/v1/tracks').catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ items: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('stops after one failed read retry', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => new Response('unavailable', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  const result = apiFetch('/v1/runtime').catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ status: 503 });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['response', 'connection'])('never automatically repeats a payment or generation write after a lost %s', async (failure) => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => {
    if (failure === 'connection') throw new TypeError('response lost');
    return new Response('unavailable', { status: 503 });
  });
  vi.stubGlobal('fetch', fetch);
  const result = apiFetch('/v1/checkout', {
    method: 'POST', idempotencyKey: 'checkout-original', body: { priceKey: 'pack' },
  }).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toBeInstanceOf(failure === 'connection' ? NetworkError : ApiError);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { 'idempotency-key': 'checkout-original' } });
});

it.each([400, 401, 403, 429, 500])('does not replay a read with status %i', async (status) => {
  const fetch = vi.fn(async () => Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status }));
  vi.stubGlobal('fetch', fetch);
  await expect(apiFetch('/v1/runtime')).rejects.toMatchObject({ status });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('still expires the matching rejected session, including text downloads', async () => {
  let token: string | null = 'expired-session';
  vi.stubGlobal('localStorage', { getItem: () => token, removeItem: () => { token = null; } });
  const dispatchEvent = vi.fn();
  vi.stubGlobal('window', { dispatchEvent });
  vi.stubGlobal('fetch', async () => new Response('unauthorized', { status: 401 }));
  await expect(apiFetchText('/v1/admin/export')).rejects.toMatchObject({ status: 401 });
  expect(getToken()).toBeNull();
  expect(dispatchEvent.mock.calls[0]?.[0].type).toBe(SESSION_EXPIRED_EVENT);
});

it('preserves explicit cancellation during a read retry', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetch = vi.fn(async () => new Response('unavailable', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  const result = apiFetch('/v1/runtime', { signal: controller.signal }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  controller.abort();
  expect(await result).toMatchObject({ name: 'AbortError' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
