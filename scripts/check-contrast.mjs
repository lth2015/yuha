#!/usr/bin/env node
/**
 * Ink tokens must clear WCAG AA against the page.
 *
 * `styles.css` used to carry the line "ink 18.2:1, muted 7.6:1, faint 4.3:1"
 * as a comment. 4.3 is below the 4.5:1 floor for normal text, and `--faint` is
 * used at 11-13px in every one of its six call sites — small text, so the 3:1
 * large-text allowance does not apply. The measurement was taken, written
 * down, and shipped. A number in a comment is a note; this makes it a gate.
 *
 *   node scripts/check-contrast.mjs
 */
import { readFileSync } from 'node:fs';

const CSS = new URL('../apps/web/src/styles.css', import.meta.url);
const src = readFileSync(CSS, 'utf8');

/** Tokens that carry text, and the minimum each must hold. */
const TEXT_TOKENS = {
  '--ink': 4.5,
  '--muted': 4.5,
  '--faint': 4.5,
  '--link': 4.5,
  '--danger': 4.5,
  '--ok': 4.5,
  '--warning': 4.5,
  '--petal': 4.5,
};

/**
 * Every background text actually sits on — not just the page.
 *
 * The first version of this check measured against `--bg` alone and passed
 * `--faint` at 5.31:1. But `--faint` is used *inside panels*, and a panel sits
 * on `--surface-soft`, which is lighter: the real ratio there was 4.44:1, still
 * failing, with a green build. The gate written to stop a contrast failure
 * shipped one of its own, for exactly the reason recorded as rule 10 — a check
 * has to be asked what it cannot see.
 *
 * Glass surfaces are translucent over a moving light field, so their rendered
 * colour is not knowable from the stylesheet. `--surface-soft` is the lightest
 * opaque surface in the system and is used as the conservative stand-in.
 */
const SURFACES = ['--bg', '--surface-solid', '--surface-soft'];

function readToken(name) {
  // First definition wins, which is the `:root` block.
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(src);
  return m ? m[1] : null;
}

function rgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
function ratio(a, b) {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

const surfaces = [];
for (const name of SURFACES) {
  const value = readToken(name);
  if (!value) {
    console.log(`✗ could not read ${name} from styles.css`);
    process.exit(1);
  }
  surfaces.push([name, value]);
}

const failures = [];
const rows = [];
for (const [token, min] of Object.entries(TEXT_TOKENS)) {
  const value = readToken(token);
  if (!value) {
    failures.push(`${token} — not found in :root`);
    continue;
  }
  const ratios = surfaces.map(([name, bg]) => [name, ratio(value, bg)]);
  const worst = ratios.reduce((a, b) => (a[1] <= b[1] ? a : b));
  rows.push(
    `  ${token.padEnd(10)} ${value.padEnd(9)} ` +
      ratios.map(([n, r]) => `${n.replace('--', '')} ${r.toFixed(2)}`).join('  ') +
      `   (min ${min})`,
  );
  if (worst[1] < min) {
    failures.push(`${token} is ${worst[1].toFixed(2)}:1 on ${worst[0]}, below ${min}:1`);
  }
}

console.log(`contrast on ${surfaces.map(([n]) => n).join(', ')}:`);
for (const r of rows) console.log(r);

if (failures.length) {
  console.log(`\n${failures.length} token(s) below the floor:\n`);
  for (const f of failures) console.log(`  ${f}`);
  console.log('\nRaise the token, or if it is only ever used at >=18.66px, move it out of TEXT_TOKENS and say where.');
  process.exit(1);
}
console.log(`\n✓ ${rows.length} text tokens clear WCAG AA on every surface they sit on`);
