/**
 * The instrument in three languages (#34).
 *
 * The page has few words, so a missing or hard-coded one is easy to miss on a
 * screen and easy to catch here: every language has every key, every key the
 * page uses exists, and no Chinese, Japanese or English sentence is left
 * written straight into the page or its script (the only literal is the
 * <title>, which names the page in a gallery before any script runs).
 *
 * No database: files and pure functions.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { format, LANGS, pickLang, STRINGS } from '../apps/air/src/play/i18n.js';

const root = join(import.meta.dirname, '../apps/air');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const scripts = readdirSync(join(root, 'src/play'))
  .filter((f) => f.endsWith('.ts') && f !== 'i18n.ts')
  .map((f) => [f, readFileSync(join(root, 'src/play', f), 'utf8')] as const);

/** Source with comments removed, so a comment may still say what a string means. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('choosing a language', () => {
  it('takes the first language the visitor prefers that the page has', () => {
    expect(pickLang(['zh-CN'])).toBe('zh');
    expect(pickLang(['zh-TW', 'en'])).toBe('zh');
    expect(pickLang(['ja-JP'])).toBe('ja');
    expect(pickLang(['en-GB'])).toBe('en');
    expect(pickLang(['fr-FR', 'ja', 'zh'])).toBe('ja');
  });

  it('falls back to English when it has none of them', () => {
    expect(pickLang(['fr-FR', 'de'])).toBe('en');
    expect(pickLang([])).toBe('en');
  });
});

describe('the strings', () => {
  it('has every key in every language, none of them blank', () => {
    const keys = Object.keys(STRINGS.zh).sort();
    for (const lang of LANGS) {
      expect(Object.keys(STRINGS[lang]).sort(), lang).toEqual(keys);
      for (const [k, v] of Object.entries(STRINGS[lang])) expect(v.trim(), `${lang}.${k}`).not.toBe('');
    }
  });

  it('keeps the same placeholders in every language', () => {
    for (const key of Object.keys(STRINGS.zh) as (keyof typeof STRINGS.zh)[]) {
      const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      for (const lang of LANGS) expect(holes(STRINGS[lang][key]), `${lang}.${key}`).toEqual(holes(STRINGS.zh[key]));
    }
  });

  it('fills placeholders', () => {
    expect(format('{n} 秒', { n: 30 })).toBe('30 秒');
  });
});

describe('the page uses only strings that exist', () => {
  it('names only existing keys in its markup', () => {
    const used = [...html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(10);
    for (const k of used) expect(STRINGS.zh, k).toHaveProperty(k);
  });

  it('names only existing keys in its scripts', () => {
    const used = scripts.flatMap(([, src]) => [...code(src).matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]!));
    expect(used.length).toBeGreaterThan(5);
    for (const k of used) expect(STRINGS.zh, k).toHaveProperty(k);
  });

  it('has no sentence written straight into the markup, apart from the title', () => {
    const body = html.replace(/<title>[^<]*<\/title>/, '').replace(/<!--[\s\S]*?-->/g, '');
    const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(text).toBe('');
    expect(body).not.toMatch(/aria-label="[^"]+"/);
  });

  it('has no Chinese or Japanese written straight into its scripts', () => {
    for (const [file, src] of scripts) expect(code(src), file).not.toMatch(/[぀-ヿ一-鿿]/);
  });
});
