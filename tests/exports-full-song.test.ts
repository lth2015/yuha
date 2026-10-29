/**
 * Downloading the whole song as MP3, the song page's 「下载 MP3」.
 *
 * In production a full-length MP3 export of a new song failed three times
 * with a generic error. That path decoded the delivered MP3, ran loudnorm
 * (which resamples to 192 kHz internally) and encoded it again: about ten
 * seconds of one core for a three-minute song here, on a pod that requests a
 * quarter of one, behind a proxy with its own response deadline. And all it
 * produced was a second-generation copy of a file already mastered to the
 * same loudness. The owner downloading the whole song now gets the delivered
 * master itself; a clip, a fade or a licensee still goes through ffmpeg.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, queryOne, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

async function song(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `exp-${randomUUID()}` },
    payload: { mode: 'simple', prompt: '秋天的傍晚', instrumental: true, durationSeconds: 30 } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `e-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}

const exportReq = (user: TestUser, trackId: string, body: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url: `/v1/tracks/${trackId}/exports`, headers: user.authHeader, payload: body as never });

describe('the whole song as MP3', () => {
  it('is the delivered master itself, with no re-encode', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await song(user);
    const master = await queryOne<{ id: string; sha256: string; duration_ms: number; byte_size: number }>(
      `SELECT id, sha256, duration_ms, byte_size FROM asset_versions WHERE track_id = ? AND kind = 'master'`,
      [trackId],
    );
    const render = vi.spyOn(h.ctx.audio, 'renderExport');
    const res = await exportReq(user, trackId, {
      clipStartSeconds: 0,
      clipDurationSeconds: Math.round(master!.duration_ms / 1000),
      fadeOut: false,
    });
    expect(res.statusCode).toBe(200);
    expect(render).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ format: 'mp3', sha256: master!.sha256, byteSize: master!.byte_size });
    expect(res.json().downloadUrl).toBeTruthy();
    // The link can be issued again later, as for any export.
    const again = await h.app.inject({
      method: 'POST',
      url: `/v1/exports/${res.json().exportId}/download-url`,
      headers: user.authHeader,
    });
    expect(again.statusCode).toBe(200);
  });

  it('still renders a clip, and a fade', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await song(user);
    const render = vi.spyOn(h.ctx.audio, 'renderExport');
    expect((await exportReq(user, trackId, { clipStartSeconds: 0, clipDurationSeconds: 15 })).statusCode).toBe(200);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
