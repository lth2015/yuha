/**
 * Credit ledger: GEN-01, GEN-02, GEN-03, GEN-08, GEN-11 and the refund rules.
 *
 * Every assertion here runs against a real MySQL instance. The point is
 * to prove the database constraints hold under concurrency, which an in-memory
 * fake could not demonstrate (§12.1).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  compensateUnits,
  consumeReservation,
  execute,
  getBalance,
  grantUnits,
  insertJob,
  insertProject,
  query,
  releaseReservation,
  reserveUnit,
  revokeUnusedUnits,
  reconcileBalances,
  withTx,
} from '@yuha/db';
import { createHarness, ledgerFor, resetData, teardown, type Harness } from './helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h.close();
  await teardown();
});

/** Creates a job row directly, so ledger behaviour can be tested in isolation. */
async function makeJob(userId: string): Promise<string> {
  return withTx(async (tx) => {
    const project = await insertProject(
      { ownerId: userId, title: 'test', scene: 'night_walk' },
      tx,
    );
    const job = await insertJob(
      {
        userId,
        projectId: project.id,
        idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
        requestHash: 'hash',
        providerRequestKey: 'key',
        input: {},
      },
      tx,
    );
    return job.id;
  });
}

describe('reservation and consumption', () => {
  it('reserves one unit and turns it into exactly one consumption', async () => {
    const user = await h.createUser({ credits: 3 });
    const jobId = await makeJob(user.id);

    await withTx(async (tx) => {
      const r = await reserveUnit({ userId: user.id, jobId }, tx);
      expect(r.ok).toBe(true);
    });

    let balance = await getBalance(user.id);
    expect(balance).toMatchObject({ available: 2, reserved: 1, consumed: 0 });

    await withTx(async (tx) => consumeReservation({ userId: user.id, jobId }, tx));

    balance = await getBalance(user.id);
    expect(balance).toMatchObject({ available: 2, reserved: 0, consumed: 1 });
    expect(await ledgerFor(jobId)).toEqual([
      { entry_type: 'reserve', units: 1 },
      { entry_type: 'consume', units: 1 },
    ]);
  });

  it('GEN-08: a repeated success callback does not consume a second unit', async () => {
    const user = await h.createUser({ credits: 3 });
    const jobId = await makeJob(user.id);
    await withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx));

    const first = await withTx(async (tx) => consumeReservation({ userId: user.id, jobId }, tx));
    const second = await withTx(async (tx) => consumeReservation({ userId: user.id, jobId }, tx));
    const third = await withTx(async (tx) => consumeReservation({ userId: user.id, jobId }, tx));

    expect(first.consumed).toBe(true);
    expect(second.consumed).toBe(false);
    expect(third.consumed).toBe(false);
    expect(await getBalance(user.id)).toMatchObject({ available: 2, consumed: 1 });
    expect((await ledgerFor(jobId)).filter((e) => e.entry_type === 'consume')).toHaveLength(1);
  });

  it('GEN-01: reserving twice for the same job reuses the original reservation', async () => {
    const user = await h.createUser({ credits: 3 });
    const jobId = await makeJob(user.id);

    const a = await withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx));
    const b = await withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx));

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.alreadyReserved).toBe(true);
      expect(b.batchId).toBe(a.batchId);
    }
    expect(await getBalance(user.id)).toMatchObject({ reserved: 1, available: 2 });
  });

  it('failure releases the reservation and never charges the user', async () => {
    const user = await h.createUser({ credits: 1 });
    const jobId = await makeJob(user.id);
    await withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx));

    const released = await withTx(async (tx) =>
      releaseReservation({ userId: user.id, jobId, reason: 'upstream_failed' }, tx),
    );

    expect(released.released).toBe(true);
    expect(await getBalance(user.id)).toMatchObject({ available: 1, reserved: 0, consumed: 0 });
  });

  it('GEN-09: a late success after a release does not re-charge the user', async () => {
    const user = await h.createUser({ credits: 2 });
    const jobId = await makeJob(user.id);
    await withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx));
    await withTx(async (tx) => releaseReservation({ userId: user.id, jobId, reason: 'timeout' }, tx));

    const late = await withTx(async (tx) => consumeReservation({ userId: user.id, jobId }, tx));

    expect(late.consumed).toBe(false);
    expect(await getBalance(user.id)).toMatchObject({ available: 2, consumed: 0 });
  });

  it('a release after a consumption is refused, so the ledger stays truthful', async () => {
    const user = await h.createUser({ credits: 2 });
    const jobId = await makeJob(user.id);
    await withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx));
    await withTx(async (tx) => consumeReservation({ userId: user.id, jobId }, tx));

    const released = await withTx(async (tx) =>
      releaseReservation({ userId: user.id, jobId, reason: 'late_failure' }, tx),
    );

    // Correction must go through the compensation flow rather than rewriting
    // the original consumption (§6.2).
    expect(released.released).toBe(false);
    expect(await getBalance(user.id)).toMatchObject({ consumed: 1, available: 1 });
  });
});

describe('GEN-03: concurrent contention for the last credit', () => {
  it('grants the last unit to exactly one of two concurrent jobs', async () => {
    const user = await h.createUser({ credits: 1 });
    const jobA = await makeJob(user.id);
    const jobB = await makeJob(user.id);

    const [a, b] = await Promise.all([
      withTx(async (tx) => reserveUnit({ userId: user.id, jobId: jobA }, tx)),
      withTx(async (tx) => reserveUnit({ userId: user.id, jobId: jobB }, tx)),
    ]);

    const successes = [a, b].filter((r) => r.ok);
    const failures = [a, b].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ ok: false, code: 'INSUFFICIENT_CREDITS' });

    const balance = await getBalance(user.id);
    expect(balance.reserved).toBe(1);
    expect(balance.available).toBe(0);
    // The balance must never go negative.
    expect(balance.available).toBeGreaterThanOrEqual(0);
  });

  it('ten concurrent jobs against three credits reserve exactly three', async () => {
    const user = await h.createUser({ credits: 3 });
    const jobs = await Promise.all(Array.from({ length: 10 }, () => makeJob(user.id)));

    const results = await Promise.all(
      jobs.map((jobId) => withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx))),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toHaveLength(7);

    const balance = await getBalance(user.id);
    expect(balance).toMatchObject({ available: 0, reserved: 3, consumed: 0 });
  });

  it('the database constraint refuses an oversell even if application logic is bypassed', async () => {
    const user = await h.createUser({ credits: 1 });
    await expect(
      withTx(async (tx) => {
        await execute(
          `UPDATE entitlement_batches SET reserved_units = reserved_units + 5 WHERE user_id = ?`,
          [user.id],
          tx,
        );
      }),
    ).rejects.toThrow(/entitlement_batches_not_oversold/);
  });
});

describe('batch selection order', () => {
  it('consumes the soonest-expiring batch first', async () => {
    const user = await h.createUser();
    const soon = new Date(Date.now() + 2 * 86400_000);
    const later = new Date(Date.now() + 60 * 86400_000);

    const a = await withTx(async (tx) =>
      grantUnits(
        { userId: user.id, source: 'one_time_order', sourceRef: 'later', units: 2, expiresAt: later, reason: 't' },
        tx,
      ),
    );
    const b = await withTx(async (tx) =>
      grantUnits(
        { userId: user.id, source: 'one_time_order', sourceRef: 'soon', units: 2, expiresAt: soon, reason: 't' },
        tx,
      ),
    );

    const jobId = await makeJob(user.id);
    const res = await withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx));

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.batchId).toBe(b.batch.id);
    expect(a.batch.id).not.toBe(b.batch.id);
  });

  it('never borrows from a batch that is not yet effective', async () => {
    const user = await h.createUser();
    // A future billing period must not be drawn on early (§6.2).
    await withTx(async (tx) =>
      grantUnits(
        {
          userId: user.id,
          source: 'subscription_period',
          sourceRef: 'next-period',
          units: 20,
          effectiveFrom: new Date(Date.now() + 7 * 86400_000),
          expiresAt: new Date(Date.now() + 37 * 86400_000),
          reason: 'next period',
        },
        tx,
      ),
    );

    const jobId = await makeJob(user.id);
    const res = await withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx));

    expect(res).toMatchObject({ ok: false, code: 'INSUFFICIENT_CREDITS' });
    expect((await getBalance(user.id)).available).toBe(0);
  });

  it('an expired batch stops counting toward the balance', async () => {
    const user = await h.createUser();
    await withTx(async (tx) =>
      grantUnits(
        {
          userId: user.id,
          source: 'one_time_order',
          sourceRef: 'expired',
          units: 5,
          effectiveFrom: new Date(Date.now() - 100 * 86400_000),
          expiresAt: new Date(Date.now() - 86400_000),
          reason: 'old pack',
        },
        tx,
      ),
    );

    expect((await getBalance(user.id)).available).toBe(0);
    const jobId = await makeJob(user.id);
    const res = await withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx));
    expect(res).toMatchObject({ ok: false });
  });
});

describe('grants, compensation and refunds', () => {
  it('PAY-05: granting twice with the same business reference grants once', async () => {
    const user = await h.createUser();
    const a = await withTx(async (tx) =>
      grantUnits(
        { userId: user.id, source: 'one_time_order', sourceRef: 'order-1', units: 5, reason: 'paid' },
        tx,
      ),
    );
    const b = await withTx(async (tx) =>
      grantUnits(
        { userId: user.id, source: 'one_time_order', sourceRef: 'order-1', units: 5, reason: 'paid replay' },
        tx,
      ),
    );

    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.batch.id).toBe(a.batch.id);
    expect((await getBalance(user.id)).available).toBe(5);
  });

  it('GEN-11: compensation creates a new batch rather than editing history', async () => {
    const user = await h.createUser({ credits: 1 });
    const jobId = await makeJob(user.id);
    await withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx));
    await withTx(async (tx) => releaseReservation({ userId: user.id, jobId, reason: 'expired' }, tx));

    await withTx(async (tx) =>
      compensateUnits({ userId: user.id, jobId, units: 1, reason: 'batch expired mid-flight', validityDays: 30 }, tx),
    );

    const batches = await query<{ source: string; granted_units: number }>(
      `SELECT source, granted_units FROM entitlement_batches WHERE user_id = ? ORDER BY created_at, source`,
      [user.id],
    );
    expect(batches).toHaveLength(2);
    expect(batches[1]!.source).toBe('compensation');
    // The original reservation and release remain visible in the ledger.
    const entries = await ledgerFor(jobId);
    expect(entries.map((e) => e.entry_type)).toEqual(['reserve', 'release', 'compensate']);
  });

  it('PAY-09: a refund revokes only unused units, never reserved or consumed ones', async () => {
    const user = await h.createUser();
    const grant = await withTx(async (tx) =>
      grantUnits(
        { userId: user.id, source: 'one_time_order', sourceRef: 'order-2', units: 5, reason: 'paid' },
        tx,
      ),
    );

    const consumedJob = await makeJob(user.id);
    await withTx(async (tx) => reserveUnit({ userId: user.id, jobId: consumedJob }, tx));
    await withTx(async (tx) => consumeReservation({ userId: user.id, jobId: consumedJob }, tx));

    const inFlightJob = await makeJob(user.id);
    await withTx(async (tx) => reserveUnit({ userId: user.id, jobId: inFlightJob }, tx));

    const result = await withTx(async (tx) =>
      revokeUnusedUnits({ userId: user.id, batchId: grant.batch.id, reason: 'refund' }, tx),
    );

    expect(result.revoked).toBe(3);
    expect(result.remainingConsumed).toBe(1);
    expect(result.remainingReserved).toBe(1);

    const balance = await getBalance(user.id);
    expect(balance.available).toBe(0);
    // The in-flight job can still finish; the delivered one is not clawed back.
    expect(balance.reserved).toBe(1);
    expect(balance.consumed).toBe(1);
  });
});

describe('reconciliation', () => {
  it('the derived counters always agree with the append-only ledger', async () => {
    const user = await h.createUser({ credits: 5 });
    const jobs = await Promise.all(Array.from({ length: 4 }, () => makeJob(user.id)));

    await withTx(async (tx) => reserveUnit({ userId: user.id, jobId: jobs[0]! }, tx));
    await withTx(async (tx) => consumeReservation({ userId: user.id, jobId: jobs[0]! }, tx));
    await withTx(async (tx) => reserveUnit({ userId: user.id, jobId: jobs[1]! }, tx));
    await withTx(async (tx) => releaseReservation({ userId: user.id, jobId: jobs[1]!, reason: 'failed' }, tx));
    await withTx(async (tx) => reserveUnit({ userId: user.id, jobId: jobs[2]! }, tx));

    expect(await reconcileBalances()).toEqual([]);
  });

  it('reports a discrepancy when a counter is tampered with directly', async () => {
    const user = await h.createUser({ credits: 5 });
    const jobId = await makeJob(user.id);
    await withTx(async (tx) => reserveUnit({ userId: user.id, jobId }, tx));

    // Simulates a bug or an operator editing the number instead of using the
    // compensation flow — §6.2 requires this to be detectable.
    await execute(`UPDATE entitlement_batches SET consumed_units = consumed_units + 1 WHERE user_id = ?`, [
      user.id,
    ]);

    const drift = await reconcileBalances();
    expect(drift).toHaveLength(1);
    expect(drift[0]!.counter_consumed).not.toBe(drift[0]!.ledger_consumed);
  });
});
