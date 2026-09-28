#!/usr/bin/env node
/**
 * The suite tests `dist/`, so a stale `dist/` is a green run that proves nothing.
 *
 * `tests/` imports `@yuha/api`, `@yuha/db`, `@yuha/providers`, `@yuha/contracts`
 * and `@yuha/worker` by package name. Every one of those resolves through its
 * package.json `exports` to `./dist/…`, and `vitest.config.ts` sets no
 * `resolve.alias`, so not one line of `src/` is under test. `pnpm test` does not
 * depend on `pnpm build`, which means the normal edit-and-test loop tests the
 * previous build.
 *
 * On 2026-09-28 that produced eleven failures across five files — a 404 on a
 * route that existed, a 200 where a guard refused, a fixture error that was
 * never raised — and every one of them read as a regression in code that was
 * correct. Rebuilding fixed all eleven. The same mechanism runs the other way
 * and is worse: edit `src`, run `pnpm test`, watch the old build pass, and ship.
 *
 * So this compares timestamps rather than changing what is tested. Testing the
 * built artifact is the honest thing to test — it is what ships — and the defect
 * was never that, it was that the artifact could be older than the source
 * silently. Now it says so.
 *
 * Deliberately no --force and no environment escape: a gate with a skip flag
 * gets skipped. To test an old build on purpose, run `vitest run` directly and
 * own it.
 *
 *   node scripts/check-build-fresh.mjs
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Not `new URL('..', import.meta.url).pathname`: that stays percent-encoded, so
// joining it breaks as soon as a directory in the path has a space in its name.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Only the workspaces `tests/` imports through a package entry point. Add to
 * this list when a new workspace joins that set — a name missing here is not
 * checked, and nothing else will notice.
 */
const WORKSPACES = [
  'packages/contracts',
  'packages/db',
  'packages/providers',
  'apps/api',
  'apps/worker',
];

/** Newest file under `dir`, by mtime. `null` when the tree has no files. */
function newest(dir) {
  let best = null;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile()) {
        const { mtimeMs } = statSync(p);
        if (!best || mtimeMs > best.mtimeMs) best = { path: p, mtimeMs };
      }
    }
  };
  walk(dir);
  return best;
}

const stale = [];
const missing = [];

for (const ws of WORKSPACES) {
  const src = join(ROOT, ws, 'src');
  const dist = join(ROOT, ws, 'dist');

  // A listed workspace with no src/ is a mistake in WORKSPACES above, not a
  // build problem, and it should say which rather than throwing ENOENT.
  if (!existsSync(src)) {
    console.error(`check-build-fresh: ${ws} has no src/ — is WORKSPACES out of date?`);
    process.exit(2);
  }
  if (!existsSync(dist)) {
    missing.push(ws);
    continue;
  }

  const newestSrc = newest(src);
  const newestDist = newest(dist);

  // A dist directory that exists but holds nothing is the same as no build.
  if (!newestDist) {
    missing.push(ws);
    continue;
  }
  if (!newestSrc) continue;

  if (newestSrc.mtimeMs > newestDist.mtimeMs) {
    stale.push({
      ws,
      src: relative(ROOT, newestSrc.path),
      behindSeconds: Math.round((newestSrc.mtimeMs - newestDist.mtimeMs) / 1000),
    });
  }
}

if (!missing.length && !stale.length) {
  console.log(`✓ dist is newer than src in all ${WORKSPACES.length} workspaces the suite imports`);
  process.exit(0);
}

console.error('The suite imports dist/, and dist/ is not current. It would test the previous build.\n');
for (const ws of missing) {
  console.error(`  ${ws} — no build output at all`);
}
for (const { ws, src, behindSeconds } of stale) {
  console.error(`  ${ws} — dist is ${behindSeconds}s behind ${src}`);
}
console.error('\nRun `pnpm build` first, or `pnpm build && pnpm test`.');
process.exit(1);
