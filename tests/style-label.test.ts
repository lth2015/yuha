/**
 * Style tags are the music model's vocabulary, and it is English: lofi,
 * synthwave, dnb. A user reported that a row of those words is a wall for an
 * ordinary listener reading Chinese or Japanese. So the tag stays English on
 * the wire and in the database, and the page shows it in the reader's language.
 *
 * These pin that every style the create page offers has a real name in all
 * three languages, that the spellings tags arrive in (the AI writes
 * `chinese_pop`, people type `Lo-Fi`) land on the same name, and that a tag
 * nobody has translated is shown as written rather than as a dictionary key.
 *
 * No database: pure.
 */
import { describe, expect, it } from 'vitest';
import { STYLE_PRESETS, styleLabel } from '../apps/web/src/lib/style-label.js';
import { textIn } from '../apps/web/src/lib/i18n.js';

const say = (lang: 'zh' | 'ja' | 'en') => (key: string) => textIn(lang, key);
const CJK = /[一-鿿぀-ヿ]/;

describe('style names in the reader’s language', () => {
  it('every style the create page offers has a Chinese and a Japanese name', () => {
    for (const s of STYLE_PRESETS) {
      expect(styleLabel(s, say('zh')), `zh ${s}`).toMatch(CJK);
      expect(styleLabel(s, say('ja')), `ja ${s}`).toMatch(CJK);
      expect(styleLabel(s, say('en')), `en ${s}`).not.toMatch(/^style\./);
    }
  });

  it('gives each preset a distinct name, so two chips never read the same', () => {
    for (const lang of ['zh', 'ja', 'en'] as const) {
      const names = STYLE_PRESETS.map((s) => styleLabel(s, say(lang)));
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('finds the same name whatever spelling the tag arrives in', () => {
    const zh = say('zh');
    expect(styleLabel('Lo-Fi', zh)).toBe(styleLabel('lofi', zh));
    expect(styleLabel('lo fi', zh)).toBe(styleLabel('lofi', zh));
    expect(styleLabel('chinese_pop', zh)).toBe(styleLabel('C-pop', zh));
    expect(styleLabel('drum and bass', zh)).toBe(styleLabel('dnb', zh));
    expect(styleLabel('R&B', zh)).toBe(styleLabel('rnb', zh));
    expect(styleLabel('  Hip-Hop ', zh)).toBe(styleLabel('hip hop', zh));
  });

  it('shows a tag nobody translated as written, never as a key', () => {
    expect(styleLabel('shoegaze', say('zh'))).toBe('shoegaze');
    expect(styleLabel('late_night_drive', say('ja'))).toBe('late night drive');
    expect(styleLabel('我的风格', say('en'))).toBe('我的风格');
  });
});
