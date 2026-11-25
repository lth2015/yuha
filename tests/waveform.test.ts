/**
 * The song's loudness over time, for the lyric timing workspace
 * (docs/MV_LYRIC_SYNC_UX_SPEC.md, phase 1): computed on the server from the
 * song's own audio, so the page needs neither a second copy of the file nor
 * permission to read the storage bucket from script. The owner's alone, like
 * the audio it is drawn from.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, queryOne, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';
import { peaksFromPcm } from '../apps/api/src/services/waveform.js';

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

async function song(user: TestUser, durationSeconds = 30): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `wave-${randomUUID()}` },
    payload: { mode: 'simple', prompt: '海边的傍晚', instrumental: false, durationSeconds } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `w-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}

describe('peaks from PCM', () => {
  it('is the loudest sample in each bucket, scaled to the loudest in the song', () => {
    const pcm = new Int16Array([0, 100, -200, 50, 0, 0, 1000, -4000]);
    expect(peaksFromPcm(pcm, 4)).toEqual([0.03, 0.05, 0, 1]);
  });
  it('is all zero for silence, and never more buckets than samples', () => {
    expect(peaksFromPcm(new Int16Array(6), 3)).toEqual([0, 0, 0]);
    expect(peaksFromPcm(new Int16Array([5, -10]), 8)).toHaveLength(2);
    expect(peaksFromPcm(new Int16Array(0), 8)).toEqual([]);
  });
});

describe('GET /v1/tracks/:id/waveform', () => {
  it('gives the owner the song’s peaks across its whole length', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await song(user);
    const res = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}/waveform`, headers: user.authHeader });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { peaks: number[]; seconds: number };
    expect(body.seconds).toBeGreaterThan(29);
    expect(body.seconds).toBeLessThan(31);
    expect(body.peaks.length).toBeGreaterThan(200);
    expect(body.peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
    expect(Math.max(...body.peaks)).toBe(1);
    expect(res.headers['cache-control']).toMatch(/^private/);
  }, 60_000);

  it('is nobody else’s', async () => {
    const user = await h.createUser({ credits: 3 });
    const other = await h.createUser();
    const trackId = await song(user);
    expect((await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}/waveform`, headers: other.authHeader })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}/waveform` })).statusCode).toBe(401);
  }, 60_000);
});
