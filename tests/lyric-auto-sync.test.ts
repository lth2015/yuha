/**
 * L4a: a new sung song is synced and applied by the platform, after delivery
 * and apart from it (docs/AUTOMATIC_LYRIC_SYNC_TICKETS.md).
 *
 * Delivery no longer waits for the aligner: the song is playable with static
 * lyrics while a durable job aligns it, applies a result that passes, retries
 * one that does not, and gives up honestly. Nobody saves anything.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { LyricTimings } from '@yuha/contracts';
import { claimOutboxBatch, execute, query, queryOne, withTx } from '@yuha/db';
import type { AlignmentProvider, AlignmentRequest, AlignmentResult } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { lyricSyncTick } from '@yuha/worker/lyric-sync';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
const LYRICS = '[Verse]\nlo-fi hearts\n[Chorus]\nslow down';
const lines = [
  { text: 'lo-fi hearts', section: 'Verse', start: 2, end: 5 },
  { text: 'slow down', section: 'Chorus', start: 6, end: 9 },
];
const aligned: AlignmentResult = { status: 'ok', timings: { source: 'aligned', aligner: 'mms-fa', lines } };
const estimate: AlignmentResult = {
  status: 'ok',
  timings: { source: 'estimated', aligner: 'estimated-v1', lines },
  fallbackReason: 'aligner_timeout',
};

let calls: AlignmentRequest[] = [];
let answers: AlignmentResult[] = [];
const scripted: AlignmentProvider = {
  kind: 'scripted',
  align: async (req) => {
    calls.push(req);
    return answers.shift() ?? aligned;
  },
};

beforeAll(async () => {
  h = await createHarness({ LYRIC_AUTO_SYNC: 'all' });
  (h.ctx as { alignment: AlignmentProvider }).alignment = scripted;
});
beforeEach(async () => {
  await resetData();
  calls = [];
  answers = [];
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const log = () => undefined;
const tick = () => lyricSyncTick({ ctx: h.ctx, owner: 'sync-test', log });

async function song(user: TestUser, body: Record<string, unknown> = {}): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `as-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: LYRICS, ...body } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `as-${i}`, log }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}
const view = async (user: TestUser, id: string) =>
  (await h.app.inject({ method: 'GET', url: `/v1/tracks/${id}`, headers: user.authHeader })).json();
const stored = async (id: string) => {
  const t = (await queryOne<{ t: LyricTimings | string | null }>(`SELECT lyric_timings AS t FROM tracks WHERE id = ?`, [id]))!.t;
  return (typeof t === 'string' ? JSON.parse(t) : t) as LyricTimings | null;
};
const jobs = (id: string) =>
  query<{ status: string; attempts: number; failure: string | null; due_in: number }>(
    `SELECT status, attempts, failure, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), next_attempt_at) AS due_in
       FROM lyric_sync_jobs WHERE track_id = ?`,
    [id],
  );
/** Makes a scheduled retry due now, as the clock would. */
const due = (id: string) => query(`UPDATE lyric_sync_jobs SET next_attempt_at = UTC_TIMESTAMP(3) WHERE track_id = ?`, [id]);

describe('a new sung song', () => {
  it('is delivered without waiting for the aligner, and plays with static lyrics while it syncs', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    expect(calls).toHaveLength(0);
    const v = await view(user, id);
    expect(v.lyricSync).toBe('syncing');
    expect(v.lyricTimings).toBeNull();
    expect(await jobs(id)).toMatchObject([{ status: 'queued', attempts: 0 }]);
  }, 60_000);

  it('is aligned and applied by the platform, with nothing for the owner to save', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    expect(await tick()).toBe('worked');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.lyrics).toBe(LYRICS);
    expect((await stored(id))?.source).toBe('aligned');
    expect(await jobs(id)).toMatchObject([{ status: 'applied', attempts: 1 }]);
    const v = await view(user, id);
    expect(v.lyricSync).toBe('synced');
    expect(v.lyricTimings.source).toBe('aligned');
    expect(await tick()).toBe('idle');
  }, 60_000);

  it('says partial when the aligner did not hear a line well enough', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    answers = [{ status: 'ok', timings: { source: 'aligned', aligner: 'mms-fa', lines: [{ ...lines[0]!, confidence: 1 }, { ...lines[1]!, confidence: 0.2 }] } }];
    await tick();
    expect((await view(user, id)).lyricSync).toBe('partial');
  }, 60_000);

  it('is retried later when the aligner fails, and is not retried before then', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    answers = [{ status: 'failed', reason: 'aligner_timeout' }];
    await tick();
    const [j] = await jobs(id);
    expect(j).toMatchObject({ status: 'queued', attempts: 1, failure: 'aligner_timeout' });
    expect(j!.due_in).toBeGreaterThan(30);
    expect(await stored(id)).toBeNull();
    expect((await view(user, id)).lyricSync).toBe('syncing');
    expect(await tick()).toBe('idle');
    await due(id);
    await tick();
    expect((await stored(id))?.source).toBe('aligned');
  }, 60_000);

  it('counts an estimate the aligner fell back to as a failure, not a sync', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    answers = [estimate];
    await tick();
    expect(await jobs(id)).toMatchObject([{ status: 'queued', attempts: 1, failure: 'aligner_timeout' }]);
    expect(await stored(id)).toBeNull();
  }, 60_000);

  it('gives up after its last attempt, keeps a labelled estimate, and says sync is unavailable', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    answers = [estimate, estimate, estimate, estimate];
    for (let i = 0; i < 4; i += 1) {
      await due(id);
      await tick();
    }
    expect(calls).toHaveLength(4);
    expect(await jobs(id)).toMatchObject([{ status: 'failed', attempts: 4 }]);
    expect((await stored(id))?.source).toBe('estimated');
    expect((await view(user, id)).lyricSync).toBe('unavailable');
    await due(id);
    expect(await tick()).toBe('idle');
  }, 60_000);

  it('leaves a correction saved before the result arrived', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    await execute('UPDATE tracks SET lyric_timings = ? WHERE id = ?', [
      JSON.stringify({ source: 'corrected', aligner: 'human', lines: lines.map((l) => ({ ...l, start: l.start + 0.4 })) }),
      id,
    ]);
    await tick();
    expect((await stored(id))?.source).toBe('corrected');
    expect(await jobs(id)).toMatchObject([{ status: 'kept' }]);
    expect((await view(user, id)).lyricSync).toBe('synced');
  }, 60_000);

  it('does not apply a result to audio that is no longer the one it was made from', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    await query(`UPDATE asset_versions SET sha256 = ? WHERE track_id = ? AND kind = 'master'`, ['f'.repeat(64), id]);
    await tick();
    expect(await stored(id)).toBeNull();
    expect(await jobs(id)).toMatchObject([{ status: 'kept' }]);
  }, 60_000);

  it('is one job however often it is asked for', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    const { enqueueLyricSync } = await import('@yuha/db');
    const master = (await queryOne<{ sha256: string }>(`SELECT sha256 FROM asset_versions WHERE track_id = ? AND kind = 'master'`, [id]))!;
    await Promise.all([1, 2, 3].map(() => enqueueLyricSync({ trackId: id, masterSha: master.sha256, lyrics: LYRICS, trigger: 'delivery' })));
    expect(await jobs(id)).toHaveLength(1);
  }, 60_000);

  it('is taken back from a worker that stopped mid-alignment', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    await query(
      `UPDATE lyric_sync_jobs SET status = 'running', attempts = 1, claimed_by = 'gone', claimed_at = UTC_TIMESTAMP(3) - INTERVAL 20 MINUTE WHERE track_id = ?`,
      [id],
    );
    await tick();
    expect(await jobs(id)).toMatchObject([{ status: 'applied', attempts: 2 }]);
  }, 60_000);

  it('has no sync for an instrumental', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user, { instrumental: true, lyrics: undefined });
    expect(await jobs(id)).toHaveLength(0);
    expect((await view(user, id)).lyricSync).toBeNull();
  }, 60_000);
});

describe('while only staff have it', () => {
  let s: Harness;
  beforeAll(async () => {
    s = await createHarness({ LYRIC_AUTO_SYNC: 'staff' });
    (s.ctx as { alignment: AlignmentProvider }).alignment = scripted;
  });
  afterAll(async () => {
    await s?.close();
  });

  it('a customer’s song is aligned during delivery as before, and a staff member’s is queued', async () => {
    const run = async (user: TestUser) => {
      const res = await s.app.inject({
        method: 'POST',
        url: '/v1/generations',
        headers: { ...user.authHeader, 'idempotency-key': `st-${randomUUID()}` },
        payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: LYRICS } as never,
      });
      const jobId = res.json().jobId as string;
      const rows = await withTx((tx) => claimOutboxBatch(50, tx));
      for (const row of rows) await s.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
      for (let i = 0; i < 6; i += 1) {
        await runJobStep({ ctx: s.ctx, owner: `st-${i}`, log }, jobId);
        const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
        if (t) return t.id;
      }
      throw new Error('not delivered');
    };
    const customer = await s.createUser({ credits: 5 });
    const staff = await s.createUser({ credits: 5, role: 'support' });
    const a = await run(customer);
    expect(calls).toHaveLength(1);
    expect((await stored(a))?.source).toBe('aligned');
    expect(await jobs(a)).toHaveLength(0);
    const b = await run(staff);
    expect(calls).toHaveLength(1);
    expect(await jobs(b)).toMatchObject([{ status: 'queued' }]);
  }, 60_000);
});
