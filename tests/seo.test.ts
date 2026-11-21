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
    expect(locs).toContain('https://example.test/pricing?lang=ja');
    for (const loc of locs) expect(disallowed(new URL(loc).pathname)).toBe(false);
  });
});

describe('a public page in the browser', () => {
  it('is canonical in its own language and points at the other two', () => {
    const head = headFor('/pricing/', 'en', ORIGIN);
    expect(head.robots).toBeNull();
    expect(head.canonical).toBe('https://example.test/pricing?lang=en');
    expect(head.alternates).toEqual([
      { hreflang: 'zh-Hans', href: 'https://example.test/pricing?lang=zh' },
      { hreflang: 'ja', href: 'https://example.test/pricing?lang=ja' },
      { hreflang: 'en', href: 'https://example.test/pricing?lang=en' },
      { hreflang: 'x-default', href: 'https://example.test/pricing' },
    ]);
  });

  it('takes its language from the link', () => {
    expect(urlLang('?lang=ja')).toBe('ja');
    expect(urlLang('?x=1&lang=en')).toBe('en');
    expect(urlLang('?lang=fr')).toBeNull();
    expect(urlLang('')).toBeNull();
  });
});
