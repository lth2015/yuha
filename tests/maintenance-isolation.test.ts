/**
 * One sweep failing must not silence the rest.
 *
 * `maintenanceLoop` once ran its eight sweeps inside a single `try`, so a throw
 * anywhere skipped everything after it — and skipped it again the next minute,
 * because the input that threw was still there. That is not hypothetical:
 * `reconcilePendingCheckouts` calls `handleCheckoutCompleted`, which throws by
 * design when a charge disagrees with the catalogue, and its query is
 * `ORDER BY created_at`. One such order at the front of the queue silenced the
 * subscription recovery sweep, the retention sweep and the ledger
 * reconciliation for good.
 *
 * It was fixed by giving each sweep its own `try`. Nothing tested that, because
 * the helper was a closure inside the loop and no harness could inject a
 * throwing sweep — so the fix for a silent, permanent, money-and-compliance
 * failure rested on reading the code. It is a named export now.
 *
 * The second half of the original incident was that nothing said which step
 * died: the catch logged "maintenance loop error" with no step name. These pin
 * the name as much as the isolation.
 */
import { describe, expect, it, vi } from 'vitest';
import { isolatedStep, type LoopLog } from '@yuha/worker/loops';

function recorder() {
  const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const log: LoopLog = (level, msg, fields = {}) => void lines.push({ level, msg, fields });
  return { log, lines };
}

describe('one maintenance step failing', () => {
  it('does not stop the steps after it', async () => {
    const { log } = recorder();
    const step = isolatedStep(log);
    const ran: string[] = [];

    await step('first', async () => { ran.push('first'); });
    await step('poison', async () => { throw new Error('charge disagrees with the catalogue'); });
    await step('retention', async () => { ran.push('retention'); });
    await step('balances', async () => { ran.push('balances'); });

    // The three that silently stopped running every minute, in the real one.
    expect(ran).toEqual(['first', 'retention', 'balances']);
  });

  it('never throws out of the step, so the loop keeps its schedule', async () => {
    const { log } = recorder();
    const step = isolatedStep(log);
    await expect(step('poison', async () => { throw new Error('boom'); })).resolves.toBeUndefined();
  });

  it('says which step failed, which the original catch did not', async () => {
    const { log, lines } = recorder();
    await isolatedStep(log)('reconcile-pending-checkouts', async () => {
      throw new Error('charge disagrees with the catalogue');
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('error');
    expect(lines[0]!.fields.step).toBe('reconcile-pending-checkouts');
    expect(String(lines[0]!.fields.err)).toContain('charge disagrees');
  });

  it('says nothing at all when the step succeeds', async () => {
    const { log, lines } = recorder();
    await isolatedStep(log)('quiet', async () => {});
    expect(lines).toEqual([]);
  });

  it('reports a throw that is not an Error, instead of logging undefined', async () => {
    // `(err as Error).message` is `undefined` for anything that is not an
    // Error, and a driver, a JSON parse or a bare `throw 'x'` all produce
    // those. The log line then names a failed step and says nothing about it,
    // which is the same blindness the step name was added to fix.
    const { log, lines } = recorder();
    const step = isolatedStep(log);

    await step('string-throw', async () => { throw 'ECONNRESET'; });
    await step('object-throw', async () => { throw { code: 'ER_LOCK_DEADLOCK' }; });
    await step('null-throw', async () => { throw null; });

    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.fields.err).toBeDefined();
    expect(String(lines[0]!.fields.err)).toContain('ECONNRESET');
    expect(String(lines[1]!.fields.err)).toContain('ER_LOCK_DEADLOCK');
    expect(String(lines[2]!.fields.err)).not.toBe('undefined');
  });

  it('isolates each step from the one before, not just the first failure', async () => {
    const { log, lines } = recorder();
    const step = isolatedStep(log);
    const ran: string[] = [];
    for (const name of ['a', 'b', 'c', 'd']) {
      await step(name, async () => {
        if (name === 'b' || name === 'c') throw new Error(`${name} failed`);
        ran.push(name);
      });
    }
    expect(ran).toEqual(['a', 'd']);
    expect(lines.map((l) => l.fields.step)).toEqual(['b', 'c']);
  });

  it('runs the steps in the order they are given', async () => {
    const { log } = recorder();
    const step = isolatedStep(log);
    const order: number[] = [];
    const slow = (n: number) => async () => {
      await new Promise((r) => setTimeout(r, n === 1 ? 20 : 0));
      order.push(n);
    };
    await step('one', slow(1));
    await step('two', slow(2));
    // Awaited in sequence: a later sweep must not read state an earlier one is
    // still writing.
    expect(order).toEqual([1, 2]);
  });
});
