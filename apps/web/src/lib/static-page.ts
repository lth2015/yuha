/**
 * The string side of prerendering (prerender.tsx): turning the built
 * index.html into one public page's document. Kept out of the .tsx because
 * none of it is markup React renders.
 */
import { PUBLIC_PAGES, staticPath, type PageHead, type SeoLang } from './seo';

const HTML_LANG: Record<SeoLang, string> = { zh: 'zh-CN', ja: 'ja', en: 'en' };

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textNode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Each page's links to other prerendered pages, pointed at their files. */
function linkStatic(html: string, lang: SeoLang): string {
  return html.replace(/href="([^"]*)"/g, (whole, href: string) => {
    const page = PUBLIC_PAGES.find((p) => p.prerender && p.path === href);
    return page ? `href="${staticPath(page.path, lang)}"` : whole;
  });
}

/** Replaces exactly one match, and says which part of the template moved if there is not one. */
function replaceOne(html: string, re: RegExp, what: string, by: string): string {
  const found = html.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`))?.length ?? 0;
  if (found !== 1) throw new Error(`prerender: expected one ${what} in index.html, found ${found}`);
  return html.replace(re, () => by);
}

/**
 * The template with this page's language, title, description and addresses,
 * and `rendered` in place of the no-JavaScript block in #root.
 */
export function pageDocument(
  template: string,
  { lang, title, description, head, rendered }: { lang: SeoLang; title: string; description: string; head: PageHead; rendered: string },
): string {
  // The same tags applyHead writes in the browser, marked the same way so it
  // replaces them rather than adding a second set.
  const links = [
    `<link rel="canonical" href="${attr(head.canonical!)}" data-seo="">`,
    ...head.alternates.map((a) => `<link rel="alternate" hreflang="${a.hreflang}" href="${attr(a.href)}" data-seo="">`),
  ].join('\n    ');
  let html = template;
  html = replaceOne(html, /<html lang="[^"]*">/, '<html lang>', `<html lang="${HTML_LANG[lang]}">`);
  html = replaceOne(html, /<title>[^<]*<\/title>/, '<title>', `<title>${textNode(title)}</title>\n    ${links}`);
  html = replaceOne(html, /<meta\s+name="description"\s+content="[^"]*"/, 'description meta', `<meta name="description" content="${attr(description)}"`);
  // The no-JavaScript block is index.html's <main> inside #root.
  const root = '<div id="root">';
  const fallback = new RegExp(`${root}[\\s\\S]*?</main>\\s*</div>`);
  html = replaceOne(html, fallback, '#root fallback', root + linkStatic(rendered, lang) + '</div>');
  return html;
}
