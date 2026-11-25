/**
 * The dashboard's language and scene totals (docs/ITERATION_EN_JA_MV.md),
 * read from source names written `<channel>-<scene>-<lang>-<n>`.
 */
import { describe, expect, it } from 'vitest';
import { rollup, sourceParts } from '../apps/web/src/lib/funnel.js';

const row = (source: string, n: number) => ({ source, visitors: n, trials: n, signups: n, madeASong: n, madeAVideo: n, paid: n, revenueJpy: n * 100 });

describe('source names', () => {
  it('give their scene and language when written to the convention', () => {
    expect(sourceParts('x-birthday-en-1')).toEqual({ scene: 'birthday', lang: 'en' });
    expect(sourceParts('seo-travel-ja')).toEqual({ scene: 'travel', lang: 'ja' });
    expect(sourceParts('seo-home-zh')).toEqual({ scene: 'home', lang: 'zh' });
    expect(sourceParts('x-xmas-1')).toEqual({ scene: null, lang: null });
  });
});

describe('totals', () => {
  it('add up every column per language and per scene, with the unnamed apart', () => {
    const rows = [row('x-birthday-en-1', 1), row('x-birthday-ja-1', 2), row('seo-travel-en', 4), row('x-xmas-1', 8)];
    expect(rollup(rows, 'lang')).toEqual([
      { key: 'en', ...row('', 5), source: undefined },
      { key: 'ja', ...row('', 2), source: undefined },
      { key: null, ...row('', 8), source: undefined },
    ].map(({ source: _s, ...r }) => r));
    expect(rollup(rows, 'scene').map((r) => [r.key, r.visitors])).toEqual([
      ['birthday', 3],
      ['travel', 4],
      [null, 8],
    ]);
  });
});

import { organicSource } from '../apps/web/src/lib/visits.js';

describe('a visit from a search engine with no tag', () => {
  it('is named after the page and language it landed on', () => {
    expect(organicSource('/en/birthday.html', '', 'www.google.com', 'en')).toBe('seo-birthday-en');
    expect(organicSource('/ja/index.html', '', 'www.google.co.jp', 'ja')).toBe('seo-home-ja');
    expect(organicSource('/travel', '?lang=ja', 'www.bing.com', 'zh-CN')).toBe('seo-travel-ja');
    expect(organicSource('/', '', 'search.yahoo.co.jp', 'zh-CN')).toBe('seo-home-zh');
  });

  it('is not named when it came from anywhere else, or landed somewhere private', () => {
    expect(organicSource('/en/birthday.html', '', 'x.com', 'en')).toBeNull();
    expect(organicSource('/en/birthday.html', '', undefined, 'en')).toBeNull();
    expect(organicSource('/song/abc/def', '', 'www.google.com', 'en')).toBeNull();
  });
});
