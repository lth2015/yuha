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
const SEO_LANGS: readonly SeoLang[] = ['zh', 'ja', 'en'];

/** Pages anyone may find, each with the i18n key of its description. */
export const PUBLIC_PAGES: ReadonlyArray<{ path: string; description: string }> = [
  { path: '/', description: 'seo.desc.home' },
  { path: '/pricing', description: 'seo.desc.pricing' },
  { path: '/help/rights', description: 'seo.desc.rights' },
  { path: '/legal', description: 'seo.desc.legal' },
  { path: '/legal/terms', description: 'seo.desc.terms' },
  { path: '/legal/privacy', description: 'seo.desc.privacy' },
  { path: '/legal/company', description: 'seo.desc.company' },
  { path: '/legal/tokushoho', description: 'seo.desc.tokushoho' },
];

/**
 * Where crawlers are asked not to go: someone's songs, their account, the
 * console, the API. A prefix ending in `/` covers what is below it; one
 * without covers the page and what is below it.
 */
export const PRIVATE_PREFIXES: readonly string[] = [
  '/song/',
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

/** The address of a public page in one language: `?lang=` is what makes three of them. */
function pageUrl(origin: string, path: string, lang: SeoLang): string {
  const url = new URL(path, origin);
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
    canonical: pageUrl(origin, page.path, lang),
    alternates: [
      ...SEO_LANGS.map((l) => ({ hreflang: HREFLANG[l], href: pageUrl(origin, page.path, l) })),
      // No language asked for: the page picks one from the browser.
      { hreflang: 'x-default', href: new URL(page.path, origin).toString() },
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
