#!/usr/bin/env node
/**
 * The three dictionaries must agree.
 *
 * Written while redesigning the studio, which removed 13 keys and added 10
 * across zh/ja/en in one edit. Missing keys fall back to Chinese rather than
 * throwing, so a dropped ja key ships as Chinese text inside a Japanese page
 * and nothing anywhere reports it.
 *
 * It checks two things:
 *
 *   keys        — every key present in all three dictionaries.
 *   placeholders — the same {tokens} in each translation of a key. This is
 *                  the one that actually bites: a translation missing {n}
 *                  silently drops the number, and one carrying a token the
 *                  call site does not pass renders the literal braces. The
 *                  home composer shipped a `.replace()` against a token its
 *                  format string never contained.
 *
 *   node scripts/check-i18n.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const FILE = new URL('../apps/web/src/lib/i18n.tsx', import.meta.url);
const src = readFileSync(FILE, 'utf8');
const LANGS = ['zh', 'ja', 'en'];

/** The object literal after `const <lang>: Dict = {`, by brace matching. */
function block(lang) {
  const start = src.indexOf(`const ${lang}: Dict = {`);
  if (start < 0) throw new Error(`no dictionary named ${lang}`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(i + 1, j);
    }
  }
  throw new Error(`unterminated dictionary ${lang}`);
}

// Not line-anchored: the ja and en dictionaries put two entries on one
// line in places, and an anchored pattern silently reported the second of
// each pair as missing from those two languages.
const ENTRY = /(?:^|[{,])\s*'([^']+)':\s*(['"])((?:\\.|(?!\2).)*)\2/gm;
const TOKEN = /\{(\w+)\}/g;

const dicts = new Map();
for (const lang of LANGS) {
  const body = block(lang);
  const d = new Map();
  ENTRY.lastIndex = 0;
  let m;
  while ((m = ENTRY.exec(body)) !== null) {
    if (d.has(m[1])) {
      console.log(`✗ ${lang}: duplicate key '${m[1]}' — the later one silently wins`);
      process.exit(1);
    }
    d.set(m[1], m[3]);
  }
  dicts.set(lang, d);
}

const problems = [];
const all = [...new Set(LANGS.flatMap((l) => [...dicts.get(l).keys()]))].sort();

for (const key of all) {
  const missing = LANGS.filter((l) => !dicts.get(l).has(key));
  if (missing.length) {
    problems.push(`${key} — missing in ${missing.join(', ')}`);
    continue;
  }
  const sets = LANGS.map((l) => {
    const s = new Set();
    TOKEN.lastIndex = 0;
    let m;
    while ((m = TOKEN.exec(dicts.get(l).get(key))) !== null) s.add(m[1]);
    return s;
  });
  const union = new Set(sets.flatMap((s) => [...s]));
  for (const tok of union) {
    const absent = LANGS.filter((l, i) => !sets[i].has(tok));
    if (absent.length) problems.push(`${key} — {${tok}} absent in ${absent.join(', ')}`);
  }
}

/*
 * Two more questions the dictionary cannot answer about itself.
 *
 * 1. Does every key a component asks for exist? A missing key falls back to
 *    Chinese and, failing that, leaks its own id into the page. Nothing throws.
 * 2. Does every user-facing string come from the dictionary at all? Parity
 *    across three dictionaries says nothing about a component that never
 *    consults them. `Checkout` — the page where money changes hands —
 *    was hardcoded Japanese inside a page that otherwise translated.
 */
const WEB = new URL('../apps/web/src', import.meta.url).pathname.replace(/\/$/, '');
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.startsWith('i18n')) out.push(full);
  }
  return out;
}

const files = walk(WEB).map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')]);
const zhKeys = dicts.get('zh');

// --- 1. keys asked for but never defined
const USED = /\bt\(\s*'([^']+)'/g;
const missing = [];
for (const [file, src] of files) {
  USED.lastIndex = 0;
  let m;
  while ((m = USED.exec(src)) !== null) {
    if (!zhKeys.has(m[1])) {
      missing.push(`${file} asks for '${m[1]}', which no dictionary defines`);
    }
  }
}
// Template keys — t(`create.phase.${phase}`) — cannot be resolved statically and
// are deliberately not checked rather than guessed at.

// --- 2. user-facing text that never reaches the dictionary
const CJK = /[\u4e00-\u9fff\u3040-\u30ff]/;
const BASELINE_FILE = join(ROOT, 'scripts/i18n-hardcoded.baseline.json');
/**
 * Blank out comment bodies while keeping newlines, so line numbers survive.
 *
 * A line-prefix test is not enough: the note explaining *why* a hardcoded
 * Chinese string was removed quotes that string, on a continuation line that
 * begins with a letter. The checker flagged its own scar tissue.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/*
 * Both shapes text can take.
 *
 * The first version of this check only read quoted strings, reported "22
 * baselined" and passed. It could not see JSX text nodes at all — and the
 * entire 特定商取引法 table, the densest block of untranslated copy in the
 * product, is written as `<th>提供時期</th>`. 91 of them were invisible. A
 * checker that reports a clean number while missing the largest instance of
 * what it checks for is worse than no checker: /pricing was a white screen
 * for eight days for the same reason.
 */
const JSX_TEXT = />([^<>{}]*)</g;
const hardcoded = [];
for (const [file, src] of files) {
  stripComments(src).split('\n').forEach((line, i) => {
    const at = () => hardcoded.push(`${file}:${i + 1}`);
    const inString = /(['"])((?:\\.|(?!\1).)*)\1/g;
    let m;
    while ((m = inString.exec(line)) !== null) {
      if (CJK.test(m[2])) at();
    }
    JSX_TEXT.lastIndex = 0;
    while ((m = JSX_TEXT.exec(line)) !== null) {
      if (CJK.test(m[1])) at();
    }
  });
}
const uniqueHardcoded = [...new Set(hardcoded)].sort();
const hcBaseline = existsSync(BASELINE_FILE)
  ? new Set(JSON.parse(readFileSync(BASELINE_FILE, 'utf8')))
  : new Set();

if (process.argv.includes('--write-baseline')) {
  writeFileSync(BASELINE_FILE, `${JSON.stringify(uniqueHardcoded, null, 2)}\n`);
  console.log(`hardcoded-string baseline written: ${uniqueHardcoded.length} known`);
  process.exit(0);
}
const freshHardcoded = uniqueHardcoded.filter((h) => !hcBaseline.has(h));

/*
 * Debt that has been paid off, reported.
 *
 * Without this the register only ever grows stale: four files were translated
 * in full while the baseline still claimed 116 outstanding sites, so the
 * number in the build log described a codebase that no longer existed. The
 * sibling orphan-export check has always reported this; this one did not.
 */
const fixedHardcoded = [...hcBaseline].filter((k) => !uniqueHardcoded.includes(k));
if (fixedHardcoded.length) {
  const byFile = new Map();
  for (const k of fixedHardcoded) {
    const file = k.slice(0, k.lastIndexOf(':'));
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  console.log(`✓ ${fixedHardcoded.length} baselined string(s) now come from the dictionary:`);
  for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${file}  ${n}`);
  }
  console.log('  run with --write-baseline to record that.\n');
}

for (const m of missing) problems.push(m);
for (const h of freshHardcoded) problems.push(`${h} — user-facing text not from the dictionary`);

if (problems.length) {
  console.log(`${problems.length} dictionary problem(s):\n`);
  for (const p of problems) console.log(`  ${p}`);
  if (freshHardcoded.length) {
    console.log('\nA hardcoded string is one language in a product that has three.');
    console.log('Move it into i18n.tsx, or --write-baseline if it is genuinely not user-facing.');
  }
  process.exit(1);
}

console.log(`✓ ${all.length} keys agree across ${LANGS.join('/')} (keys and placeholders)`);
console.log(`✓ every key used in ${files.length} files is defined`);
console.log(`✓ no new hardcoded UI strings (${hcBaseline.size} baselined)`);
