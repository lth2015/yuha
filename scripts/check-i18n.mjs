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
import { readFileSync } from 'node:fs';

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

if (problems.length) {
  console.log(`${problems.length} dictionary problem(s):\n`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}

console.log(`✓ ${all.length} keys agree across ${LANGS.join('/')} (keys and placeholders)`);
