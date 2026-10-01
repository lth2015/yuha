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
  // `--petal` is not a text token on the light canvas: #f46b45 is ~2.7:1 on
  // warm white, so orange *text* uses `--link` (#a33f22) per the brand spec
  // (§3). The petal stays for fills, marks and borders only.
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
/*
 * Second pass: the fade.
 *
 * The first pass reports `--muted` at 5.03:1 and is telling the truth about
 * the token. It was not telling the truth about the screen, because six rules
 * then multiplied those tokens by an `opacity` between 0.22 and 0.55 — and the
 * lyrics of a song, on the song page, rendered at 2.25:1 under a green build.
 * Rule 10 again, one layer down: the gate written to stop a contrast failure
 * could not see the property that was causing one.
 *
 * A block is checked when it sets `opacity` strictly between 0 and 1. It must
 * then also set `color: var(--token)` in the same block, so the fade can be
 * measured without resolving the cascade — refusing to guess is the point.
 * A block carrying large text may lower its floor to WCAG's 3:1 by declaring
 * `--contrast-floor: 3`, which is an inert custom property chosen over a
 * comment so that the exception is parsed rather than taken on trust.
 */
const DECORATIVE = [
  // Not text: light-field lobes, the two grain layers, the blurred halo, the
  // drifting petal, the vinyl sheen. Nothing in these carries a glyph.
  '.lightfield__lobe',
  '.lightfield__grain',
  '.app__grain',
  '.now-playing::after',
  '.now-playing__halo-art',
  '.app__drift-petal',
  '.vinyl__sheen',
];

/** Comments out, so a prose comment above a rule is never read as a selector. */
const bare = src.replace(/\/\*[\s\S]*?\*\//g, '');

const fades = [];
{
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(bare))) {
    const selector = m[1].trim().split('\n').map((l) => l.trim()).join(' ');
    const body = m[2];
    // Keyframe steps, not rules.
    if (/^(from|to)$/.test(selector) || /^[\d%.,\s]+$/.test(selector)) continue;
    if (selector.startsWith('@') || selector.startsWith(':root')) continue;
    const raw = /(?:^|;|\s)opacity:\s*([^;}]+)/.exec(body);
    if (!raw) continue;
    const literal = raw[1].trim();
    if (literal.startsWith('var(')) {
      // `opacity: var(--o-disabled)` is the one indirection allowed, because a
      // disabled control is outside the WCAG contrast requirement. Any other
      // variable would walk straight past this check.
      if (!literal.includes('--o-disabled')) {
        failures.push(
          `${selector} sets \`opacity: ${literal}\`. This gate measures literal ` +
            `opacities; name the value here, or use --o-disabled if the rule is a ` +
            `disabled state.`,
        );
      }
      continue;
    }
    const alpha = Number(literal);
    if (!Number.isFinite(alpha)) continue;
    // 0 is hidden, 1 is opaque: neither is a fade.
    if (!(alpha > 0 && alpha < 1)) continue;
    if (DECORATIVE.some((d) => selector.includes(d))) continue;
    const col = /color:\s*var\((--[a-z-]+)\)/.exec(body);
    const floor = /--contrast-floor:\s*([0-9.]+)/.exec(body);
    fades.push({
      selector,
      alpha,
      token: col ? col[1] : null,
      floor: floor ? Number(floor[1]) : 4.5,
    });
  }
}

const over = (fg, bg, a) => rgb(fg).map((c, i) => c * a + rgb(bg)[i] * (1 - a));
const ratioRaw = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
};

if (fades.length) {
  console.log('\nfaded text (colour x opacity, worst surface):');
  for (const f of fades) {
    const short = f.selector.length > 48 ? `${f.selector.slice(0, 45)}...` : f.selector;
    if (!f.token) {
      failures.push(
        `${f.selector} sets opacity ${f.alpha} without a \`color\` in the same block, ` +
          `so the rendered contrast cannot be measured. Declare the colour here, or ` +
          `list the selector in DECORATIVE with the reason it carries no text.`,
      );
      console.log(`  ${short.padEnd(50)} opacity ${f.alpha}  — colour inherited, unmeasurable`);
      continue;
    }
    const value = readToken(f.token);
    if (!value) {
      failures.push(`${f.selector} fades ${f.token}, which is not in :root`);
      continue;
    }
    const worst = surfaces
      .map(([name, bg]) => [name, ratioRaw(over(value, bg, f.alpha), rgb(bg))])
      .reduce((a, b) => (a[1] <= b[1] ? a : b));
    console.log(
      `  ${short.padEnd(50)} ${f.token} @ ${f.alpha}  ${worst[1].toFixed(2)}  (min ${f.floor})`,
    );
    if (worst[1] < f.floor) {
      failures.push(
        `${f.selector} renders ${f.token} at ${worst[1].toFixed(2)}:1 on ${worst[0]} ` +
          `(opacity ${f.alpha}), below ${f.floor}:1`,
      );
    }
  }
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}

console.log(
  `\n✓ ${rows.length} text tokens and ${fades.length} faded rules clear their floor ` +
    `on every surface they sit on`,
);
