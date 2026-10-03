/**
 * Every route names itself, in every language.
 *
 * Until 2026-09-29 nothing wrote `document.title`: every page, in every
 * language, was titled 「YUHA — 让心动，有回声。」 from index.html (WCAG 2.4.2).
 * `lib/title.ts` now maps routes to dictionary keys.
 *
 * The keys live in a regex table rather than in `t('…')` calls, so
 * check-i18n's "every key used is defined" pass cannot see them. A renamed or
 * misspelt key would put the raw key string in the browser tab with every
 * other check green. This test is the check that can see it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pageTitleKey } from '../apps/web/src/lib/title.js';

const dictionarySource = readFileSync(new URL('../apps/web/src/lib/i18n.tsx', import.meta.url), 'utf8');
const definedIn = (key: string) => dictionarySource.split(`'${key}':`).length - 1;

const ROUTES: Array<[string, string | null]> = [
  ['/', null],
  ['/create', 'nav.create'],
  ['/library', 'account.mySongs'],
  ['/pricing', 'title.pricing'],
  ['/song/abc', 'title.song'],
  ['/tracks/abc/export', 'title.export'],
  ['/tracks/abc/license', 'title.license'],
  ['/checkout/confirm', 'title.checkout'],
  ['/checkout/complete', 'title.checkout'],
  ['/settings/billing', 'account.billing'],
  ['/settings/account', 'account.settings'],
  ['/admin', 'account.console'],
  ['/auth', 'nav.signin'],
  ['/auth/google/callback', 'nav.signin'],
  ['/auth/mfa', 'mfa.title'],
  ['/help/rights', 'footer.rights'],
  ['/legal/terms', 'footer.terms'],
  ['/legal/privacy', 'footer.privacy'],
  ['/legal/company', 'footer.company'],
  ['/legal/tokushoho', 'footer.tokushoho'],
  ['/nowhere', 'title.notFound'],
];

describe('page titles', () => {
  it.each(ROUTES)('%s is titled by %s', (path, key) => {
    expect(pageTitleKey(path)).toBe(key);
  });

  it('never matches a longer route by prefix', () => {
    // `/create` must not claim `/created-by-someone`, nor `/admin` `/administer`.
    expect(pageTitleKey('/created-by-someone')).toBe('title.notFound');
    expect(pageTitleKey('/administer')).toBe('title.notFound');
    expect(pageTitleKey('/authority')).toBe('title.notFound');
  });

  it('every title key exists in all three languages', () => {
    const keys = [...new Set(ROUTES.map(([, k]) => k).filter((k): k is string => k !== null))];
    // The home page is titled by the brand and its slogan.
    keys.push('footer.slogan');
    for (const key of keys) {
      expect(definedIn(key), `${key} should be defined once per language`).toBe(3);
    }
  });
});
