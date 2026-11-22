/**
 * What may be indexed, said once (apps/web/src/lib/seo.ts, docs/SEO_SPEC.md),
 * and every place that repeats it agreeing: the routes, robots.txt, the
 * sitemap, and the tags a page carries.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PRIVATE_PREFIXES,
  PUBLIC_PAGES,
  headFor,
  robotsTxt,
  sitemapXml,
  spaPathFor,
  staticPath,
  urlLang,
} from '../apps/web/src/lib/seo.js';

const ORIGIN = 'https://example.test';
const routes = [...readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8').matchAll(/path="([^"]+)"/g)]
  .map((m) => m[1]!)
  .filter((p) => p !== '*');
const disallowed = (path: string) =>
  PRIVATE_PREFIXES.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`)));

describe('the split between public and private pages', () => {
  it('puts every route on exactly one side', () => {
    expect(routes.length).toBeGreaterThan(10); // the pattern found the routes at all
    for (const route of routes) {
      const isPublic = PUBLIC_PAGES.some((p) => p.path === route);
      expect({ route, side: isPublic !== disallowed(route.replace(/:[a-z]+/gi, 'x')) }).toEqual({ route, side: true });
    }
  });

  it('never indexes a song, an account or the console', () => {
    for (const path of ['/song/abc', '/create', '/library', '/settings/billing', '/admin/dashboard', '/checkout/confirm', '/auth', '/tracks/x/export']) {
      expect(headFor(path, 'ja', ORIGIN)).toMatchObject({ robots: 'noindex', canonical: null });
      expect(disallowed(path)).toBe(true);
    }
  });
});

describe('robots.txt and the sitemap', () => {
  it('robots.txt asks crawlers out of exactly the private prefixes, and names the sitemap', () => {
    const txt = robotsTxt(ORIGIN);
    expect(txt.match(/^Disallow: .+$/gm)).toEqual(PRIVATE_PREFIXES.map((p) => `Disallow: ${p}`));
    expect(txt).toContain('Sitemap: https://example.test/sitemap.xml');
    // A shared song's preview stays reachable for previewers that read robots.txt, ahead of the /v1/ rule.
    expect(txt.indexOf('Allow: /v1/share/')).toBeGreaterThan(-1);
    expect(txt.indexOf('Allow: /v1/share/')).toBeLessThan(txt.indexOf('Disallow: /v1/'));
    // Every crawler, language models included, gets the same rules.
    expect(txt.match(/^User-agent: .+$/gm)).toEqual(['User-agent: *']);
  });

  it('the sitemap lists each public page in each language, all of them crawlable', () => {
    const locs = [...sitemapXml(ORIGIN).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
    expect(locs).toHaveLength(PUBLIC_PAGES.length * 3);
    expect(locs).toContain('https://example.test/ja/pricing.html');
    expect(locs).toContain('https://example.test/legal/terms?lang=ja');
    for (const loc of locs) expect(disallowed(new URL(loc).pathname)).toBe(false);
  });
});

describe('a public page in the browser', () => {
  it('is canonical in its own language and points at the other two', () => {
    const head = headFor('/pricing/', 'en', ORIGIN);
    expect(head.robots).toBeNull();
    // Prerendered, so the address a crawler that runs no JavaScript can read.
    expect(head.canonical).toBe('https://example.test/en/pricing.html');
    expect(head.alternates).toEqual([
      { hreflang: 'zh-Hans', href: 'https://example.test/zh/pricing.html' },
      { hreflang: 'ja', href: 'https://example.test/ja/pricing.html' },
      { hreflang: 'en', href: 'https://example.test/en/pricing.html' },
      { hreflang: 'x-default', href: 'https://example.test/pricing' },
    ]);
  });

  it('keeps ?lang= for a page that names the operator, which is never written into a file', () => {
    for (const path of ['/legal/terms', '/legal/privacy', '/legal/company', '/legal/tokushoho']) {
      expect(PUBLIC_PAGES.find((p) => p.path === path)?.prerender).toBe(false);
      expect(headFor(path, 'ja', ORIGIN).canonical).toBe(`https://example.test${path}?lang=ja`);
    }
  });

  it('takes its language from the link', () => {
    expect(urlLang('?lang=ja')).toBe('ja');
    expect(urlLang('?x=1&lang=en')).toBe('en');
    expect(urlLang('?lang=fr')).toBeNull();
    expect(urlLang('')).toBeNull();
  });
});

describe('a prerendered address', () => {
  it('is a file path the CDN serves as it is: it has an extension', () => {
    expect(staticPath('/', 'ja')).toBe('/ja/index.html');
    expect(staticPath('/pricing', 'zh')).toBe('/zh/pricing.html');
    expect(staticPath('/help/rights', 'en')).toBe('/en/help/rights.html');
  });

  it('opens as the page it was rendered from, keeping the rest of the link', () => {
    expect(spaPathFor('/ja/pricing.html', '')).toBe('/pricing?lang=ja');
    expect(spaPathFor('/en/index.html', '?src=x-xmas-1')).toBe('/?src=x-xmas-1&lang=en');
    expect(spaPathFor('/zh/help/rights.html', '?lang=ja')).toBe('/help/rights?lang=zh');
  });

  it('leaves every other path alone', () => {
    for (const path of ['/pricing', '/', '/ja/legal/terms.html', '/fr/pricing.html', '/ja/song/x.html', '/air/index.html']) {
      expect({ path, spa: spaPathFor(path, '') }).toEqual({ path, spa: null });
    }
  });
});

describe('the addresses handed to crawlers outside the sitemap', () => {
  const canonicals = new Set(
    PUBLIC_PAGES.flatMap((p) => (['zh', 'ja', 'en'] as const).map((l) => headFor(p.path, l, 'https://yuha.studio').canonical!)),
  );
  const read = (f: string) => readFileSync(new URL(`../apps/web/${f}`, import.meta.url), 'utf8');

  it('llms.txt links only to canonical page addresses', () => {
    const links = [...read('public/llms.txt').matchAll(/https:\/\/yuha\.studio\/[^\s)]*/g)].map((m) => m[0]);
    expect(links.length).toBeGreaterThan(8);
    for (const link of links) expect({ link, canonical: canonicals.has(link) }).toEqual({ link, canonical: true });
  });

  it("index.html's no-JavaScript block links to prerendered pages, which a crawler can read", () => {
    const hrefs = [...read('index.html').matchAll(/<a href="(\/[^"]*\.html)"/g)].map((m) => `https://yuha.studio${m[1]}`);
    expect(hrefs.length).toBeGreaterThanOrEqual(5);
    for (const href of hrefs) expect(canonicals.has(href)).toBe(true);
  });
});
