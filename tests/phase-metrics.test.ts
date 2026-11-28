/**
 * The three numbers the product owner watches this phase (2026-11-28):
 * first-song completion, lyrics usable without adjustment, MV export success.
 * Each is counted on the console's date range, staff excluded, and each
 * keeps "not decided yet" apart from "failed".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, execute, jstToday, query, queryOne, statsReport, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ FEATURE_PHOTO_VIDEO_ENABLED: 'true' });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

/** Submit a song and, unless told not to, drive it to delivery. Returns the job id. */
async function job(user: TestUser, opts: { deliver?: boolean; instrumental?: boolean } = {}): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `phase-${randomUUID()}` },
    payload: { mode: 'simple', prompt: '下班后的末班车', instrumental: opts.instrumental ?? false, durationSeconds: 30 } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  if (opts.deliver === false) return jobId;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `ph-${i}`, log: () => undefined }, jobId);
    if (await queryOne(`SELECT 1 AS k FROM tracks WHERE job_id = ?`, [jobId])) return jobId;
  }
  throw new Error('not delivered');
}

const hoursAgo = (jobId: string, hours: number) =>
  execute(
    `UPDATE generation_jobs SET created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR),
            delivered_at = IF(delivered_at IS NULL, NULL, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR)) WHERE id = ?`,
    [hours, hours - 0.05, jobId],
  );
/** A first try that ended without a song, the way it really ends: cancelled, its hold released. */
async function fail(user: TestUser, jobId: string) {
  const res = await h.app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/cancel`, headers: user.authHeader });
  expect(res.statusCode).toBe(200);
  expect((await queryOne<{ state: string }>(`SELECT state FROM generation_jobs WHERE id = ?`, [jobId]))!.state).toBe('CANCELLED');
}
const twoDays = async () => {
  const today = jstToday();
  const yesterday = jstToday(Date.now() - 2 * 86_400_000);
  return statsReport({ granularity: 'day', from: yesterday, to: today });
};

describe('first-song completion', () => {
  it('counts a first song finished within a day, a retry that rescued it, and keeps the undecided apart', async () => {
    // Finished on the first try.
    const a = await h.createUser({ credits: 3 });
    await job(a);
    // First try failed; a second one, an hour later, was delivered.
    const b = await h.createUser({ credits: 3 });
    const bFirst = await job(b, { deliver: false });
    await fail(b, bFirst);
    await hoursAgo(bFirst, 2);
    await job(b);
    // Failed 30 hours ago and never came back: started, not completed.
    const c = await h.createUser({ credits: 3 });
    const cFirst = await job(c, { deliver: false });
    await fail(c, cFirst);
    await hoursAgo(cFirst, 30);
    // Just submitted: neither a success nor a failure yet.
    const d = await h.createUser({ credits: 3 });
    await job(d, { deliver: false });
    // Staff are not the audience.
    const staff = await h.createUser({ credits: 3, role: 'admin' });
    await job(staff);

    const { phase } = await twoDays();
    expect(phase.firstSong).toEqual({ started: 4, completed: 2, pending: 1 });
  }, 60_000);

  it('a song delivered more than a day after the first try does not rescue the first song', async () => {
    const u = await h.createUser({ credits: 3 });
    const first = await job(u, { deliver: false });
    await fail(u, first);
    await hoursAgo(first, 40);
    await job(u);
    const { phase } = await twoDays();
    expect(phase.firstSong).toEqual({ started: 1, completed: 0, pending: 0 });
  }, 60_000);
});

describe('lyrics usable without adjustment', () => {
  it('splits delivered sung songs into automatic, corrected by a person, and without a usable timeline', async () => {
    const u = await h.createUser({ credits: 9 });
    const ids = [] as string[];
    for (let i = 0; i < 4; i += 1) {
      const jobId = await job(u);
      ids.push((await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]))!.id);
    }
    const timeline = (source: string) => JSON.stringify({ source, lines: [] });
    await execute(`UPDATE tracks SET lyrics = 'la la', lyric_timings = ? WHERE id IN (?, ?)`, [timeline('aligned'), ids[0], ids[1]]);
    await execute(`UPDATE tracks SET lyrics = 'la la', lyric_timings = ? WHERE id = ?`, [timeline('corrected'), ids[2]]);
    await execute(`UPDATE tracks SET lyrics = 'la la', lyric_timings = ? WHERE id = ?`, [timeline('estimated'), ids[3]]);
    // An instrumental has nothing to sync and is not counted.
    const inst = await job(u, { instrumental: true });
    await execute(`UPDATE tracks SET lyrics = NULL, lyric_timings = NULL WHERE job_id = ?`, [inst]);

    const { phase } = await twoDays();
    expect(phase.lyrics).toEqual({ sung: 4, automatic: 2, corrected: 1, unsynced: 1 });
  }, 60_000);
});

describe('MV export success', () => {
  it('records a failed video with its reason, never what was in it, and keeps it apart from a made one', async () => {
    const u = await h.createUser({ credits: 3 });
    const jobId = await job(u);
    const trackId = (await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]))!.id;
    const bad = await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/photo-video`,
      headers: u.authHeader,
      payload: { rightsConfirmed: true, start: 0, duration: 4, frames: [{ at: 0, jpeg: Buffer.from('not a jpeg').toString('base64') }] } as never,
    });
    expect(bad.statusCode).toBe(400);
    // Somebody else's song is not an export attempt at all.
    const other = await h.createUser({ credits: 3 });
    const notMine = await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/share-video`,
      headers: other.authHeader,
      payload: { start: 0, duration: 4, frames: [{ at: 0, jpeg: Buffer.from('not a jpeg').toString('base64') }] } as never,
    });
    expect(notMine.statusCode).toBe(404);

    const { phase, videos } = await twoDays();
    expect(videos).toEqual({ cover: 0, photo: 0 });
    expect(phase.videos).toEqual({ made: { cover: 0, photo: 0 }, failed: { cover: 0, photo: 1 }, busy: 0 });
    const rows = await query<{ props: unknown }>(`SELECT props FROM analytics_events WHERE name = 'video_failed'`);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(rows[0]!.props))).toMatchObject({ kind: 'photo', reason: 'validation_failed' });
    expect(JSON.stringify(rows[0]!.props)).not.toMatch(/jpeg|frames|not a jpeg/);
  }, 60_000);
});
