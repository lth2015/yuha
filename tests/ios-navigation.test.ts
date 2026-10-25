// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

let cleanup = () => {};
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear(); });

it('iOS login and library navigation never expose Web checkout, Google OAuth or dev accounts', async () => {
  vi.stubEnv('VITE_APP_PLATFORM', 'ios');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"mode":"production"}')));
  localStorage.setItem('yuha.lang', 'en');
  window.history.replaceState({}, '', '/auth');
  const { default: IosApp } = await import('../apps/web/src/ios/IosApp');
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => { root.render(createElement(IosApp)); });
  expect(container.textContent).toContain('Sign-in is coming');
  expect(container.querySelector('input')).toBeNull();
  expect(container.querySelector('a[href*="google"]')).toBeNull();
  await act(async () => { (container.querySelector('a[href="/library"]') as HTMLElement).click(); });
  expect(window.location.pathname).toBe('/library');
  expect(container.textContent).toContain('Your library is private');
  await act(async () => { window.history.pushState({}, '', '/checkout/stablecoin'); window.dispatchEvent(new PopStateEvent('popstate')); });
  expect(container.textContent).toContain('This screen is not available');
  expect(container.querySelector('a[href*="checkout"]')).toBeNull();
});
