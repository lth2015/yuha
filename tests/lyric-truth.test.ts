/**
 * Ground truth for the lyric sync benchmark (docs/quality/LYRIC_BENCH.md):
 * the line starts a person set by hand, exported from the database.
 *
 * Staff songs only. A customer's song is their own work and private; taking
 * its audio and words to the DGX for testing is not what they made it for, so
 * the export never sees one, whatever its timing says. And only a timeline a
 * person corrected: an aligned or estimated one is a route to score, not an
 * answer to score it against.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, lyricTruth, query, queryOne, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
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

const LYRICS = '[Verse]\n晚风吹过街角\n[Chorus]\n我等你回来';
const lines = [
  { text: '晚风吹过街角', section: 'Verse', start: 2.4, end: 5 },
  { text: '我等你回来', section: 'Chorus', start: 6.1, end: 9 },
];

async function song(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `lt-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: LYRICS } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `lt-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}
const timings = (id: string, source: string) =>
  query(`UPDATE tracks SET lyric_timings = ? WHERE id = ?`, [JSON.stringify({ source, aligner: source === 'corrected' ? 'human' : 'mms-fa', lines }), id]);

describe('the lyric ground-truth export', () => {
  it('takes a staff song a person corrected, with the DGX job its audio is kept under', async () => {
    const staff = await h.createUser({ credits: 5, role: 'support' });
    const id = await song(staff);
    await timings(id, 'corrected');
    const out = await lyricTruth();
    expect(out).toHaveLength(1);
    const pr = await queryOne<{ p: string }>(
      `SELECT a.provider_request_id AS p FROM generation_attempts a JOIN tracks t ON t.job_id = a.job_id
        WHERE t.id = ? AND a.provider_request_id IS NOT NULL LIMIT 1`,
      [id],
    );
    expect(out[0]).toEqual({
      songId: id,
      providerRequestId: pr!.p,
      language: 'zh',
      lyrics: LYRICS,
      annotation: { songId: id, language: 'zh', lines: [{ idx: 0, sung: true, start: 2.4 }, { idx: 1, sung: true, start: 6.1 }] },
    });
  }, 60_000);

  it('never takes a customer’s song, an aligned or estimated timeline, or a deleted song', async () => {
    const customer = await h.createUser({ credits: 5 });
    await timings(await song(customer), 'corrected');
    const staff = await h.createUser({ credits: 5, role: 'admin' });
    await timings(await song(staff), 'aligned');
    await timings(await song(staff), 'estimated');
    const gone = await song(staff);
    await timings(gone, 'corrected');
    await query(`UPDATE tracks SET deleted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [gone]);
    expect(await lyricTruth()).toEqual([]);
  }, 90_000);
});
