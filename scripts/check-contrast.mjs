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
 * Glass is computed, not stood in for. The note here used to say the rendered
 * colour of a translucent surface "is not knowable from the stylesheet" and
 * used `--surface-soft` as a conservative proxy. It was conservative only by
 * accident of the current numbers: the glass sits at 78% white, so it composites
 * lighter than that proxy and dark text has more contrast than measured, not
 * less. Make the glass thinner — which is the whole point of a material pass —
 * and the proxy silently becomes optimistic while the gate stays green. A check
 * standing in for the thing it cannot see is the failure this file already
 * carries a scar from; so now it composites.
 *
 * (That note also called `--surface-soft` "the lightest opaque surface". It is
 * the darkest — #eceee7 against #f6f5f0 — which is why it was the binding case.
 * The behaviour was right and the sentence was wrong, which is its own lesson
 * about comments that are never executed.)
 */
const SURFACES = ['--bg', '--surface-solid', '--surface-soft'];

/**
 * Filled controls, which carry one text colour rather than the whole palette.
 *
 * These cannot go in SURFACES: that list is crossed with every text token, and
 * nobody puts `--muted` on a primary button, so it would fail on combinations
 * that do not exist. Each pair here is one that does.
 *
 * The primary is the brand coral with ink on it. White on `--petal` is 2.98:1
 * and fails; darkening the coral until white passes reaches brown. This pass
 * exists so that choice cannot be undone by eye — change either token and the
 * build says so.
 */
const FILLED = [
  { surface: '--petal', text: '--ink', floor: 4.5, what: 'the primary button' },
  { surface: '--petal-soft', text: '--ink', floor: 4.5, what: 'a chosen chip' },
];

/**
 * The darkest the backdrop behind a glass panel can get.
 *
 * The light field paints a radial gradient ending at `--bg-deep`, then lays
 * three coloured lobes over it at up to 34% alpha. Those lobes are warm and
 * mid-toned, so they pull the green and blue channels *down*: the darkest point
 * is bg-deep with every lobe at full strength, not bg-deep alone. Dark text on
 * a light surface loses contrast as the surface darkens, so this is the case
 * that binds.
 *
 * Kept in step with styles.css by hand. If a lobe's colour or alpha changes
 * there and not here, the gate measures a backdrop that no longer exists —
 * which is why the numbers are named and sourced rather than inlined.
 */
const LOBES = [
  { name: 'petal', rgb: [255, 168, 133], alpha: 0.34 },
  { name: 'violet', rgb: [178, 160, 240], alpha: 0.3 },
  { name: 'cyan', rgb: [168, 206, 170], alpha: 0.32 },
];

/** Source-over compositing on rgb triples (the `over` below takes hex). */
function composite(base, src, a) {
  return base.map((b, i) => Math.round(a * src[i] + (1 - a) * b));
}

/**
 * The glass surfaces text actually sits on, as rendered.
 *
 * Each entry is the alpha of a `--glass*` token laid over the darkest backdrop
 * the light field can produce. `backdrop-filter`'s blur does not move the mean
 * colour of a smooth gradient, so it is ignored; `saturate` pushes channels
 * apart around their mean and `brightness` scales them, and both are applied
 * where a rule uses them.
 */
function glassSurfaces() {
  const deep = rgb(readToken('--bg-deep') ?? '#efede6');
  /*
   * One lobe, not all three.
   *
   * Compositing all three at their centre alpha was the first model and it is
   * not a case that exists: the lobes are pinned to different corners in
   * styles.css (petal top-left, violet off the right edge, cyan bottom-left)
   * and each falls to transparent well before another's centre. Stacking them
   * failed the build on a geometry the stylesheet forbids, which would have
   * taught everyone to distrust this gate.
   *
   * The darkest point a panel can actually sit over is the centre of whichever
   * single lobe darkens most, over the gradient's dark end.
   */
  const darkestBackdrop = LOBES
    .map((l) => composite(deep, l.rgb, l.alpha))
    .reduce((a, b) => (luminance(a) <= luminance(b) ? a : b));
  const out = [['light-field (no glass)', hex(darkestBackdrop)]];
  for (const [name, alpha] of Object.entries(GLASS_ALPHAS)) {
    out.push([name, hex(composite(darkestBackdrop, [255, 255, 255], alpha))]);
  }
  return out;
}

const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * Alpha of each translucent surface token, read from styles.css. Named here so
 * a changed token fails loudly rather than being measured as its old value.
 */
const GLASS_ALPHAS = Object.fromEntries(
  // Discovered, not listed. A hand-written list is how a new tier of glass gets
  // added and goes unmeasured — the same shape as the fallback block this file
  // already checks by collecting rather than remembering.
  [...src.matchAll(/(--glass[\w-]*):\s*rgba\([^)]*?,\s*([0-9.]+)\s*\)/g)]
    // Surfaces only. `--glass-edge` is a hairline and `--glass-spec` a 1px
    // highlight; no text sits on either, and measuring against them reports a
    // ratio for a background that does not exist.
    .filter((m) => !/-(edge|spec)$/.test(m[1]))
    .map((m) => [m[1], Number(m[2])]),
);
if (!Object.keys(GLASS_ALPHAS).length) {
  console.log('✗ found no --glass* rgba token in styles.css');
  process.exit(1);
}

function readToken(name) {
  // First definition wins, which is the `:root` block.
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(src);
  return m ? m[1] : null;
}

/** `readToken` reads colours; this reads a length, for the type scale. */
function readLengthToken(name) {
  const m = new RegExp(`${name}:\\s*([\\d.]+)px\\s*;`).exec(src);
  return m ? Number(m[1]) : null;
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
// The composited glass, measured rather than assumed. If a material pass makes
// a surface thinner, the number moves here and the gate notices.
surfaces.push(...glassSurfaces());

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

/*
 * Every translucent surface must have an opaque fallback.
 *
 * `prefers-reduced-transparency` and `prefers-contrast: more` are the reader
 * saying the material is in the way. Honouring them is not optional polish —
 * it is the setting Apple had to add back to Liquid Glass mid-beta — and it is
 * the kind of rule that rots silently: a new glass surface gets added, nobody
 * remembers the fallback block, and the setting quietly stops covering the
 * page. So the gate counts them instead of trusting memory.
 */
const glassSelectors = new Set();
// Comments sit between rules and their text reaches the selector capture, so a
// sentence about glass was read as a selector named "the room (brightness)".
const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
for (const m of noComments.matchAll(/([^{}]+)\{([^}]*backdrop-filter\s*:\s*blur[^}]*)\}/g)) {
  for (const sel of m[1].split(',')) {
    const name = sel.trim().split('\n').pop().trim();
    // Only real selectors: a class or element, optionally with state.
    if (!/^[.#]?[a-zA-Z][\w-]*([.:#][\w-]+(\([^)]*\))?)*$/.test(name)) continue;
    glassSelectors.add(name.replace(/:[a-z-]+(\([^)]*\))?$/, ''));
  }
}
const fallbackBlock = /@media \(prefers-reduced-transparency: reduce\)[^{]*\{([\s\S]*?)\n\}/.exec(src);
if (!fallbackBlock) {
  failures.push(
    'no `@media (prefers-reduced-transparency: reduce)` block: every glass surface stays ' +
      'translucent for a reader who asked the system for less transparency.',
  );
} else {
  const covered = fallbackBlock[1];
  const uncovered = [...glassSelectors].filter((sel) => !covered.includes(sel));
  if (uncovered.length) {
    failures.push(
      `translucent but with no opaque fallback: ${uncovered.join(', ')} — add them to the ` +
        'prefers-reduced-transparency block, or drop their backdrop-filter.',
    );
  }
  console.log(`\n${glassSelectors.size} translucent surface(s), all with an opaque fallback`);
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
    /*
     * Which surface this text actually sits on.
     *
     * The default is the bare light field, the darkest thing in the system, and
     * that is right for the many elements that do sit straight on the page. It
     * is wrong for text inside a panel: the synced lyric lines are children of
     * `.song-page__lyrics`, which is glass over the field, and measuring them
     * against the bare field failed the build on a surface they never touch.
     *
     * A rule may name its surface with `--contrast-on: --glass`. Doing so is a
     * claim about the DOM that this file cannot verify, so it carries the
     * evidence in a comment next to it, and a wrong name fails loudly rather
     * than being ignored.
     */
    const on = /--contrast-on:\s*(--[a-z-]+)/.exec(body);
    fades.push({
      selector,
      on: on ? on[1] : null,
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
    let candidates = surfaces;
    if (f.on) {
      candidates = surfaces.filter(([name]) => name === f.on);
      if (!candidates.length) {
        failures.push(
          `${f.selector} declares \`--contrast-on: ${f.on}\`, which is not a surface this ` +
            `gate knows (${surfaces.map(([n]) => n).join(', ')}). Fix the name or add the surface.`,
        );
        continue;
      }
    }
    const worst = candidates
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

/*
 * The sleeve reading, measured against the thing it actually sits on.
 *
 * Everything above this point reasons about tokens on page surfaces. The 温度
 * reading does not sit on a page surface: it sits on a generated gradient
 * whose colours come from CoverArt.tsx, at a position chosen by the song's
 * seed. So the gate reads the families out of the component and composites the
 * reading over each one's lit stop — the brightest ground the scrim can land
 * on — rather than trusting a comment about it. At 42% every family failed.
 *
 * The lit stop is a conservative bound: the gradient places it in x 14-86%,
 * y 8-92% while the reading is pinned near the top-left, so most seeds put
 * lighter ground elsewhere. Some put it right under the reading, and a bound
 * that holds for those holds for all of them.
 */
const TSX = readFileSync(new URL('../apps/web/src/components/CoverArt.tsx', import.meta.url), 'utf8');

/** `rgb(255 255 255 / 92%)` and `rgb(16 16 14 / 62%)`, the only form used here. */
function rgbaSpaced(value) {
  const m = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)%\s*)?\)/.exec(value);
  if (!m) return null;
  return { c: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : Number(m[4]) / 100 };
}

function block(css, selector) {
  // Literal start token, so `.cover-art__index,` in the fallback list and
  // `.now-playing__halo-art .cover-art__index` further down are not mistaken
  // for the rule itself. No glass rule nests braces, so the first `}` ends it.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = bare.indexOf(`${selector} {`);
  if (at < 0) return null;
  const open = at + selector.length + 2;
  const close = bare.indexOf('}', open);
  return close < 0 ? null : bare.slice(open, close);
}

const famBlock = /const FAMILIES = \{([\s\S]*?)\n\} as const;/.exec(TSX);
const indexBlock = block(src, '.cover-art__index');
const scaleBlock = block(src, '.cover-art__scale');

if (!famBlock || !indexBlock) {
  failures.push(
    'cannot measure the sleeve reading: ' +
      (!famBlock ? 'FAMILIES not found in CoverArt.tsx. ' : '') +
      (!indexBlock ? '.cover-art__index not found in styles.css. ' : '') +
      'One of them was renamed, and this pass must follow it rather than fall silent.',
  );
} else {
  const families = [...famBlock[1].matchAll(/(\w+):\s*\['(#[0-9A-Fa-f]{6})'/g)].map((m) => [m[1], m[2]]);
  const ink = rgbaSpaced(/color:\s*([^;]+);/.exec(indexBlock)?.[1] ?? '');
  const scrim = rgbaSpaced(/background-color:\s*([^;]+);/.exec(indexBlock)?.[1] ?? '');
  /*
   * The size may be a token now, and a regex that only reads digits quietly
   * returned its own default — the gate printed "11px" while the stylesheet
   * said `var(--t-caption)`, which is 12. A check reporting a number it never
   * read is the failure this file keeps finding elsewhere.
   */
  const sizeDecl = /font-size:\s*([^;]+);/.exec(indexBlock)?.[1]?.trim() ?? '';
  const sizeToken = /^var\((--[\w-]+)\)$/.exec(sizeDecl)?.[1];
  const size = sizeToken ? readLengthToken(sizeToken) : Number(sizeDecl.replace('px', '').trim());
  if (!Number.isFinite(size)) {
    failures.push(
      `the sleeve reading's font-size reads "${sizeDecl}", which this gate cannot ` +
        `resolve to a number. It picks the WCAG floor from the size, so it must not guess.`,
    );
  }
  const weight = Number(/font-weight:\s*(\d+)/.exec(indexBlock)?.[1] ?? 400);
  // The scale name shares the ink; if it is ever faded, that fade counts.
  const scaleAlpha = Number(/opacity:\s*([\d.]+)/.exec(scaleBlock ?? '')?.[1] ?? 1);
  // WCAG large text starts at 18.66px bold or 24px; this is neither, so 4.5.
  const floor = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;

  if (!families.length || !ink || !scrim) {
    failures.push(
      'the sleeve reading parsed to nothing usable ' +
        `(families ${families.length}, ink ${!!ink}, scrim ${!!scrim}). ` +
        'Colours must stay as six-digit hex in FAMILIES and as `rgb(r g b / a%)` here.',
    );
  } else {
    console.log(`\nsleeve reading (${size}px on each family's lit stop, scrim ${scrim.a}):`);
    const measured = families.map(([name, lit]) => {
      const ground = scrim.c.map((c, i) => scrim.a * c + (1 - scrim.a) * rgb(lit)[i]);
      const a = ink.a * scaleAlpha;
      const text = ink.c.map((c, i) => a * c + (1 - a) * ground[i]);
      return [name, ratioRaw(text, ground)];
    });
    measured.sort((a, b) => a[1] - b[1]);
    console.log(`  ${measured.map(([n, v]) => `${n} ${v.toFixed(2)}`).join('  ')}`);
    for (const [name, got] of measured) {
      if (got < floor) {
        // Name the cause that actually moved, not a generic one: a faded
        // scale name is the likeliest edit here and darkening the scrim is
        // the wrong answer to it.
        const fix =
          scaleAlpha < 1
            ? `.cover-art__scale fades the scale name to ${scaleAlpha}; the digits and ` +
              `the letters share one ink, so raise that back toward 1 or darken the scrim.`
            : `Darken the scrim on .cover-art__index, or darken that family's first ` +
              `colour in CoverArt.tsx.`;
        failures.push(
          `the sleeve reading is ${got.toFixed(2)}:1 over the lit stop of \`${name}\` ` +
            `(scrim ${scrim.a}), below ${floor}:1. ${fix}`,
        );
      }
    }
  }
}

console.log('\nfilled controls:');
for (const f of FILLED) {
  const bg = readToken(f.surface);
  const fg = readToken(f.text);
  if (!bg || !fg) {
    failures.push(`${f.what}: ${!bg ? f.surface : f.text} is not a hex token in :root`);
    continue;
  }
  const got = ratio(bg, fg);
  console.log(`  ${f.what.padEnd(24)} ${f.text} on ${f.surface}  ${got.toFixed(2)}  (min ${f.floor})`);
  if (got < f.floor) {
    failures.push(
      `${f.what} renders ${f.text} on ${f.surface} at ${got.toFixed(2)}:1, below ${f.floor}:1`,
    );
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
