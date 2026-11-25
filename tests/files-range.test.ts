/**
 * The local storage route answers byte ranges, as S3 does for a presigned URL.
 *
 * Without them Chrome cannot seek an <audio> element: every jump to a moment
 * in the song (the score bar, a lyric line, the timing workspace's loop)
 * snapped back to 0:00 in development while working in production, so the
 * one environment anyone could test seeking in was the one where it was broken.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, queryOne, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

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

async function audioPath(): Promise<string> {
  const user = await h.createUser({ credits: 3 });
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `range-${randomUUID()}` },
    payload: { mode: 'simple', prompt: '海边的傍晚', instrumental: false, durationSeconds: 30 } as never,
  });
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  let trackId: string | undefined;
  for (let i = 0; i < 6 && !trackId; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `r-${i}`, log: () => undefined }, jobId);
    trackId = (await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]))?.id;
  }
  const view = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}`, headers: user.authHeader });
  const url = new URL(view.json().previewUrl as string, 'http://x');
  return url.pathname + url.search;
}

it('answers a range with 206 and exactly those bytes, and says it accepts ranges', async () => {
  const path = await audioPath();
  const whole = await h.app.inject({ method: 'GET', url: path });
  expect(whole.statusCode).toBe(200);
  expect(whole.headers['accept-ranges']).toBe('bytes');
  const size = whole.rawPayload.length;

  const part = await h.app.inject({ method: 'GET', url: path, headers: { range: 'bytes=100-199' } });
  expect(part.statusCode).toBe(206);
  expect(part.headers['content-range']).toBe(`bytes 100-199/${size}`);
  expect(part.rawPayload.equals(whole.rawPayload.subarray(100, 200))).toBe(true);

  const tail = await h.app.inject({ method: 'GET', url: path, headers: { range: 'bytes=1000-' } });
  expect(tail.statusCode).toBe(206);
  expect(tail.rawPayload.equals(whole.rawPayload.subarray(1000))).toBe(true);

  const past = await h.app.inject({ method: 'GET', url: path, headers: { range: `bytes=${size + 10}-` } });
  expect(past.statusCode).toBe(416);
  expect(past.headers['content-range']).toBe(`bytes */${size}`);
}, 60_000);
