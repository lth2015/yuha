/**
 * Whether sung songs get real lyric timing, and why not when they don't
 * (docs/LYRIC_ALIGNMENT.md, "Diagnosing").
 *
 * The aligner's reason for falling back to an estimate was only logged, and
 * logs are kept fifteen days: a customer reporting lyrics out of step with a
 * three-week-old song left nothing to look at. The reason is now kept with the
 * song's timing, never sent to the client, and counted in the console's quality figures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { LyricTimings } from '@yuha/contracts';
import { claimOutboxBatch, execute, qualityReport, query, queryOne, withTx } from '@yuha/db';
import type { AlignmentProvider, AlignmentResult } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let original: AlignmentProvider;
const LYRICS = '[Verse]\nlo-fi hearts\n[Chorus]\nslow down';

beforeAll(async () => {
  h = await createHarness();
  original = h.ctx.alignment;
});
beforeEach(async () => {
  await resetData();
  (h.ctx as { alignment: AlignmentProvider }).alignment = original;
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const answering = (result: AlignmentResult): AlignmentProvider => ({ kind: 'fake', align: async () => result });
const lines = [
  { text: 'lo-fi hearts', section: 'Verse', start: 2, end: 5 },
  { text: 'slow down', section: 'Chorus', start: 6, end: 9 },
];

async function song(user: TestUser, body: Record<string, unknown> = {}): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `sync-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: LYRICS, ...body } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `s-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}
const stored = async (id: string) => {
  const t = (await queryOne<{ t: LyricTimings | string | null }>(`SELECT lyric_timings AS t FROM tracks WHERE id = ?`, [id]))!.t;
  return (typeof t === 'string' ? JSON.parse(t) : t) as (LyricTimings & { fallbackReason?: string }) | null;
};

describe('why a song’s lyric timing is an estimate', () => {
  it('is kept with the song, and is not sent to the owner', async () => {
    const user = await h.createUser({ credits: 5 });
    (h.ctx as { alignment: AlignmentProvider }).alignment = answering({
      status: 'ok',
      timings: { source: 'estimated', aligner: 'estimated-v1', lines },
      fallbackReason: 'aligner_http_422 low_coverage coverage=0.31',
    });
    const id = await song(user);
    expect((await stored(id))?.fallbackReason).toBe('aligner_http_422 low_coverage coverage=0.31');
    const view = await h.app.inject({ method: 'GET', url: `/v1/tracks/${id}`, headers: user.authHeader });
    expect(view.json().lyricTimings.source).toBe('estimated');
    expect(view.json().lyricTimings).not.toHaveProperty('fallbackReason');
  }, 60_000);

  it('is not kept once a person corrects the timing', async () => {
    const user = await h.createUser({ credits: 5 });
    (h.ctx as { alignment: AlignmentProvider }).alignment = answering({
      status: 'ok',
      timings: { source: 'estimated', aligner: 'estimated-v1', lines },
      fallbackReason: 'aligner_timeout',
    });
    const id = await song(user);
    await execute('UPDATE tracks SET lyric_timings = ? WHERE id = ?', [
      JSON.stringify({ source: 'corrected', aligner: 'human', lines: lines }),
      id,
    ]);
    expect(await stored(id)).not.toHaveProperty('fallbackReason');
  }, 60_000);
});

describe('the console’s lyric sync figure', () => {
  it('says why sung songs were not aligned, grouped by the reason’s first word', async () => {
    const user = await h.createUser({ credits: 20 });
    const set = (r: AlignmentResult) => ((h.ctx as { alignment: AlignmentProvider }).alignment = answering(r));
    set({ status: 'ok', timings: { source: 'aligned', aligner: 'spark-whisper', lines } });
    await song(user);
    set({ status: 'ok', timings: { source: 'estimated', aligner: 'estimated-v1', lines }, fallbackReason: 'aligner_http_422 low_coverage coverage=0.31' });
    await song(user);
    set({ status: 'ok', timings: { source: 'estimated', aligner: 'estimated-v1', lines }, fallbackReason: 'aligner_http_422 low_coverage coverage=0.12' });
    await song(user);
    set({ status: 'ok', timings: { source: 'estimated', aligner: 'estimated-v1', lines }, fallbackReason: 'aligner_timeout' });
    await song(user);
    // The aligner failed outright and nothing could be stored: no timeline at all.
    set({ status: 'failed', reason: 'no_audio_url: ALIGNMENT_AUDIO_URL_TEMPLATE is not set' });
    await song(user);
    // An estimate that was the only aligner configured carries no reason.
    set({ status: 'ok', timings: { source: 'estimated', aligner: 'estimated-v1', lines } });
    await song(user);
    // Sung with no words (the text model wrote none, or they failed screening):
    // nothing to align, said as such rather than as an aligner failure.
    await song(user, { mode: 'simple', lyrics: undefined, styles: [], prompt: 'rain on glass' });
    // A song whose words went with its deletion, as an account deletion or an
    // unclaimed trial's expiry does it (services/deletion.ts, guest-trial.ts).
    set({ status: 'ok', timings: { source: 'aligned', aligner: 'spark-whisper', lines } });
    const gone = await song(user);
    await query(`UPDATE tracks SET deleted_at = UTC_TIMESTAMP(3), lyrics = NULL, lyric_timings = NULL WHERE id = ?`, [gone]);
    // An instrumental is not a sung song and is not counted.
    await song(user, { instrumental: true, lyrics: undefined, prompt: 'rain on glass' });

    const report = await qualityReport({ hours: 24 });
    expect([report.lyricsAligned.numerator, report.lyricsAligned.denominator]).toEqual([1, 8]);
    expect(report.lyricsFallback).toEqual([
      { reason: 'aligner_http_422', n: 2 },
      { reason: 'aligner_timeout', n: 1 },
      { reason: 'deleted', n: 1 },
      { reason: 'no_lyrics', n: 1 },
      { reason: 'no_timing', n: 1 },
      { reason: 'not_recorded', n: 1 },
    ]);
  }, 120_000);
});
