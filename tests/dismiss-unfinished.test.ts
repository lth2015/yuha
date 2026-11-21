/**
 * 「不要了」: a generation that ended without a song can be taken off the
 * person's lists (docs/TASK_RECOVERY_SPEC.md).
 *
 * Off the lists only. The job, its failure and what happened to its credit
 * stay on record: support asks for the job id, and the credit history is a
 * ledger, not a list a person curates.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getJob, query } from '@yuha/db';
import { failJob } from '../apps/api/src/services/delivery.js';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

async function start(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `dm-${randomUUID()}` },
    payload: { mode: 'simple', prompt: '晚霞', instrumental: true, durationSeconds: 30 } as never,
  });
  expect(res.statusCode).toBe(202);
  return res.json().jobId as string;
}

const unfinished = async (user: TestUser) =>
  ((await h.app.inject({ method: 'GET', url: '/v1/jobs/unfinished', headers: user.authHeader })).json().items as Array<{ jobId: string }>).map((j) => j.jobId);
const dismiss = (user: TestUser, jobId: string) =>
  h.app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/dismiss`, headers: user.authHeader });

describe('dismissing a generation that did not finish', () => {
  it('takes it off the list and keeps the record and the ledger', async () => {
    const u = await h.createUser({ credits: 3 });
    const failed = await start(u);
    await failJob(h.ctx, { job: (await getJob(failed))!, to: 'FAILED', errorCode: 'upstream_failed' });
    const cancelled = await start(u);
    await h.app.inject({ method: 'POST', url: `/v1/jobs/${cancelled}/cancel`, headers: u.authHeader });
    expect(new Set(await unfinished(u))).toEqual(new Set([failed, cancelled]));
    const ledgerBefore = await query(`SELECT entry_type, units FROM ledger_entries WHERE user_id = ? ORDER BY created_at, entry_type`, [u.id]);

    expect((await dismiss(u, failed)).statusCode).toBe(204);
    expect(await unfinished(u)).toEqual([cancelled]);
    // Twice is the same as once.
    expect((await dismiss(u, failed)).statusCode).toBe(204);

    // Still there for anyone who asks by id, and nothing moved in the ledger.
    const page = await h.app.inject({ method: 'GET', url: `/v1/jobs/${failed}`, headers: u.authHeader });
    expect(page.json()).toMatchObject({ phase: 'failed', credit: 'returned' });
    expect(await query(`SELECT entry_type, units FROM ledger_entries WHERE user_id = ? ORDER BY created_at, entry_type`, [u.id])).toEqual(ledgerBefore);
  });

  it('is only for the owner, and only for a generation that has ended without a song', async () => {
    const u = await h.createUser({ credits: 3 });
    const other = await h.createUser({ credits: 1 });
    const running = await start(u);
    expect((await dismiss(other, running)).statusCode).toBe(404);
    expect((await dismiss(u, running)).statusCode).toBe(409);
    expect((await dismiss(u, randomUUID())).statusCode).toBe(404);
  });
});
