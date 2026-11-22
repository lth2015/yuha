/**
 * Public pages as HTML a crawler that runs no JavaScript can read
 * (apps/web/src/prerender.tsx, docs/SEO_SPEC.md, second stage). Most
 * language-model crawlers fetch a page and stop; the SPA gives them an empty
 * shell under every address.
 */
import { describe, expect, it } from 'vitest';
import { prerenderPages } from '../apps/web/src/prerender.js';
import { PUBLIC_PAGES, staticPath } from '../apps/web/src/lib/seo.js';
import { textIn } from '../apps/web/src/lib/i18n.js';

const ORIGIN = 'https://example.test';
// The shape of the built index.html that matters: head tags to rewrite, the
// no-JavaScript fallback inside #root, and the bundle.
const TEMPLATE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <title>YUHA — 让心动，有回声。</title>
    <meta
      name="description"
      content="写下一段心情。"
    />
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body>
    <div id="root">
      <main style="x">
        <h1>YUHA</h1>
        <p><a href="/pricing">Pricing</a></p>
      </main>
    </div>
  </body>
</html>
`;

const pages = prerenderPages(TEMPLATE, ORIGIN);
const file = (path: string, lang: 'zh' | 'ja' | 'en') => {
  const found = pages.find((p) => p.file === staticPath(path, lang));
  if (!found) throw new Error(`no file for ${path} ${lang}`);
  return found.html;
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('prerendered public pages', () => {
  it('makes one file per prerendered page per language, and none for a page that names the operator', () => {
    const expected = PUBLIC_PAGES.filter((p) => p.prerender).flatMap((p) => (['zh', 'ja', 'en'] as const).map((l) => staticPath(p.path, l)));
    expect(expected.length).toBeGreaterThanOrEqual(12);
    expect(pages.map((p) => p.file).sort()).toEqual([...expected].sort());
    for (const p of pages) expect(p.file).not.toMatch(/terms|privacy|company|tokushoho/);
  });

  it('carries the page itself, in its language, not the shell', () => {
    const ja = file('/pricing', 'ja');
    expect(text(ja)).toContain(textIn('ja', 'title.pricing'));
    expect(ja).not.toContain('<main style="x">');
    expect(text(file('/help/rights', 'en'))).toContain(textIn('en', 'footer.rights'));
    expect(text(file('/', 'zh'))).toContain(textIn('zh', 'footer.slogan'));
  });

  it('heads each page with its own language, title, description and addresses', () => {
    const en = file('/pricing', 'en');
    expect(en).toContain('<html lang="en">');
    expect(en).toContain(`<title>${textIn('en', 'title.pricing')} — YUHA</title>`);
    expect(en).toContain(`content="${textIn('en', 'seo.desc.pricing')}"`);
    expect(en).toContain('<link rel="canonical" href="https://example.test/en/pricing.html" data-seo="">');
    expect(en).toContain('hreflang="ja" href="https://example.test/ja/pricing.html"');
    expect(en).toContain('<script type="module" crossorigin src="/assets/index-abc.js"></script>');
    expect(file('/', 'ja')).toContain(`<title>YUHA — ${textIn('ja', 'footer.slogan')}</title>`);
  });

  it('links to the other prerendered pages, so a crawler that follows links stays on readable ones', () => {
    const html = file('/', 'ja');
    expect(html).toContain('href="/ja/help/rights.html"');
    expect(html).not.toContain('href="/help/rights"');
    // Pages that are not prerendered keep their app address.
    expect(file('/legal', 'ja')).toContain('href="/legal/terms"');
  });

  it('refuses a template it does not recognise rather than write the shell under a new name', () => {
    expect(() => prerenderPages(TEMPLATE.replace('<div id="root">', '<div id="app">'), ORIGIN)).toThrow(/root/);
  });
});
