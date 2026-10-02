/**
 * `maxLength` counts UTF-16 code units. Everything else here counts code points.
 *
 * The contract measures in code points (`[...v].length`), the counters beside
 * the fields print code points, and the safety screen refuses on code points.
 * `maxLength` does not: it is a DOM attribute defined over UTF-16 code units,
 * so one astral character — any emoji — spends two of its budget and one of
 * everyone else's.
 *
 * The title field had `maxLength={TITLE_MAX_CODEPOINTS}`, so a title of emoji
 * stopped accepting input at 60 while the counter beside it read "60 / 120"
 * and the server would have taken all 120. The reader is stopped half-way by
 * a number that promised twice as much. The composer's title input had the
 * same shape with the limit hard-coded, which would also have drifted silently
 * the day the constant changed.
 *
 * A field does not need `maxLength` to be safe: the counter shows the limit,
 * the submit button is disabled past it, and the server refuses it with a
 * message naming the field. Those three agree with each other in code points.
 *
 * This refuses `maxLength` set from a *_MAX_CODEPOINTS constant, or from a
 * literal that happens to equal one of their values.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACTS = new URL('../packages/contracts/src/generation.ts', import.meta.url);
const WEB = new URL('../apps/web/src/', import.meta.url).pathname;

const limits = new Map();
for (const m of readFileSync(CONTRACTS, 'utf8').matchAll(/export const (\w*_MAX_CODEPOINTS) = (\d+)/g)) {
  limits.set(m[1], Number(m[2]));
}
if (!limits.size) {
  console.log('✗ no *_MAX_CODEPOINTS constants found in the contracts; this gate has lost its subject');
  process.exit(1);
}
const byValue = new Map([...limits].map(([k, v]) => [v, k]));

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) files.push(p);
  }
})(WEB);

const failures = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const m = /maxLength=\{([^}]+)\}/.exec(line);
    if (!m) return;
    const expr = m[1].trim();
    const named = [...limits.keys()].find((k) => expr.includes(k));
    const asLiteral = /^\d+$/.test(expr) ? byValue.get(Number(expr)) : undefined;
    const culprit = named ?? asLiteral;
    if (!culprit) return;
    failures.push(
      `${file.replace(WEB, 'apps/web/src/')}:${i + 1} sets maxLength from ${
        named ? `\`${named}\`` : `\`${expr}\`, the value of \`${asLiteral}\``
      }. maxLength counts UTF-16 code units and ${culprit} counts code points, so a ` +
        `field of emoji stops at half the number the counter shows. Drop maxLength and ` +
        `let the counter, the disabled submit and the server agree in code points.`,
    );
  });
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n`);
  for (const f of failures) console.log(`  ${f}\n`);
  process.exit(1);
}
console.log(`✓ no maxLength is set from a code-point limit (${files.length} files, ${limits.size} limits)`);
