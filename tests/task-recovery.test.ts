/**
 * Finding a generation again after it ended without a song
 * (docs/TASK_RECOVERY_SPEC.md).
 *
 * What is pinned: every job says what happened to its credit, read from the
 * ledger rather than assumed from the state; a job that failed while the page
 * was closed can be found again, with a reason a person can read; its
 * settings come back for another try; and none of it is visible to anybody
 * but the owner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, execute, getJob, insertJob, insertProject, queryOne, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { failJob } from '../apps/api/src/services/delivery.js';
import { createHarness, ledgerFor, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

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

const SETTINGS = {
  mode: 'custom',
  title: '駅のホーム',
  prompt: '雨の日の駅',
  lyrics: '[Verse]\n雨の音が\n線路に落ちる',
  styles: ['city pop', 'piano'],
  instrumental: false,
  energy: 0.3,
  durationSeconds: 60,
  voice: 'female',
  visibility: 'private',
  dedication: { to: 'ゆか', occasion: 'thanks', note: 'いつもありがとう', lang: 'ja' },
};

async function start(user: TestUser, body: Record<string, unknown> = SETTINGS): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `tr-${randomUUID()}` },
    payload: body as never,
  });
  expect(res.statusCode).toBe(202);
  return res.json().jobId as string;
}

async function fail(jobId: string, to: 'FAILED' | 'REJECTED', errorCode: string) {
  const job = await getJob(jobId);
  expect(await failJob(h.ctx, { job: job!, to, errorCode })).toBe(true);
}

async function deliver(jobId: string) {
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `tr-${i}`, log: () => undefined }, jobId);
    if ((await getJob(jobId))?.state === 'DELIVERED') return;
  }
  throw new Error('not delivered');
}

const view = (user: TestUser, jobId: string) =>
  h.app.inject({ method: 'GET', url: `/v1/jobs/${jobId}`, headers: user.authHeader });
const unfinished = (user: TestUser) =>
  h.app.inject({ method: 'GET', url: '/v1/jobs/unfinished', headers: user.authHeader });
const draft = (user: TestUser, jobId: string) =>
  h.app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/draft`, headers: user.authHeader });

describe('what happened to the credit, from the ledger', () => {
  it('is held while the job runs, and spent once it is a song', async () => {
    const user = await h.createUser({ credits: 2 });
    const jobId = await start(user);
    expect((await view(user, jobId)).json()).toMatchObject({ credit: 'held', failure: null });
    await deliver(jobId);
    expect((await view(user, jobId)).json()).toMatchObject({ credit: 'spent', failure: null });
  });

  it('is returned after a technical failure, and the ledger says so', async () => {
    const user = await h.createUser({ credits: 2 });
    const jobId = await start(user);
    await fail(jobId, 'FAILED', 'upstream_failed');
    expect((await view(user, jobId)).json()).toMatchObject({ credit: 'returned', failure: 'technical' });
    expect(await ledgerFor(jobId)).toEqual([
      { entry_type: 'reserve', units: 1 },
      { entry_type: 'release', units: 1 },
    ]);
  });

  it('is returned when the model refused, and the reason says refused', async () => {
    const user = await h.createUser({ credits: 2 });
    const jobId = await start(user);
    await fail(jobId, 'REJECTED', 'upstream_rejected');
    expect((await view(user, jobId)).json()).toMatchObject({ credit: 'returned', failure: 'refused' });
  });

  it('is returned when the person cancelled before it started', async () => {
    const user = await h.createUser({ credits: 2 });
    const jobId = await start(user);
    const res = await h.app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/cancel`, headers: user.authHeader });
    expect(res.json().cancelled).toBe(true);
    expect((await view(user, jobId)).json()).toMatchObject({ credit: 'returned', failure: 'cancelled' });
  });

  it('is compensated when its batch expired while the job ran', async () => {
    const user = await h.createUser({ credits: 1 });
    const jobId = await start(user);
    await execute(`UPDATE entitlement_batches SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE user_id = ?`, [user.id]);
    await fail(jobId, 'FAILED', 'queue_wait_timeout');
    expect((await view(user, jobId)).json()).toMatchObject({ credit: 'compensated', failure: 'timeout' });
    expect((await ledgerFor(jobId)).map((e) => e.entry_type)).toEqual(['reserve', 'release', 'compensate']);
  });

  it('is none for a job that never reserved one', async () => {
    const user = await h.createUser({ credits: 1 });
    const jobId = await withTx(async (tx) => {
      const project = await insertProject({ ownerId: user.id, title: 't', scene: 'night_walk' }, tx);
      const job = await insertJob(
        { userId: user.id, projectId: project.id, idempotencyKey: `n-${randomUUID()}`, requestHash: 'h', providerRequestKey: 'k', input: { prompt: 'x' } },
        tx,
      );
      return job.id;
    });
    await fail(jobId, 'FAILED', 'intent_schema_invalid');
    expect((await view(user, jobId)).json()).toMatchObject({ credit: 'none', failure: 'technical' });
  });
});

describe('finding it again', () => {
  it('lists the jobs that ended without a song, newest first, and not the others', async () => {
    const user = await h.createUser({ credits: 5 });
    const failed = await start(user);
    await fail(failed, 'FAILED', 'upstream_failed');
    const refused = await start(user, { ...SETTINGS, prompt: '別の曲' });
    await fail(refused, 'REJECTED', 'upstream_rejected');
    await execute(`UPDATE generation_jobs SET created_at = created_at + INTERVAL 1 SECOND WHERE id = ?`, [refused]);
    await start(user, { ...SETTINGS, prompt: 'まだ途中' }); // still open: listed by GET /v1/jobs instead
    const res = await unfinished(user);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((j: { jobId: string }) => j.jobId)).toEqual([refused, failed]);
    expect(res.json().items[1]).toMatchObject({ failure: 'technical', credit: 'returned', prompt: '雨の日の駅' });
  });

  it('stops listing a job after thirty days', async () => {
    const user = await h.createUser({ credits: 2 });
    const jobId = await start(user);
    await fail(jobId, 'FAILED', 'upstream_failed');
    await execute(`UPDATE generation_jobs SET created_at = UTC_TIMESTAMP(3) - INTERVAL 31 DAY WHERE id = ?`, [jobId]);
    expect((await unfinished(user)).json().items).toEqual([]);
  });
});

describe('trying again', () => {
  it('gives back the settings it was submitted with, voice and dedication included', async () => {
    const user = await h.createUser({ credits: 2 });
    const jobId = await start(user);
    await fail(jobId, 'FAILED', 'upstream_failed');
    const res = await draft(user, jobId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: 'custom',
      title: '駅のホーム',
      prompt: '雨の日の駅',
      lyrics: '[Verse]\n雨の音が\n線路に落ちる',
      styles: ['city pop', 'piano'],
      instrumental: false,
      energy: 0.3,
      durationSeconds: 60,
      voice: 'female',
      visibility: 'private',
      dedication: { to: 'ゆか', occasion: 'thanks', note: 'いつもありがとう', lang: 'ja' },
    });
  });

  it('submitting those settings again is a new job that reserves once', async () => {
    const user = await h.createUser({ credits: 2 });
    const first = await start(user);
    await fail(first, 'FAILED', 'upstream_failed');
    const again = await start(user, (await draft(user, first)).json());
    expect(again).not.toBe(first);
    expect(await ledgerFor(again)).toEqual([{ entry_type: 'reserve', units: 1 }]);
    const balance = await queryOne<{ n: number }>(
      `SELECT SUM(granted_units - consumed_units - reserved_units) AS n FROM entitlement_batches WHERE user_id = ?`,
      [user.id],
    );
    expect(Number(balance!.n)).toBe(1);
  });
});

describe('anybody else', () => {
  it('cannot see the job, its settings, or that it exists', async () => {
    const owner = await h.createUser({ credits: 2 });
    const stranger = await h.createUser({ credits: 0 });
    const jobId = await start(owner);
    await fail(jobId, 'FAILED', 'upstream_failed');
    expect((await draft(stranger, jobId)).statusCode).toBe(404);
    expect((await view(stranger, jobId)).statusCode).toBe(404);
    expect((await unfinished(stranger)).json().items).toEqual([]);
    expect((await draft(stranger, randomUUID())).statusCode).toBe(404);
  });
});
