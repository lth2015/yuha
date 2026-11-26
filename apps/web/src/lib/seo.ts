/**
 * What search engines and language models may index (docs/SEO_SPEC.md).
 *
 * The split between public and private pages is written here once. The
 * robots.txt and sitemap.xml the build emits, and the robots / canonical /
 * alternate tags each page carries, all come from it, and
 * tests/seo.test.ts checks that every route in App.tsx falls on one side.
 *
 * Songs are never indexed: a song is private, and "public" means anyone
 * holding the link can open it — a search engine is not someone holding the
 * link (CLAUDE.md, Scope decisions).
 */
export type SeoLang = 'zh' | 'ja' | 'en';
export const SEO_LANGS: readonly SeoLang[] = ['zh', 'ja', 'en'];

/**
 * Pages anyone may find, each with the i18n key of its description, and
 * whether the build writes it out as HTML (prerender.tsx).
 *
 * Prerendered, because the SPA gives a crawler that runs no JavaScript the same
 * empty shell under every address, and most language-model crawlers are that
 * crawler. Not prerendered: the four pages that name the operator. Those
 * values come from GET /v1/legal/business-disclosure at run time and go in no
 * file (CLAUDE.md), and a build output is a file.
 */
export const PUBLIC_PAGES: ReadonlyArray<{ path: string; description: string; prerender: boolean }> = [
  { path: '/', description: 'seo.desc.home', prerender: true },
  { path: '/pricing', description: 'seo.desc.pricing', prerender: true },
  { path: '/help/rights', description: 'seo.desc.rights', prerender: true },
  { path: '/birthday', description: 'seo.desc.scene.birthday', prerender: true },
  { path: '/love', description: 'seo.desc.scene.love', prerender: true },
  { path: '/thanks', description: 'seo.desc.scene.thanks', prerender: true },
  { path: '/miss', description: 'seo.desc.scene.miss', prerender: true },
  { path: '/memory', description: 'seo.desc.scene.memory', prerender: true },
  { path: '/travel', description: 'seo.desc.scene.travel', prerender: true },
  { path: '/cheer', description: 'seo.desc.scene.cheer', prerender: true },
  { path: '/legal', description: 'seo.desc.legal', prerender: true },
  { path: '/legal/terms', description: 'seo.desc.terms', prerender: false },
  { path: '/legal/privacy', description: 'seo.desc.privacy', prerender: false },
  { path: '/legal/company', description: 'seo.desc.company', prerender: false },
  { path: '/legal/tokushoho', description: 'seo.desc.tokushoho', prerender: false },
];

/**
 * Where the build writes a prerendered page. It has an extension on purpose:
 * the CDN answers every path without one with the SPA's index.html, whatever
 * is in the bucket (`/air/` included), and serves a path with one as the
 * object it names. So `/ja/pricing` could never reach a file; `/ja/pricing.html`
 * does, there and behind deploy/dgx's nginx (`try_files $uri`).
 */
export function staticPath(path: string, lang: SeoLang): string {
  return path === '/' ? `/${lang}/index.html` : `/${lang}${path}.html`;
}

/**
 * The app address a prerendered file stands for, or null for any other path.
 * main.tsx swaps it into the address bar before the router starts, so a person
 * who lands on `/ja/pricing.html` from a search result gets the pricing page,
 * with any `?src=` they arrived with.
 */
export function spaPathFor(pathname: string, search: string): string | null {
  const m = /^\/(zh|ja|en)(\/.+)\.html$/.exec(pathname);
  if (!m) return null;
  const lang = m[1] as SeoLang;
  const path = m[2] === '/index' ? '/' : m[2]!;
  const page = PUBLIC_PAGES.find((p) => p.path === path && p.prerender);
  if (!page) return null;
  const params = new URLSearchParams(search);
  params.set('lang', lang);
  return `${page.path}?${params.toString()}`;
}

/**
 * Where crawlers are asked not to go: someone's songs, their account, the
 * console, the API. A prefix ending in `/` covers what is below it; one
 * without covers the page and what is below it.
 */
export const PRIVATE_PREFIXES: readonly string[] = [
  '/song/',
  // A gift invitation's link is its only key: never indexed (docs/GIFT_INVITATION_PLAN.md).
  '/gift/',
  '/create',
  '/library',
  '/tracks/',
  '/settings/',
  '/checkout/',
  '/auth',
  '/admin',
  '/v1/',
];

/** Inside a private prefix, but fetched by link previewers; noindex on the page itself. */
const SHARE_PREFIXES: readonly string[] = ['/v1/share/'];

function bare(path: string): string {
  const p = path.split('?')[0]!.split('#')[0]!;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function publicPage(path: string): (typeof PUBLIC_PAGES)[number] | undefined {
  const p = bare(path);
  return PUBLIC_PAGES.find((page) => page.path === p);
}

/**
 * The address of a public page in one language: the prerendered file where
 * there is one, otherwise `?lang=` on the app's own address.
 */
function pageUrl(origin: string, page: (typeof PUBLIC_PAGES)[number], lang: SeoLang): string {
  if (page.prerender) return new URL(staticPath(page.path, lang), origin).toString();
  const url = new URL(page.path, origin);
  url.searchParams.set('lang', lang);
  return url.toString();
}

export interface PageHead {
  /** `noindex` for every page that is not public. */
  robots: 'noindex' | null;
  canonical: string | null;
  alternates: Array<{ hreflang: string; href: string }>;
  /** An i18n key, or null for a page that keeps the document's default. */
  description: string | null;
}

const HREFLANG: Record<SeoLang, string> = { zh: 'zh-Hans', ja: 'ja', en: 'en' };

export function headFor(path: string, lang: SeoLang, origin: string): PageHead {
  const page = publicPage(path);
  if (!page) return { robots: 'noindex', canonical: null, alternates: [], description: null };
  return {
    robots: null,
    canonical: pageUrl(origin, page, lang),
    alternates: [
      ...SEO_LANGS.map((l) => ({ hreflang: HREFLANG[l], href: pageUrl(origin, page, l) })),
      /*
       * For a reader whose language is none of these: the English version.
       * It was the bare path (`/pricing`), which a crawler that runs no
       * JavaScript receives as the app shell — no canonical, no hreflang,
       * the home page's title — so the group's default pointed at a page
       * that did not belong to it.
       */
      { hreflang: 'x-default', href: pageUrl(origin, page, 'en') },
    ],
    description: page.description,
  };
}

/**
 * Writes a PageHead into the document. Every element it owns carries
 * `data-seo`, so a route change removes the last page's tags rather than
 * stacking them.
 */
export function applyHead(doc: Document, head: PageHead, describe: (key: string) => string): void {
  for (const el of Array.from(doc.head.querySelectorAll('[data-seo]'))) el.remove();
  const add = (tag: string, attrs: Record<string, string>) => {
    const el = doc.createElement(tag);
    el.setAttribute('data-seo', '');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    doc.head.appendChild(el);
  };
  if (head.robots) add('meta', { name: 'robots', content: head.robots });
  if (head.canonical) add('link', { rel: 'canonical', href: head.canonical });
  for (const a of head.alternates) add('link', { rel: 'alternate', hreflang: a.hreflang, href: a.href });
  const description = doc.head.querySelector<HTMLMetaElement>('meta[name="description"]:not([data-seo])');
  // Always written: a page with none of its own takes the home page's, rather
  // than keeping whatever the page before it set.
  if (description) description.content = describe(head.description ?? 'seo.desc.home');
}

export function robotsTxt(origin: string): string {
  return [
    '# YUHA — https://github.com/lth2015/yuha (docs/SEO_SPEC.md)',
    '#',
    '# Search engines and language models are welcome to read and index the',
    '# public pages. Songs are private to the people who made them, and are not',
    '# to be indexed; nor is anyone\'s account.',
    'User-agent: *',
    // A shared song's preview card: link previewers that honour robots.txt
    // (X's does) must reach it. The page itself says noindex.
    ...SHARE_PREFIXES.map((p) => `Allow: ${p}`),
    ...PRIVATE_PREFIXES.map((p) => `Disallow: ${p}`),
    'Allow: /',
    '',
    `Sitemap: ${new URL('/sitemap.xml', origin).toString()}`,
    '',
  ].join('\n');
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function sitemapXml(origin: string): string {
  const urls = PUBLIC_PAGES.flatMap((page) => {
    const head = (lang: SeoLang) => headFor(page.path, lang, origin);
    return SEO_LANGS.map((lang) =>
      [
        '  <url>',
        `    <loc>${xml(head(lang).canonical!)}</loc>`,
        ...head(lang).alternates.map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${xml(a.href)}"/>`),
        '  </url>',
      ].join('\n'),
    );
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/** The language a link asks for (`?lang=ja`), if it asks for one this site has. */
export function urlLang(search: string): SeoLang | null {
  const v = new URLSearchParams(search).get('lang');
  return v && (SEO_LANGS as readonly string[]).includes(v) ? (v as SeoLang) : null;
}
