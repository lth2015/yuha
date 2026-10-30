/**
 * How long a song will take, from songs that actually finished
 * (docs/GENERATION_QUEUE_SPEC.md).
 *
 * What is pinned: the range comes from the provider's recent deliveries, not a
 * constant; a job further back waits longer; a running job's estimate shrinks
 * as it runs and is "taking longer" only well past its own upper bound; too
 * few samples says so instead of pretending; a waiting job says when it will
 * be given up on; and the console reads the same queue the database holds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execute, insertJob, insertProject, withTx } from '@yuha/db';
import { estimateFromTimings, resetTimingCache, type Timing } from '@yuha/api';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

const s = (genSeconds: number, durationSeconds = 120, waitSeconds = 10): Timing => ({ genSeconds, durationSeconds, waitSeconds });

describe('the range, from timings', () => {
  const twoMinute = [s(100), s(110), s(120), s(130), s(140), s(150), s(160), s(170)];

  it('uses the middle half of songs of the same length', () => {
    const e = estimateFromTimings({ timings: twoMinute, durationSeconds: 120, ahead: 0, concurrency: 1, runningSeconds: null });
    expect(e).toMatchObject({ basis: 'measured', samples: 8 });
    expect(e.minSeconds).toBeGreaterThanOrEqual(110);
    expect(e.maxSeconds).toBeLessThanOrEqual(160);
    expect(e.minSeconds).toBeLessThan(e.maxSeconds);
  });

  it('scales by length when there are too few songs of this length', () => {
    const e = estimateFromTimings({ timings: twoMinute, durationSeconds: 240, ahead: 0, concurrency: 1, runningSeconds: null });
    expect(e.basis).toBe('measured');
    // Roughly twice a two-minute song.
    expect(e.minSeconds).toBeGreaterThanOrEqual(200);
    expect(e.maxSeconds).toBeLessThanOrEqual(330);
  });

  it('waits for the songs ahead, a wave per concurrency slot', () => {
    const first = estimateFromTimings({ timings: twoMinute, durationSeconds: 120, ahead: 0, concurrency: 1, runningSeconds: null });
    const third = estimateFromTimings({ timings: twoMinute, durationSeconds: 120, ahead: 2, concurrency: 1, runningSeconds: null });
    expect(third.minSeconds).toBeGreaterThanOrEqual(first.minSeconds * 3 - 1);
    expect(third.maxSeconds).toBeGreaterThanOrEqual(first.maxSeconds * 3 - 1);
    // Two ahead with two slots is one wave, not two.
    const parallel = estimateFromTimings({ timings: twoMinute, durationSeconds: 120, ahead: 2, concurrency: 2, runningSeconds: null });
    expect(parallel.maxSeconds).toBeLessThan(third.maxSeconds);
  });

  it('shrinks as the song runs, and is late only well past its upper bound', () => {
    const fresh = estimateFromTimings({ timings: twoMinute, durationSeconds: 120, ahead: 0, concurrency: 1, runningSeconds: 0 });
    const later = estimateFromTimings({ timings: twoMinute, durationSeconds: 120, ahead: 0, concurrency: 1, runningSeconds: 100 });
    expect(later.maxSeconds).toBe(fresh.maxSeconds - 100);
    expect(later.delayed).toBe(false);
    const past = estimateFromTimings({ timings: twoMinute, durationSeconds: 120, ahead: 0, concurrency: 1, runningSeconds: fresh.maxSeconds + 10 });
    expect(past.delayed).toBe(false);
    const late = estimateFromTimings({ timings: twoMinute, durationSeconds: 120, ahead: 0, concurrency: 1, runningSeconds: Math.ceil(fresh.maxSeconds * 1.5) + 1 });
    expect(late.delayed).toBe(true);
    expect(late.minSeconds).toBeGreaterThanOrEqual(0);
  });

  it('says it is a default when there is too little to measure', () => {
    const e = estimateFromTimings({ timings: [s(100), s(120)], durationSeconds: 120, ahead: 0, concurrency: 1, runningSeconds: null });
    expect(e).toMatchObject({ basis: 'default', samples: 2 });
  });
});

describe('a job’s estimate in the API', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ ADMIN_MFA_REQUIRED: 'false' });
  });
  beforeEach(async () => {
    await resetData();
    resetTimingCache();
  });
  afterAll(async () => {
    await h?.close();
    await teardown();
  });

  const providerId = () => h.ctx.music.capabilities().providerId;

  /** A song that finished `gen` seconds after it was sent, `hoursAgo` hours ago. */
  async function finished(user: TestUser, gen: number, durationSeconds = 30, hoursAgo = 2) {
    await withTx(async (tx) => {
      const project = await insertProject({ ownerId: user.id, title: 't', scene: 'night_walk' }, tx);
      const job = await insertJob(
        { userId: user.id, projectId: project.id, idempotencyKey: `t-${randomUUID()}`, requestHash: 'h', providerRequestKey: 'k', input: { durationSeconds } },
        tx,
      );
      await execute(
        `UPDATE generation_jobs
            SET state = 'DELIVERED', provider_id = ?,
                created_at = UTC_TIMESTAMP(3) - INTERVAL ? SECOND,
                submitted_at = UTC_TIMESTAMP(3) - INTERVAL ? SECOND,
                dispatch_started_at = UTC_TIMESTAMP(3) - INTERVAL ? SECOND,
                delivered_at = UTC_TIMESTAMP(3) - INTERVAL ? SECOND,
                finished_at = UTC_TIMESTAMP(3) - INTERVAL ? SECOND
          WHERE id = ?`,
        [providerId(), hoursAgo * 3600 + gen + 20, hoursAgo * 3600 + gen, hoursAgo * 3600 + gen, hoursAgo * 3600, hoursAgo * 3600, job.id],
        tx,
      );
    });
  }

  async function submit(user: TestUser) {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: { ...user.authHeader, 'idempotency-key': `e-${randomUUID()}` },
      payload: { mode: 'simple', prompt: '雨の日の駅', instrumental: true, durationSeconds: 30 } as never,
    });
    expect(res.statusCode).toBe(202);
    return res.json() as { jobId: string; estimate: Record<string, unknown>; queueDeadlineAt?: string | null; createdAt: string };
  }

  it('comes from the provider’s recent deliveries, and says when a waiting job will be given up on', async () => {
    const user = await h.createUser({ credits: 3 });
    for (const gen of [40, 45, 50, 55, 60, 65]) await finished(user, gen);
    // Older than the window: not counted.
    await finished(user, 900, 30, 24 * 8);
    const job = await submit(user);
    expect(job.estimate).toMatchObject({ basis: 'measured', samples: 6 });
    expect(job.estimate['maxSeconds']).toBeLessThan(120);
    expect(job.queueDeadlineAt).toBeTruthy();
    const deadline = new Date(job.queueDeadlineAt!).getTime() - new Date(job.createdAt).getTime();
    expect(Math.round(deadline / 1000)).toBe(h.ctx.config.JOB_QUEUE_DEADLINE_SECONDS);
  });

  it('is a default, said so, when nothing has finished yet', async () => {
    const user = await h.createUser({ credits: 3 });
    const job = await submit(user);
    expect(job.estimate).toMatchObject({ basis: 'default', samples: 0 });
  });

  it('shows the console the queue as the database holds it', async () => {
    const user = await h.createUser({ credits: 3 });
    const admin = await h.createUser({ role: 'admin' });
    for (const gen of [40, 45, 50, 55, 60, 65]) await finished(user, gen);
    await submit(user);
    await submit(user);
    const res = await h.app.inject({ method: 'GET', url: '/v1/admin/overview', headers: admin.authHeader });
    expect(res.statusCode).toBe(200);
    const queue = res.json().operations.queue;
    expect(queue).toMatchObject({ concurrency: h.ctx.music.capabilities().maxConcurrency, waiting: 2, running: 0 });
    expect(queue.oldestWaitSeconds).toBeGreaterThanOrEqual(0);
    expect(queue.generation.samples).toBe(6);
    expect(queue.generation.p50Seconds).toBeGreaterThanOrEqual(50);
    expect(queue.generation.p50Seconds).toBeLessThanOrEqual(55);
    expect(queue.timeouts7d).toBe(0);
  });
});
