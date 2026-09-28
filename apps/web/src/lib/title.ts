import { createContext, useContext, useEffect } from 'react';

/**
 * Document titles.
 *
 * Every page used to share one title — `index.html`'s 「YUHA — 让心动，有回声。」 —
 * whatever the route and whatever the language, because nothing ever wrote
 * `document.title`. A Japanese page carried a Chinese title, and every tab,
 * history entry and screen-reader announcement said the same thing (WCAG 2.4.2,
 * Page Titled). Found by an audit, not by looking: the pages rendered fine.
 *
 * The Layout owns the write. Pages that can name themselves better than their
 * route — a song page, by its song — pass an override up through this context
 * instead of writing the title themselves: React runs a child's effect before
 * its parent's, so a page that wrote `document.title` directly would be
 * overwritten by the Layout on every language switch.
 */
export const PageTitleContext = createContext<(title: string | null) => void>(() => undefined);

/** Names the current page more precisely than its route does. */
export function usePageTitle(title: string | null | undefined): void {
  const set = useContext(PageTitleContext);
  useEffect(() => {
    // `||`, not `??`: an empty title must fall back to the route's name rather
    // than produce " — YUHA".
    set(title?.trim() || null);
    return () => set(null);
  }, [title, set]);
}

/**
 * The i18n key naming a route, or `null` for the home page (which is titled by
 * the brand and its slogan instead). Keys are reused from the navigation and
 * the footer wherever those already name the page, so a title always matches
 * the link that led to it.
 */
export function pageTitleKey(path: string): string | null {
  if (path === '/') return null;
  const rules: Array<[RegExp, string]> = [
    [/^\/create(\/|$)/, 'nav.create'],
    [/^\/library(\/|$)/, 'account.mySongs'],
    [/^\/pricing(\/|$)/, 'title.pricing'],
    [/^\/song\//, 'title.song'],
    [/^\/tracks\/[^/]+\/export/, 'title.export'],
    [/^\/tracks\/[^/]+\/license/, 'title.license'],
    [/^\/projects\//, 'title.project'],
    [/^\/checkout\//, 'title.checkout'],
    [/^\/settings\/billing/, 'account.billing'],
    [/^\/settings\/account/, 'account.settings'],
    [/^\/admin(\/|$)/, 'account.console'],
    [/^\/auth\/mfa/, 'title.mfa'],
    [/^\/auth(\/|$)/, 'nav.signin'],
    [/^\/help\/rights/, 'footer.rights'],
    [/^\/legal\/terms/, 'footer.terms'],
    [/^\/legal\/privacy/, 'footer.privacy'],
    [/^\/legal\/company/, 'footer.company'],
    [/^\/legal\/tokushoho/, 'footer.tokushoho'],
  ];
  return rules.find(([re]) => re.test(path))?.[1] ?? 'title.notFound';
}
