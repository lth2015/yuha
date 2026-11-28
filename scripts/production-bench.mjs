#!/usr/bin/env node
/**
 * Writes the production benchmark manifest the DGX runner reads.
 *
 *   node scripts/production-bench.mjs          # write it
 *   node scripts/production-bench.mjs --check  # fail if the committed one is stale
 *
 * Input:  scripts/production-bench/briefs.json
 * Output: deploy/dgx/music/server/fixtures/production_bench.json — committed,
 *         so the DGX needs neither Node nor this repository's build to run it.
 * Needs `pnpm build` (imports @yuha/contracts and @yuha/providers from dist).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './lib/production-bench.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIEFS = join(root, 'scripts/production-bench/briefs.json');
export const MANIFEST = join(root, 'deploy/dgx/music/server/fixtures/production_bench.json');

const text = `${JSON.stringify(buildManifest(JSON.parse(readFileSync(BRIEFS, 'utf8'))), null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(MANIFEST, 'utf8'); } catch { /* missing is stale */ }
  if (current !== text) {
    console.error('production_bench.json is stale: run `node scripts/production-bench.mjs` and commit it.');
    process.exit(1);
  }
  console.log('✓ production_bench.json matches briefs.json and the current compiler');
} else {
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, text);
  const m = JSON.parse(text);
  console.log(`wrote ${m.entries.length} renders (${m.entries.length / 2} A/B pairs) to ${MANIFEST}`);
}
