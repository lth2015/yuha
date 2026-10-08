/**
 * Every mutation in `scripts/mutation-check.mjs` still applies.
 *
 * A mutation is a defect written back into the code with a test that must
 * fail. When a refactor moves the line it was written against, the `from`
 * text stops matching and the mutation silently stops testing anything — and
 * a dead mutation reads exactly like a passing one, because nobody runs the
 * full set often (it rebuilds and runs a suite per entry, which is minutes).
 *
 * Four had died that way by the time this was written: the customer search's
 * SQL was rewritten to use the indexed generated column, and three mutations
 * aimed at its previous shape quietly became no-ops. The same check also
 * found two defects sitting in the working tree, left behind by mutation runs
 * that were interrupted between writing the defect and restoring the file.
 *
 * Cheap enough to run every time: it reads files and compares strings, with
 * no build and no database.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the mutation list', () => {
  it('every entry still matches the code it is written against', () => {
    const root = resolve(import.meta.dirname, '..');
    let out: string;
    try {
      out = execFileSync('node', ['scripts/mutation-check.mjs', '--anchors'], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch (err) {
      // The script prints which ones, and why each is a test nobody runs.
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
    expect(out).toContain('anchors all still match');
    /*
     * And it checked a plausible number of them, so a `--anchors` that
     * silently found no mutations at all cannot pass. The count is of
     * ANCHORS, not of entries: one mutation carries two edits, which is also
     * why the number printed used to be one short.
     */
    const checked = Number(/✓ (\d+) mutation anchors/.exec(out)?.[1] ?? 0);
    expect(checked).toBeGreaterThan(80);
  });
});
