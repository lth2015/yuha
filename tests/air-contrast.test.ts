/**
 * Text on the instrument is readable (#34): every pairing of text and
 * background the page actually uses clears WCAG AA, 4.5:1, computed from the
 * colours in its stylesheet rather than judged by eye.
 *
 * No database: a file and arithmetic.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '../apps/air/src/play/play.css'), 'utf8');
const token = (name: string) => {
  const m = new RegExp(`--yuha-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css);
  if (!m) throw new Error(`--yuha-${name} is not defined in play.css`);
  return m[1]!;
};

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** [text, background, where] — each pairing that appears on the page. */
const PAIRS: [string, string, string][] = [
  ['ink', 'bg', 'paper: 完成, 返回 on the stage'],
  ['muted', 'bg', 'the hint, the length line'],
  ['surface', 'ink', 'primary buttons: 回放, 聆听, 去 YUHA'],
  ['ink', 'surface', 'secondary buttons, the card, the toast'],
  ['muted', 'surface', 'the card’s labels and fine print'],
  ['ink', 'petal-soft', 'the chosen voice on the card: 有人声 / 纯音乐'],
];

describe('contrast', () => {
  for (const [text, bg, where] of PAIRS) {
    it(`${text} on ${bg} (${where}) clears 4.5:1`, () => {
      expect(contrast(token(text), token(bg))).toBeGreaterThanOrEqual(4.5);
    });
  }
});

/* 春江 paints a pale lake under the hint (light.ts); its darkest point there is
   the water just below the far shore. */
it('the hint is readable on the 春江 lake where it sits', () => {
  expect(contrast(token('muted'), '#eceee7')).toBeGreaterThanOrEqual(4.5);
});
