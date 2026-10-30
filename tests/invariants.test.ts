/**
 * The logic rules catch what they say they catch (packages/db/src/invariants.ts).
 *
 * For every rule, one row that breaks it is written and the rule must find
 * exactly that row. A rule that has never caught anything may be checking
 * nothing, and a rule added without a case here fails the last test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  INVARIANTS,
  checkInvariants,
  claimOutboxBatch,
  compensateUnits,
  execute,
  getJob,
  grantUnits,
  insertJob,
  insertProject,
  queryOne,
  withTx,
  writeLedger,
} from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';
import { allowInvariantBreach } from './helpers/invariant-guard.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ ADMIN_MFA_REQUIRED: 'false' });
});
beforeEach(async () => {
  await resetData();
  // Each case breaks a rule on purpose, and some breaches imply others.
  allowInvariantBreach(...INVARIANTS.map((i) => i.name));
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

async function start(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `inv-${randomUUID()}` },
    payload: { mode: 'simple', prompt: '雨の日の駅', instrumental: true, durationSeconds: 30 } as never,
  });
  expect(res.statusCode).toBe(202);
  return res.json().jobId as string;
}

async function song(user: TestUser): Promise<{ jobId: string; trackId: string }> {
  const jobId = await start(user);
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `inv-${i}`, log: () => undefined }, jobId);
    const job = await getJob(jobId);
    if (job?.state === 'DELIVERED') return { jobId, trackId: job.track_id! };
  }
  throw new Error('not delivered');
}

async function bareJob(user: TestUser): Promise<string> {
  return withTx(async (tx) => {
    const project = await insertProject({ ownerId: user.id, title: 't', scene: 'night_walk' }, tx);
    const job = await insertJob(
      { userId: user.id, projectId: project.id, idempotencyKey: `b-${randomUUID()}`, requestHash: 'h', providerRequestKey: 'k', input: {} },
      tx,
    );
    return job.id;
  });
}

async function order(user: TestUser, priceKey: string, status: string, granted: boolean): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO orders (id, user_id, price_key, price_version, kind, amount_minor, currency, status, idempotency_key, metadata, payment_method, entitlement_granted_at)
     SELECT ?, ?, price_key, version, kind, amount_minor, currency, ?, ?, '{}', 'card', ? FROM product_catalog WHERE price_key = ? ORDER BY version DESC LIMIT 1`,
    [id, user.id, status, `o-${id}`, granted ? new Date() : null, priceKey],
  );
  return id;
}

const grantFor = (user: TestUser, orderId: string) =>
  withTx((tx) => grantUnits({ userId: user.id, source: 'one_time_order', sourceRef: orderId, units: 3, reason: 'test' }, tx));

/** Breaks one rule; returns the id the rule must report. */
const CASES: Record<string, (u: TestUser, other: TestUser) => Promise<string>> = {
  'delivered-job-has-a-song': async (u) => {
    const id = await bareJob(u);
    await execute(`UPDATE generation_jobs SET state = 'DELIVERED', finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [id]);
    return id;
  },
  'delivered-job-spent-its-credit': async (u) => {
    const id = await start(u);
    await execute(`UPDATE generation_jobs SET state = 'DELIVERED', finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [id]);
    return id;
  },
  'failed-job-never-charged': async (u) => {
    const { jobId } = await song(u);
    await execute(`UPDATE generation_jobs SET state = 'FAILED' WHERE id = ?`, [jobId]);
    return jobId;
  },
  'ended-job-holds-no-credit': async (u) => {
    const id = await start(u);
    await execute(`UPDATE generation_jobs SET state = 'FAILED', finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [id]);
    return id;
  },
  'credit-not-both-spent-and-returned': async (u) => {
    const { jobId } = await song(u);
    const batch = await queryOne<{ batch_id: string }>(`SELECT batch_id FROM ledger_entries WHERE job_id = ? AND entry_type = 'consume'`, [jobId]);
    await withTx((tx) => writeLedger({ userId: u.id, batchId: batch!.batch_id, jobId, entryType: 'release', units: 1, reason: 'planted' }, tx));
    return jobId;
  },
  'open-job-not-settled': async (u) => {
    const { jobId } = await song(u);
    await execute(`UPDATE generation_jobs SET state = 'PROCESSING', finished_at = NULL WHERE id = ?`, [jobId]);
    return jobId;
  },
  'finished-at-iff-ended': async (u) => {
    const id = await bareJob(u);
    await execute(`UPDATE generation_jobs SET finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [id]);
    return id;
  },
  'batch-counters-match-ledger': async (u) => {
    const b = await queryOne<{ id: string }>(`SELECT id FROM entitlement_batches WHERE user_id = ?`, [u.id]);
    await execute(`UPDATE entitlement_batches SET granted_units = granted_units + 1 WHERE id = ?`, [b!.id]);
    return b!.id;
  },
  'paid-order-granted': (u) => order(u, 'drop_5', 'paid', true),
  'paid-licence-order-has-its-licence': (u) => order(u, 'market_license', 'paid', true),
  'unpaid-order-grants-nothing': async (u) => {
    const id = await order(u, 'drop_5', 'pending', false);
    await grantFor(u, id);
    return id;
  },
  'refunded-order-left-nothing-spendable': async (u) => {
    const id = await order(u, 'drop_5', 'refunded', true);
    await grantFor(u, id);
    return id;
  },
  'song-belongs-to-its-maker': async (u, other) => {
    const { trackId } = await song(u);
    await execute(`UPDATE tracks SET owner_id = ? WHERE id = ?`, [other.id, trackId]);
    return trackId;
  },
  'report-status-matches-its-fields': async (u) => {
    const { trackId } = await song(u);
    await h.app.inject({ method: 'POST', url: `/v1/tracks/${trackId}/issues`, headers: u.authHeader, payload: { kind: 'other' } as never });
    const r = await queryOne<{ id: string }>(`SELECT id FROM issue_reports WHERE track_id = ?`, [trackId]);
    await execute(`UPDATE issue_reports SET status = 'resolved' WHERE id = ?`, [r!.id]);
    return r!.id;
  },
  'report-compensation-goes-to-its-owner': async (u, other) => {
    const { trackId } = await song(u);
    await h.app.inject({ method: 'POST', url: `/v1/tracks/${trackId}/issues`, headers: u.authHeader, payload: { kind: 'other' } as never });
    const r = await queryOne<{ id: string }>(`SELECT id FROM issue_reports WHERE track_id = ?`, [trackId]);
    const theirs = await queryOne<{ id: string }>(`SELECT id FROM entitlement_batches WHERE user_id = ?`, [other.id]);
    await execute(
      `UPDATE issue_reports SET status = 'resolved', resolution = 'x', resolved_at = UTC_TIMESTAMP(3), compensation_batch_id = ?, compensated_units = 1 WHERE id = ?`,
      [theirs!.id, r!.id],
    );
    return r!.id;
  },
  'job-compensation-points-at-its-job': async (u) => {
    const { jobId } = await song(u);
    const res = await withTx((tx) => compensateUnits({ userId: u.id, jobId, units: 1, reason: 'planted', validityDays: 30 }, tx));
    await execute(`UPDATE entitlement_batches SET source_ref = ? WHERE id = ?`, [`job:${randomUUID()}`, res.batch.id]);
    const entry = await queryOne<{ id: string }>(`SELECT id FROM ledger_entries WHERE job_id = ? AND entry_type = 'compensate'`, [jobId]);
    return entry!.id;
  },
};

describe('each logic rule', () => {
  for (const inv of INVARIANTS) {
    it(`${inv.name}: finds the row that breaks it, and nothing before`, async () => {
      const make = CASES[inv.name];
      expect(make, `no breaking case for ${inv.name}`).toBeDefined();
      const u = await h.createUser({ credits: 3 });
      const other = await h.createUser({ credits: 1 });
      expect((await checkInvariants([inv.name]))[0]!.count).toBe(0);
      const id = await make!(u, other);
      const [result] = await checkInvariants([inv.name]);
      expect(result).toMatchObject({ count: 1, sample: [id] });
    });
  }

  it('has a breaking case for every rule, and no case for a rule that is gone', () => {
    expect(Object.keys(CASES).sort()).toEqual(INVARIANTS.map((i) => i.name).sort());
  });

  it('refuses a rule name it does not know', async () => {
    await expect(checkInvariants(['no-such-rule'])).rejects.toThrow(/unknown invariant/);
  });
});

describe('a healthy history', () => {
  it('breaks no rule', async () => {
    const u = await h.createUser({ credits: 3 });
    await song(u);
    expect((await checkInvariants()).filter((r) => r.count > 0)).toEqual([]);
  });
});

describe('the console', () => {
  it('shows every rule, and names a broken one with the ids to look at', async () => {
    const admin = await h.createUser({ role: 'admin' });
    const u = await h.createUser({ credits: 1 });
    const id = await CASES['finished-at-iff-ended']!(u, u);
    const res = await h.app.inject({ method: 'GET', url: '/v1/admin/overview', headers: admin.authHeader });
    expect(res.statusCode).toBe(200);
    const rules = res.json().operations.invariants as Array<{ name: string; count: number; sample: string[] }>;
    expect(rules).toHaveLength(INVARIANTS.length);
    expect(rules.find((r) => r.name === 'finished-at-iff-ended')).toMatchObject({ count: 1, sample: [id] });
    expect(rules.filter((r) => r.count > 0).map((r) => r.name)).toEqual(['finished-at-iff-ended']);
  });
});
