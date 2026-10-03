#!/usr/bin/env node
/**
 * Exports nothing imports.
 *
 * Written after `wakeBeat` — the only code that resumed the AudioContext —
 * was orphaned by deleting the component that called it. Type checking was
 * clean, the build passed, screenshots looked right, and the product may have
 * been silent for three commits. An unreferenced export is not always a bug,
 * but it is always a question worth asking, and asking it costs a second.
 *
 * Deliberately crude: it matches identifiers textually rather than resolving
 * the module graph, so it under-reports (a name used anywhere counts as used)
 * and never invents work. Read the output as "look at these", not "delete
 * these".
 *
 * The repository already carries orphans that predate this check, so a bare
 * list can never reach zero and would never gate anything. It is therefore
 * baselined: `--write-baseline` records today's set, and a normal run fails
 * only on orphans that are *new*. That is the shape of the bug it exists to
 * catch — a call site removed, not a long-dead export.
 *
 *   node scripts/find-orphan-exports.mjs [--types] [--write-baseline]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
/*
 * `packages/contracts` is deliberately absent. A schema package's job is to
 * publish its whole surface, and consumers usually take only the inferred
 * type, so almost every schema there reads as unreferenced. Including it
 * produced 40-odd entries of pure noise — and a checker nobody runs is the
 * same as no checker.
 */
const ROOTS = [
  'apps/web/src',
  'apps/api/src',
  'apps/worker/src',
  'packages/db/src',
  'packages/providers/src',
  // Tests are call sites. Leaving them out reported a dozen helpers as
  // orphans purely because only the suite used them.
  'tests',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'migrations']);
const CODE = /\.(ts|tsx|mjs)$/;

/** Entry points and barrels: unreferenced by design, not by accident. */
const ENTRY = /(^|\/)(main|index|lib|cli|seed|server|worker|routes|context|config)\.(ts|tsx|mjs)$/;

/**
 * A default-exported React page is reached through the router by module path,
 * so its component name is legitimately never mentioned elsewhere.
 */
const ROUTE_PAGE = /apps\/web\/src\/pages\//;

const includeTypes = process.argv.includes('--types');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (CODE.test(name)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => {
  try {
    return walk(join(ROOT, r));
  } catch {
    return [];
  }
});

const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

// `export function foo`, `export const foo =`, `export async function foo`,
// `export class Foo`, and (with --types) `export interface/type Foo`.
const VALUE_EXPORT = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
const TYPE_EXPORT = /^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * What counts as referring to an export.
 *
 * The test was `\bNAME\b` over the raw source, so *mentioning* a name was
 * enough: `expect(describeError({ code: 'ER_LOCK_DEADLOCK' }))` in a test
 * un-orphaned the constant of that name, which is still used only inside its
 * own file. The gate then offered to record it as referenced, which would have
 * written down something untrue and quietly lost a real orphan.
 *
 * Quoted strings and comments are removed first. Template literals are NOT:
 * `${NAME}` inside one is a genuine reference, and dropping backticks would
 * invent orphans instead of hiding them — the opposite mistake and the worse
 * one, since this gate is read as "nothing is dead".
 */
function referencable(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

const searchable = new Map([...sources].map(([f, src]) => [f, referencable(src)]));

const findings = [];
for (const [file, src] of sources) {
  if (ENTRY.test(file) || ROUTE_PAGE.test(file)) continue;
  const patterns = includeTypes ? [VALUE_EXPORT, TYPE_EXPORT] : [VALUE_EXPORT];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      const word = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
      let used = false;
      for (const [other, otherSrc] of searchable) {
        if (other === file) continue;
        if (word.test(otherSrc)) {
          used = true;
          break;
        }
      }
      if (!used) {
        findings.push({
          file: relative(ROOT, file),
          line: src.slice(0, m.index).split('\n').length,
          name,
        });
      }
    }
  }
}

const BASELINE = join(ROOT, 'scripts/orphan-exports.baseline.json');
// Keyed by file+name, not by line: moving code must not look like a new orphan.
const key = (f) => `${f.file}#${f.name}`;
const current = findings.map(key).sort();

if (process.argv.includes('--write-baseline')) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`baseline written: ${current.length} known orphan(s)`);
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? new Set(JSON.parse(readFileSync(BASELINE, 'utf8'))) : new Set();
const fresh = findings.filter((f) => !baseline.has(key(f)));
const fixed = [...baseline].filter((k) => !current.includes(k));

if (fixed.length) {
  console.log(`✓ ${fixed.length} baselined orphan(s) now referenced or removed:`);
  for (const k of fixed) console.log(`    ${k}`);
  console.log('  run with --write-baseline to record that.\n');
}

if (fresh.length === 0) {
  console.log(`✓ no new orphaned exports (${files.length} files, ${baseline.size} baselined)`);
  process.exit(0);
}

console.log(`${fresh.length} NEW export(s) referenced nowhere else:\n`);
for (const f of fresh.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(`  ${f.file}:${f.line}  ${f.name}`);
}
console.log('\nEach is a question, not a verdict: dead code, a lost call site, or an intended public API.');
process.exit(1);
