/**
 * After every test that touched the database, the logic rules
 * (packages/db/src/invariants.ts) must hold over whatever it left behind.
 *
 * A test asserts what its author thought of. This asserts what nobody did:
 * that the flow under test did not also leave a delivered job without a
 * song, or a credit both spent and returned, somewhere the test never
 * looked. A test that builds a breach on purpose — the rules' own tests,
 * the reconciliation tests — names it with `allowInvariantBreach`.
 */
import { appendFileSync } from 'node:fs';
import { afterEach, expect } from 'vitest';
import { checkInvariants, dbReady } from '@yuha/db';

const allowed = new Set<string>();

/** This test breaks these rules deliberately; do not fail it for that. */
export function allowInvariantBreach(...names: string[]): void {
  for (const n of names) allowed.add(n);
}

afterEach(async () => {
  const allow = new Set(allowed);
  allowed.clear();
  if (!dbReady()) return;
  let results;
  try {
    results = await checkInvariants();
  } catch {
    return; // the pool closed, or this file never had a schema
  }
  const broken = results.filter((r) => r.count > 0 && !allow.has(r.name));
  if (!broken.length) return;
  const audit = process.env['INVARIANT_AUDIT'];
  const state = expect.getState();
  if (audit) {
    appendFileSync(audit, JSON.stringify({ file: state.testPath, test: state.currentTestName, broken: broken.map((b) => [b.name, b.count]) }) + '\n');
    return;
  }
  throw new Error(
    `this test left data that breaks a logic rule (docs/agents/CODEX_COLLABORATION.md):\n` +
      broken.map((b) => `  ${b.name} — ${b.rule}: ${b.count} (e.g. ${b.sample.join(', ')})`).join('\n'),
  );
});
