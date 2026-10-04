/**
 * Text sizes come from the scale, not from a number someone picked.
 *
 * There were eleven sizes between 11px and 22px. On the song page alone the
 * eyebrow was 11, the note 12, the terms 13, the buttons 14 and the meta 15 —
 * five inside a four-pixel span, in one column. No one can name the difference
 * between any two of them; what they can see is that nothing lines up, and the
 * word for that is "unfinished".
 *
 * So the UI range is four tokens and the headings are two more, and this
 * refuses a raw px value inside that range. Above it, display type stays as
 * `clamp()` — one per page, scaling with the viewport, not part of this
 * rhythm — and those are allowed through.
 *
 * Not a style preference. A scale is what makes a page look drawn rather than
 * assembled, and the only way one survives is if adding the twelfth size is
 * harder than reusing the right one.
 */
import { readFileSync } from 'node:fs';

const CSS = new URL('../apps/web/src/styles.css', import.meta.url);
const src = readFileSync(CSS, 'utf8');
const bare = src.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Derived from the scale, not written beside it.
 *
 * It was 23, which excluded exactly the top of the scale it guards: `--t-heading`
 * is 24px, so a raw `font-size: 24px` passed and the twelfth size could walk
 * back in at the top. The bound is the largest token, so every value the scale
 * actually names is covered and only genuinely larger display type is free.
 */
let UI_MAX_PX = 0;

const tokens = [...bare.matchAll(/(--t-[\w-]+):\s*([\d.]+)px\s*;/g)].map((m) => ({
  name: m[1],
  px: Number(m[2]),
}));
UI_MAX_PX = Math.max(0, ...tokens.map((t) => t.px));
const scale = tokens.map((t) => `${t.name} (${t.px}px)`);
if (scale.length < 4) {
  console.log(`✗ found only ${scale.length} --t-* size token(s); the scale has gone missing`);
  process.exit(1);
}

const failures = [];
const lines = bare.split('\n');
lines.forEach((line, i) => {
  for (const m of line.matchAll(/font-size:\s*([\d.]+)px/g)) {
    const px = Number(m[1]);
    if (px > UI_MAX_PX) continue;
    failures.push(
      `apps/web/src/styles.css:${i + 1} sets font-size: ${px}px. Sizes up to ${UI_MAX_PX}px come ` +
        `from the scale — ${scale.join(', ')} — so that a page reads as drawn rather than ` +
        `assembled. Pick the one whose ROLE fits, not the nearest number.`,
    );
  }
});

if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n`);
  for (const f of failures) console.log(`  ${f}\n`);
  process.exit(1);
}
console.log(`✓ every UI text size comes from the scale (${scale.join(', ')})`);
