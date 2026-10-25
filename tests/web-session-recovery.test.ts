// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MeView } from '@yuha/contracts';
import { SessionProvider, useSession } from '../apps/web/src/lib/session.js';
import { getToken, setToken } from '../apps/web/src/lib/api.js';

const user: MeView = {
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', email: 'session@example.test', displayName: 'Tester',
  avatarUrl: null, role: 'user', ageConfirmed: true, marketingOptIn: false, creditsAvailable: 9,
  createdAt: '2026-10-25T00:00:00Z',
};
const balance = { availableUnits: 9, reservedUnits: 0, batches: [], subscription: null };
let root: Root;
let container: HTMLDivElement;
function Probe({ signInUser = user }: { signInUser?: MeView }) {
  const session = useSession();
  return createElement('div', null,
    createElement('output', null, JSON.stringify({ me: session.me, balance: session.entitlements, loading: session.loading })),
    createElement('button', { onClick: () => session.signIn('new-session', signInUser) }, 'Sign in'),
    createElement('button', { 'data-action': 'refresh', onClick: () => { void session.refreshMe(); void session.refreshEntitlements(); } }, 'Refresh'),
  );
}
const read = () => JSON.parse(container.querySelector('output')!.textContent!);
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('retains the last confirmed profile and balance during a temporary service outage', async () => {
  let outage = false;
  setToken('current-session');
  vi.stubGlobal('fetch', async (path: string) => outage
    ? new Response('unavailable', { status: 503 })
    : Response.json(path === '/v1/me' ? user : path === '/v1/entitlements' ? balance : { mode: 'demo' }));
  await act(async () => root.render(createElement(SessionProvider, null, createElement(Probe))));
  expect(read()).toMatchObject({ me: user, balance });
  outage = true;
  vi.useFakeTimers();
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click();
    await vi.runAllTimersAsync();
  });
  expect(read()).toMatchObject({ me: user, balance });
});

it('recovers a session that could not be loaded until the connection returned', async () => {
  vi.useFakeTimers();
  let outage = true;
  setToken('current-session');
  vi.stubGlobal('fetch', async (path: string) => outage
    ? new Response('unavailable', { status: 503 })
    : Response.json(path === '/v1/me' ? user : path === '/v1/entitlements' ? balance : { mode: 'demo' }));
  await act(async () => { root.render(createElement(SessionProvider, null, createElement(Probe))); });
  await act(async () => { await vi.runAllTimersAsync(); });
  expect(read()).toMatchObject({ me: null, balance: null, loading: false });
  outage = false;
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect(read()).toMatchObject({ me: user, balance });
});

it.each([
  ['profile', 'expires'], ['balance', 'expires'], ['profile', 'succeeds'], ['balance', 'succeeds'],
])('keeps a new signed-in UI when the old %s request %s', async (resource, outcome) => {
  let respondOld!: (response: Response) => void;
  setToken('old-session');
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path === '/v1/runtime') return Response.json({ mode: 'demo' });
    const old = (init.headers as Record<string, string>).authorization === 'Bearer old-session';
    if (old && path === (resource === 'profile' ? '/v1/me' : '/v1/entitlements')) {
      return new Promise<Response>((resolve) => { respondOld = resolve; });
    }
    return Response.json(path === '/v1/me' ? user : balance);
  });
  await act(async () => root.render(createElement(SessionProvider, null, createElement(Probe))));
  expect(respondOld).toBeTypeOf('function');
  await act(async () => container.querySelector('button')!.click());
  expect(read()).toMatchObject({ me: user, balance });
  await act(async () => respondOld(outcome === 'expires'
    ? Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
    : Response.json(resource === 'profile' ? { ...user, displayName: 'Previous account' } : { ...balance, availableUnits: 1 })));
  expect(getToken()).toBe('new-session');
  expect(read()).toMatchObject({ me: user, balance, loading: false });
});

it('still signs out when the current session is rejected', async () => {
  let expired = false;
  setToken('current-session');
  vi.stubGlobal('fetch', async (path: string) => expired
    ? Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
    : Response.json(path === '/v1/me' ? user : path === '/v1/entitlements' ? balance : { mode: 'demo' }));
  await act(async () => root.render(createElement(SessionProvider, null, createElement(Probe))));
  expect(read()).toMatchObject({ me: user, balance });
  expired = true;
  await act(async () => container.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click());
  expect(getToken()).toBeNull();
  expect(read()).toMatchObject({ me: null, balance: null });
});

it('never carries the previous account balance into a different account during an outage', async () => {
  const otherUser = { ...user, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', creditsAvailable: 0 };
  setToken('old-session');
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) =>
    (init.headers as Record<string, string>).authorization === 'Bearer new-session'
      ? new Response('unavailable', { status: 503 })
      : Response.json(path === '/v1/me' ? user : path === '/v1/entitlements' ? balance : { mode: 'demo' }));
  await act(async () => root.render(createElement(SessionProvider, null, createElement(Probe, { signInUser: otherUser }))));
  expect(read()).toMatchObject({ me: user, balance });
  vi.useFakeTimers();
  await act(async () => {
    container.querySelector('button')!.click();
    await vi.runAllTimersAsync();
  });
  expect(read()).toMatchObject({ me: otherUser, balance: null });
});

it('does not discard a reconnection immediately after an offline focus refresh', async () => {
  setToken('current-session');
  let outage = false;
  let available = 9;
  vi.stubGlobal('fetch', async (path: string) => outage
    ? new Response('unavailable', { status: 503 })
    : Response.json(path === '/v1/me' ? user : path === '/v1/entitlements'
      ? { ...balance, availableUnits: available } : { mode: 'demo' }));
  await act(async () => root.render(createElement(SessionProvider, null, createElement(Probe))));
  vi.useFakeTimers();
  outage = true;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(1000);
  });
  outage = false; available = 7;
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(read().balance.availableUnits).toBe(7);
});
