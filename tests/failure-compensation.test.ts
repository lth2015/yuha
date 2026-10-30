/**
 * Failure compensation records (docs/FAILURE_COMPENSATION_SPEC.md).
 *
 * What is pinned: the owner's credit history says, one line per event, what
 * the ledger says — a failed song returned, an expired credit reissued, a
 * delivered song spent, an apology from support, a refund taken back — and
 * nothing twice; staff can compensate a delivered song from its problem
 * report, once per song, inside the daily allowance, in the same
 * transaction as the resolution; and support reads the same outcome per job.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, execute, getJob, query, queryOne, revokeUnusedUnits, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { failJob } from '../apps/api/src/services/delivery.js';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ ADMIN_MFA_REQUIRED: 'false', ADMIN_COMPENSATION_MAX_UNITS_PER_DAY: '2' });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

async function start(user: TestUser, prompt = '雨の日の駅'): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `fc-${randomUUID()}` },
    payload: { mode: 'simple', prompt, instrumental: true, durationSeconds: 30 } as never,
  });
  expect(res.statusCode).toBe(202);
  return res.json().jobId as string;
}

async function fail(jobId: string) {
  expect(await failJob(h.ctx, { job: (await getJob(jobId))!, to: 'FAILED', errorCode: 'upstream_failed' })).toBe(true);
}

async function song(user: TestUser, prompt?: string): Promise<{ jobId: string; trackId: string }> {
  const jobId = await start(user, prompt);
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `fc-${i}`, log: () => undefined }, jobId);
    const job = await getJob(jobId);
    if (job?.state === 'DELIVERED') return { jobId, trackId: job.track_id! };
  }
  throw new Error('not delivered');
}

const history = async (user: TestUser) => {
  const res = await h.app.inject({ method: 'GET', url: '/v1/credits/history', headers: user.authHeader });
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<Record<string, unknown>>;
};

const available = async (user: TestUser) =>
  (await h.app.inject({ method: 'GET', url: '/v1/entitlements', headers: user.authHeader })).json().availableUnits as number;

async function report(owner: TestUser, trackId: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/tracks/${trackId}/issues`,
    headers: { ...owner.authHeader, 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200) + 10}` },
    payload: { kind: 'missing_vocals', atSeconds: 12 } as never,
  });
  expect(res.statusCode).toBe(201);
  const row = await queryOne<{ id: string }>(`SELECT id FROM issue_reports WHERE report_number = ?`, [res.json().reportNumber]);
  return row!.id;
}

const resolve = (staff: TestUser, id: string, compensate: boolean) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/admin/issues/${id}/resolve`,
    headers: staff.authHeader,
    payload: { reason: '第二段漏唱，已补偿一首', compensate } as never,
  });

describe("the owner's credit history", () => {
  it('has one line per generation, with what the ledger says happened to its credit', async () => {
    const owner = await h.createUser({ credits: 4 });
    const failed = await start(owner, '失敗した曲');
    await fail(failed);
    const delivered = await song(owner, '届いた曲');

    const items = await history(owner);
    const generations = items.filter((i) => i['kind'] === 'generation');
    expect(generations).toEqual([
      expect.objectContaining({ jobId: delivered.jobId, trackId: delivered.trackId, credit: 'spent', units: -1 }),
      expect.objectContaining({ jobId: failed, trackId: null, credit: 'returned', units: 0, title: '失敗した曲' }),
    ]);
    // The credits it started with are a line of their own.
    expect(items.at(-1)).toMatchObject({ kind: 'grant', units: 4 });
  });

  it('shows a credit reissued for an expired batch once, on the generation, not again as a grant', async () => {
    const owner = await h.createUser({ credits: 1 });
    const jobId = await start(owner);
    await execute(`UPDATE entitlement_batches SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE user_id = ?`, [owner.id]);
    await fail(jobId);
    const items = await history(owner);
    expect(items.filter((i) => i['kind'] === 'generation')).toEqual([expect.objectContaining({ jobId, credit: 'compensated', units: 0 })]);
    expect(items.filter((i) => i['kind'] === 'compensation')).toEqual([]);
    expect(items.filter((i) => i['kind'] === 'grant')).toHaveLength(1);
  });

  it('shows credits taken back by a refund as a negative line', async () => {
    const owner = await h.createUser({ credits: 3 });
    const batch = await queryOne<{ id: string }>(`SELECT id FROM entitlement_batches WHERE user_id = ?`, [owner.id]);
    await withTx((tx) => revokeUnusedUnits({ userId: owner.id, batchId: batch!.id, reason: 'refund', maxUnits: 2 }, tx));
    expect((await history(owner))[0]).toMatchObject({ kind: 'revoke', units: -2 });
  });

  it('is nobody else’s', async () => {
    const owner = await h.createUser({ credits: 2 });
    const other = await h.createUser({ credits: 0 });
    await fail(await start(owner));
    expect(await history(other)).toEqual([]);
    expect((await h.app.inject({ method: 'GET', url: '/v1/credits/history' })).statusCode).toBe(401);
  });
});

describe('compensating a delivered song from its problem report', () => {
  it('gives one credit back, shows it on the report and in the history, and audits it', async () => {
    const owner = await h.createUser({ credits: 2 });
    const support = await h.createUser({ role: 'support' });
    const { jobId, trackId } = await song(owner);
    const before = await available(owner);
    const id = await report(owner, trackId);

    const res = await resolve(support, id, true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'resolved', compensatedUnits: 1 });
    expect(await available(owner)).toBe(before + 1);

    const entries = await query<{ entry_type: string; job_id: string | null }>(
      `SELECT entry_type, job_id FROM ledger_entries WHERE user_id = ? AND entry_type = 'compensate'`,
      [owner.id],
    );
    expect(entries).toEqual([{ entry_type: 'compensate', job_id: jobId }]);

    const mine = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}/issues`, headers: owner.authHeader });
    expect(mine.json().items[0]).toMatchObject({ status: 'resolved', compensatedUnits: 1 });

    const items = await history(owner);
    const reportNumber = mine.json().items[0].reportNumber;
    expect(items[0]).toMatchObject({ kind: 'compensation', units: 1, jobId, trackId, reportNumber });
    // The staff member's own words stay in the console.
    expect(JSON.stringify(items)).not.toContain('第二段漏唱');

    const audit = await query<{ action: string }>(`SELECT action FROM audit_logs WHERE subject_id = ? ORDER BY created_at`, [id]);
    expect(audit.map((a) => a.action)).toEqual(['issue_report.resolved']);
    const comp = await query<{ action: string }>(`SELECT action FROM audit_logs WHERE action = 'entitlement.compensated' AND subject_id = ?`, [owner.id]);
    expect(comp).toHaveLength(1);
  });

  it('refuses to compensate the same song twice, and changes nothing', async () => {
    const owner = await h.createUser({ credits: 2 });
    const support = await h.createUser({ role: 'support' });
    const { trackId } = await song(owner);
    const first = await report(owner, trackId);
    const second = await report(owner, trackId);
    expect((await resolve(support, first, true)).statusCode).toBe(200);
    const balance = await available(owner);

    const again = await resolve(support, second, true);
    expect(again.statusCode).toBe(409);
    expect(await available(owner)).toBe(balance);
    const row = await queryOne<{ status: string }>(`SELECT status FROM issue_reports WHERE id = ?`, [second]);
    expect(row!.status).toBe('open');
    // Resolving it without compensation still works.
    expect((await resolve(support, second, false)).json()).toMatchObject({ status: 'resolved', compensatedUnits: null });
  });

  it('leaves the report open when the daily allowance is spent', async () => {
    const owner = await h.createUser({ credits: 5 });
    const support = await h.createUser({ role: 'support' });
    const reports: string[] = [];
    for (const p of ['一曲目', '二曲目', '三曲目']) reports.push(await report(owner, (await song(owner, p)).trackId));
    expect((await resolve(support, reports[0]!, true)).statusCode).toBe(200);
    expect((await resolve(support, reports[1]!, true)).statusCode).toBe(200);
    const over = await resolve(support, reports[2]!, true);
    expect(over.statusCode).toBe(400);
    const row = await queryOne<{ status: string }>(`SELECT status FROM issue_reports WHERE id = ?`, [reports[2]]);
    expect(row!.status).toBe('open');
  });
});

describe('support reading an account', () => {
  it('sees each recent job’s credit outcome, the same one the owner sees', async () => {
    const owner = await h.createUser({ credits: 3 });
    const support = await h.createUser({ role: 'support' });
    const failed = await start(owner);
    await fail(failed);
    const { jobId } = await song(owner);
    const res = await h.app.inject({ method: 'GET', url: `/v1/admin/users/${owner.id}`, headers: support.authHeader });
    expect(res.statusCode).toBe(200);
    const jobs = res.json().recentJobs as Array<{ jobId: string; credit: string }>;
    expect(jobs.find((j) => j.jobId === failed)?.credit).toBe('returned');
    expect(jobs.find((j) => j.jobId === jobId)?.credit).toBe('spent');
  });
});
