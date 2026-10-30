/**
 * "Generation succeeded", four ways (docs/GENERATION_QUALITY_SPEC.md).
 *
 * Each case is a real generation with one thing about it changed: cut short,
 * its file emptied, its lyrics left on an estimated timeline, deleted by its
 * owner, reported, failed, cancelled. Every figure must move for exactly the
 * cases it is about, and a cancellation must move none.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, execute, getJob, qualityReport, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { failJob } from '../apps/api/src/services/delivery.js';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ ADMIN_MFA_REQUIRED: 'false' });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

async function start(user: TestUser, sung: boolean): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `q-${randomUUID()}` },
    payload: { mode: 'simple', prompt: '雨の日の駅', instrumental: !sung, durationSeconds: 30 } as never,
  });
  expect(res.statusCode).toBe(202);
  return res.json().jobId as string;
}

async function song(user: TestUser, sung = false): Promise<{ jobId: string; trackId: string }> {
  const jobId = await start(user, sung);
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 8; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `q-${i}`, log: () => undefined }, jobId);
    const job = await getJob(jobId);
    if (job?.state === 'DELIVERED') {
      // A sung song's timeline, said outright rather than left to the demo aligner.
      if (sung) await timing(job.track_id!, 'aligned');
      return { jobId, trackId: job.track_id! };
    }
  }
  throw new Error('not delivered');
}

const timing = (trackId: string, source: string) =>
  execute(`UPDATE tracks SET lyric_timings = JSON_SET(COALESCE(lyric_timings, JSON_OBJECT('lines', JSON_ARRAY(), 'aligner', 'x')), '$.source', ?) WHERE id = ?`, [source, trackId]);
const hoursAgo = (jobId: string, hours: number) =>
  execute(`UPDATE generation_jobs SET finished_at = UTC_TIMESTAMP(3) - INTERVAL ? HOUR WHERE id = ?`, [hours, jobId]);

describe('the four figures', () => {
  it('each counts only what it is about', async () => {
    const u = await h.createUser({ credits: 12 });
    const whole = await song(u);
    const sungAligned = await song(u, true);
    const sungEstimated = await song(u, true);
    await timing(sungEstimated.trackId, 'estimated');
    const short = await song(u);
    await execute(`UPDATE asset_versions SET duration_ms = 10000 WHERE track_id = ? AND kind = 'master'`, [short.trackId]);
    const empty = await song(u);
    // A zero-byte master cannot be stored (asset_versions_size_chk); a missing one can.
    await execute(`DELETE FROM asset_versions WHERE track_id = ? AND kind = 'master'`, [empty.trackId]);
    const failed = await start(u, false);
    await failJob(h.ctx, { job: (await getJob(failed))!, to: 'FAILED', errorCode: 'upstream_failed' });
    const cancelled = await start(u, false);
    await h.app.inject({ method: 'POST', url: `/v1/jobs/${cancelled}/cancel`, headers: u.authHeader });

    const r = await qualityReport({ hours: 24 });
    // 6 finished by the provider; the cancellation is not one of them.
    expect(r.completion).toMatchObject({ numerator: 5, denominator: 6, misses: [failed] });
    expect(r.playable).toMatchObject({ numerator: 4, denominator: 5, misses: [empty.jobId] });
    expect(r.length.denominator).toBe(5);
    expect(new Set(r.length.misses)).toEqual(new Set([short.jobId, empty.jobId]));
    expect(r.lyricsAligned).toMatchObject({ numerator: 1, denominator: 2, misses: [sungEstimated.jobId] });
    expect(r.complete.numerator).toBe(2); // whole, sungAligned
    expect(new Set(r.complete.misses)).toEqual(new Set([sungEstimated.jobId, short.jobId, empty.jobId]));
    void whole;
    void sungAligned;
  });

  it('judges approval on songs that have had a day, and counts deleting and reporting against it', async () => {
    const u = await h.createUser({ credits: 6 });
    const kept = await song(u);
    const deleted = await song(u);
    const reported = await song(u);
    const fresh = await song(u);
    for (const s of [kept, deleted, reported]) await hoursAgo(s.jobId, 30);
    await h.app.inject({ method: 'DELETE', url: `/v1/tracks/${deleted.trackId}`, headers: u.authHeader });
    await h.app.inject({ method: 'POST', url: `/v1/tracks/${reported.trackId}/issues`, headers: u.authHeader, payload: { kind: 'missing_vocals' } as never });

    const r = await qualityReport({ hours: 24 });
    expect(r.approval.denominator).toBe(3); // not the fresh one
    expect(r.approval.numerator).toBe(1);
    expect(new Set(r.approval.misses)).toEqual(new Set([deleted.jobId, reported.jobId]));
    void fresh;
  });
});

describe('by build', () => {
  it('counts the current build apart from all, and a job with no build only in all', async () => {
    const u = await h.createUser({ credits: 6 });
    const current = await song(u);
    const before = await song(u);
    const old = await song(u);
    await execute(`UPDATE generation_jobs SET build_sha = 'current' WHERE id = ?`, [current.jobId]);
    await execute(`UPDATE generation_jobs SET build_sha = 'before' WHERE id = ?`, [before.jobId]);
    await execute(`UPDATE generation_jobs SET build_sha = NULL WHERE id = ?`, [old.jobId]);
    expect((await qualityReport({ hours: 24, buildSha: 'current' })).completion.denominator).toBe(1);
    expect((await qualityReport({ hours: 24 })).completion.denominator).toBe(3);
  });

  it('records the build that created a job', async () => {
    const u = await h.createUser({ credits: 2 });
    const previous = process.env['BUILD_SHA'];
    process.env['BUILD_SHA'] = 'abc1234';
    try {
      const jobId = await start(u, false);
      const [row] = await import('@yuha/db').then((db) => db.query<{ build_sha: string | null }>(`SELECT build_sha FROM generation_jobs WHERE id = ?`, [jobId]));
      expect(row!.build_sha).toBe('abc1234');
    } finally {
      if (previous === undefined) delete process.env['BUILD_SHA'];
      else process.env['BUILD_SHA'] = previous;
    }
  });

  it('shows the console both, labelled with the build', async () => {
    const admin = await h.createUser({ role: 'admin' });
    const u = await h.createUser({ credits: 2 });
    await song(u);
    const res = await h.app.inject({ method: 'GET', url: '/v1/admin/overview', headers: admin.authHeader });
    expect(res.statusCode).toBe(200);
    const q = res.json().quality;
    expect(q).toMatchObject({ build: process.env['BUILD_SHA'] ?? null });
    expect(q.all.day.completion).toMatchObject({ numerator: 1, denominator: 1 });
    expect(q.all.week.completion).toMatchObject({ numerator: 1, denominator: 1 });
    expect(q.current).toBeDefined();
  });
});
