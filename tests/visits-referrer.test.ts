// @vitest-environment jsdom
/**
 * A first visit from a search engine is named after its landing page
 * (docs/ATTRIBUTION_SPEC.md, seo-<page>-<lang>) through the real entry point,
 * reportVisit, not only the pure helper. Codex found (PR #121 review) that the
 * referrer was consumed by the refHost read before the source was taken, so a
 * Google visit sent refHost and no source.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  sent = [];
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      if (init?.body) sent.push(JSON.parse(init.body));
      return new Response(null, { status: 202 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function land(path: string, referrer: string) {
  window.history.replaceState(null, '', path);
  Object.defineProperty(document, 'referrer', { value: referrer, configurable: true });
  const visits = await import('../apps/web/src/lib/visits.js');
  return visits;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const kept = () => JSON.parse(localStorage.getItem('yuha.source') ?? 'null')?.source ?? null;

it('Google → English birthday page: refHost and seo-birthday-en, kept for later pages', async () => {
  document.documentElement.lang = 'en';
  const v = await land('/en/birthday.html', 'https://www.google.com/');
  v.reportVisit('/birthday');
  await flush();
  expect(sent[0]).toMatchObject({ path: '/birthday', refHost: 'www.google.com', source: 'seo-birthday-en' });
  expect(kept()).toBe('seo-birthday-en');
  // The next page in the same visit: the source stays, refHost is not sent twice.
  window.history.pushState(null, '', '/create');
  v.reportVisit('/create');
  await flush();
  expect(sent[1]).toMatchObject({ path: '/create', source: 'seo-birthday-en' });
  expect(sent[1]!.refHost).toBeUndefined();
});

it('Bing → Japanese travel page: seo-travel-ja', async () => {
  document.documentElement.lang = 'ja';
  const v = await land('/ja/travel.html', 'https://www.bing.com/search?q=x');
  v.reportVisit('/travel');
  await flush();
  expect(sent[0]).toMatchObject({ refHost: 'www.bing.com', source: 'seo-travel-ja' });
});

it('an ad tag already kept wins over the search', async () => {
  localStorage.setItem('yuha.source', JSON.stringify({ source: 'x-travel-en-1', at: Date.now() }));
  const v = await land('/en/travel.html', 'https://www.google.com/');
  v.reportVisit('/travel');
  await flush();
  expect(sent[0]).toMatchObject({ refHost: 'www.google.com', source: 'x-travel-en-1' });
});

it('no referrer, or a site that is not a search engine: no source', async () => {
  let v = await land('/en/birthday.html', '');
  v.reportVisit('/birthday');
  await flush();
  expect(sent[0]!.source).toBeUndefined();
  vi.resetModules();
  localStorage.clear();
  v = await land('/en/birthday.html', 'https://x.com/somebody');
  v.reportVisit('/birthday');
  await flush();
  expect(sent[1]).toMatchObject({ refHost: 'x.com' });
  expect(sent[1]!.source).toBeUndefined();
});

it('a search landing on a page that is not public names nothing, and a later public page does not take the credit', async () => {
  const v = await land('/song/abc', 'https://www.google.com/');
  v.reportVisit('/song/abc');
  await flush();
  expect(sent[0]!.source).toBeUndefined();
  window.history.pushState(null, '', '/en/birthday.html');
  v.reportVisit('/birthday');
  await flush();
  expect(sent[1]!.source).toBeUndefined();
});
