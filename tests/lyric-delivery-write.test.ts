/**
 * The timeline written after delivery arrives late — the aligner takes up to
 * a minute — and must not overwrite anything more trustworthy that landed in
 * the meantime (docs/NEXT_ITERATION_MUSIC_FIRST.md, batch 1).
 *
 * Each case does its interfering write from inside `align`, which is exactly
 * the window between delivery and the timing write.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { LyricTimings } from '@yuha/contracts';
import { claimOutboxBatch, execute, query, queryOne, withTx } from '@yuha/db';
import type { AlignmentProvider, AlignmentResult } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let original: AlignmentProvider;
const LYRICS = '[Verse]\nlo-fi hearts\n[Chorus]\nslow down';
const lines = [
  { text: 'lo-fi hearts', section: 'Verse', start: 2, end: 5 },
  { text: 'slow down', section: 'Chorus', start: 6, end: 9 },
];
const mine = [
  { text: 'lo-fi hearts', section: 'Verse', start: 3.1, end: 5.4 },
  { text: 'slow down', section: 'Chorus', start: 6.6, end: 9.2 },
];

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

/** An aligner that lets `meanwhile` run against the delivered song before it answers. */
function aligner(result: AlignmentResult, meanwhile: (trackId: string) => Promise<void>): AlignmentProvider {
  return {
    kind: 'fake',
    align: async () => {
      const t = await queryOne<{ id: string }>(`SELECT id FROM tracks ORDER BY created_at DESC LIMIT 1`);
      await meanwhile(t!.id);
      return result;
    },
  };
}

async function song(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `w-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: LYRICS } as never,
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
const stored = async (id: string) => {
  const t = (await queryOne<{ t: LyricTimings | string | null }>(`SELECT lyric_timings AS t FROM tracks WHERE id = ?`, [id]))!.t;
  return (typeof t === 'string' ? JSON.parse(t) : t) as (LyricTimings & { fallbackReason?: string }) | null;
};

const aligned: AlignmentResult = { status: 'ok', timings: { source: 'aligned', aligner: 'mms-fa', lines } };
const estimated: AlignmentResult = {
  status: 'ok',
  timings: { source: 'estimated', aligner: 'estimated-v1', lines },
  fallbackReason: 'aligner_timeout',
};

describe('the timeline written after delivery', () => {
  it('is written when nothing else landed first', async () => {
    const user = await h.createUser({ credits: 5 });
    (h.ctx as { alignment: AlignmentProvider }).alignment = aligner(aligned, async () => undefined);
    const id = await song(user);
    expect((await stored(id))?.source).toBe('aligned');
  }, 60_000);

  it('does not replace a correction the owner saved while it was being made', async () => {
    const user = await h.createUser({ credits: 5 });
    (h.ctx as { alignment: AlignmentProvider }).alignment = aligner(aligned, async (trackId) => {
      await execute('UPDATE tracks SET lyric_timings = ? WHERE id = ?', [
        JSON.stringify({ source: 'corrected', aligner: 'human', lines: mine }),
        trackId,
      ]);
    });
    const id = await song(user);
    const t = await stored(id);
    expect(t?.source).toBe('corrected');
    expect(t?.lines[0]?.start).toBe(3.1);
    // Reload, as the owner would: still theirs.
    const view = await h.app.inject({ method: 'GET', url: `/v1/tracks/${id}`, headers: user.authHeader });
    expect(view.json().lyricTimings.lines[0].start).toBe(3.1);
  }, 60_000);

  it('does not put an estimate over a timeline the aligner already heard', async () => {
    const user = await h.createUser({ credits: 5 });
    (h.ctx as { alignment: AlignmentProvider }).alignment = aligner(estimated, async (trackId) => {
      await query(`UPDATE tracks SET lyric_timings = ? WHERE id = ?`, [
        JSON.stringify({ source: 'aligned', aligner: 'mms-fa', lines: mine }),
        trackId,
      ]);
    });
    const id = await song(user);
    const t = await stored(id);
    expect(t?.source).toBe('aligned');
    expect(t).not.toHaveProperty('fallbackReason');
  }, 60_000);

  it('writes nothing onto a song deleted while it was being made', async () => {
    const user = await h.createUser({ credits: 5 });
    (h.ctx as { alignment: AlignmentProvider }).alignment = aligner(aligned, async (trackId) => {
      const res = await h.app.inject({ method: 'DELETE', url: `/v1/tracks/${trackId}`, headers: user.authHeader });
      expect(res.statusCode).toBeLessThan(300);
    });
    const id = await song(user);
    expect(await stored(id)).toBeNull();
  }, 60_000);

  it('writes nothing when the lyrics it was made from are no longer the song’s', async () => {
    const user = await h.createUser({ credits: 5 });
    (h.ctx as { alignment: AlignmentProvider }).alignment = aligner(aligned, async (trackId) => {
      await query(`UPDATE tracks SET lyrics = ? WHERE id = ?`, ['[Verse]\nsomething else', trackId]);
    });
    const id = await song(user);
    expect(await stored(id)).toBeNull();
  }, 60_000);
});
