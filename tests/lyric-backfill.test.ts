/**
 * L4b: an older song with no heard timeline is synced when its owner opens it
 * (docs/AUTOMATIC_LYRIC_SYNC_TICKETS.md; acceptance from Codex, 2026-11-26):
 *
 *   1. it is aligned from YUHA's own master — never from the DGX's render,
 *      which an old song may still name but which was cleared long ago;
 *   2. a day's quota spent, it plays with static words, says it will try the
 *      next time it is opened, and does; tabs share one slot, and a visitor on
 *      a shared link never starts one;
 *   3. nobody saves anything. This file pins the server side; the page's
 *      polling and swap are pinned in tests/lyric-sync-refresh.test.ts and
 *      were checked in a browser (PR #156/#157).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { LyricTimings } from '@yuha/contracts';
import { claimOutboxBatch, query, queryOne, withTx } from '@yuha/db';
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
const heard: AlignmentResult = { status: 'ok', timings: { source: 'aligned', aligner: 'mms-fa', lines } };
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
    return answers.shift() ?? heard;
  },
};

beforeAll(async () => {
  h = await createHarness({ LYRIC_BACKFILL: 'all', LYRIC_BACKFILL_DAILY: '2' });
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
const tick = () => lyricSyncTick({ ctx: h.ctx, owner: 'backfill-test', log });

/** A song made before automatic sync: the aligner fell back during delivery, so it has an estimate. */
async function oldSong(user: TestUser, body: Record<string, unknown> = {}): Promise<string> {
  answers = [estimate];
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `bf-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: LYRICS, ...body } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `bf-${i}`, log }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) {
      calls = [];
      answers = [];
      return t.id;
    }
  }
  throw new Error('not delivered');
}
const open = async (user: TestUser | null, id: string) =>
  (await h.app.inject({ method: 'GET', url: `/v1/tracks/${id}`, headers: user ? user.authHeader : {} })).json();
const stored = async (id: string) => {
  const t = (await queryOne<{ t: LyricTimings | string | null }>(`SELECT lyric_timings AS t FROM tracks WHERE id = ?`, [id]))!.t;
  return (typeof t === 'string' ? JSON.parse(t) : t) as LyricTimings | null;
};
const jobs = (id: string) =>
  query<{ status: string; trigger_kind: string; attempts: number }>(
    `SELECT status, trigger_kind, attempts FROM lyric_sync_jobs WHERE track_id = ?`,
    [id],
  );
/** Moves a song's sync history to yesterday (JST), as a night passing would. */
const nightPasses = () =>
  query(`UPDATE lyric_sync_jobs SET created_at = created_at - INTERVAL 1 DAY, finished_at = finished_at - INTERVAL 1 DAY`);

describe('an older song its owner opens', () => {
  it('is synced from YUHA’s own master, though it still names a DGX render', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await oldSong(user);
    expect((await stored(id))?.source).toBe('estimated');
    const pr = await queryOne<{ p: string | null }>(
      `SELECT a.provider_request_id AS p FROM generation_attempts a JOIN tracks t ON t.job_id = a.job_id
        WHERE t.id = ? AND a.provider_request_id IS NOT NULL LIMIT 1`,
      [id],
    );
    expect(pr?.p).toBeTruthy(); // the render's id is still on record

    const v = await open(user, id);
    expect(v.lyricSync).toBe('syncing');
    expect(await jobs(id)).toMatchObject([{ status: 'queued', trigger_kind: 'backfill' }]);

    await tick();
    expect(calls).toHaveLength(1);
    const master = (await queryOne<{ storage_key: string }>(`SELECT storage_key FROM asset_versions WHERE track_id = ? AND kind = 'master'`, [id]))!;
    const bytes = await h.ctx.storage.get('delivery', master.storage_key);
    expect(calls[0]!.audio).toBeDefined();
    expect(Buffer.compare(calls[0]!.audio!, bytes)).toBe(0);
    expect((await stored(id))?.source).toBe('aligned');
    expect((await open(user, id)).lyricSync).toBe('synced');
  }, 60_000);

  it('takes one slot however many tabs open it', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await oldSong(user);
    await Promise.all([1, 2, 3, 4].map(() => open(user, id)));
    expect(await jobs(id)).toHaveLength(1);
    const other = await oldSong(user);
    expect((await open(user, other)).lyricSync).toBe('syncing'); // the quota of 2 had room for a second song
  }, 60_000);

  it('is not started by a visitor on a shared link, nor by the library list', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await oldSong(user);
    await query(`UPDATE tracks SET visibility = 'public' WHERE id = ?`, [id]);
    const stranger = await h.createUser({ credits: 0 });
    expect((await open(null, id)).trackId).toBe(id);
    expect((await open(stranger, id)).trackId).toBe(id);
    await h.app.inject({ method: 'GET', url: '/v1/tracks', headers: user.authHeader });
    expect(await jobs(id)).toHaveLength(0);
  }, 60_000);

  it('waits for tomorrow when the day’s quota is spent, still playable, and tries when opened again', async () => {
    const user = await h.createUser({ credits: 10 });
    const [a, b, c] = [await oldSong(user), await oldSong(user), await oldSong(user)];
    await open(user, a);
    await open(user, b);
    const v = await open(user, c);
    expect(v.lyricSync).toBe('deferred');
    expect(v.previewUrl).toBeTruthy();
    expect(v.lyricTimings.source).toBe('estimated');
    expect(await jobs(c)).toHaveLength(0);

    await nightPasses();
    expect((await open(user, c)).lyricSync).toBe('syncing');
    expect(await jobs(c)).toMatchObject([{ status: 'queued', trigger_kind: 'backfill' }]);
  }, 60_000);

  it('does not call a busy moment a spent quota', async () => {
    // Another request holds the queue's lock (an owner opening songs in another tab, at that instant).
    const user = await h.createUser({ credits: 5 });
    const id = await oldSong(user);
    const { db } = await import('@yuha/db');
    const holder = await db().getConnection();
    try {
      await holder.query(`SELECT GET_LOCK('yuha_lyric_backfill', 5)`);
      const v = await open(user, id);
      // Neither 'today's limit' (nothing measured it) nor 'syncing' (nothing was queued).
      expect(v.lyricSync).not.toBe('deferred');
      expect(v.lyricSync).not.toBe('syncing');
      expect(await jobs(id)).toHaveLength(0);
    } finally {
      await holder.query(`SELECT RELEASE_LOCK('yuha_lyric_backfill')`);
      holder.release();
    }
    // The next open, with the lock free, queues it as usual.
    expect((await open(user, id)).lyricSync).toBe('syncing');
  }, 60_000);

  it('tries a failed sync again the next day, not the same day', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await oldSong(user);
    await open(user, id);
    await query(`UPDATE lyric_sync_jobs SET status = 'failed', attempts = 4, finished_at = UTC_TIMESTAMP(3) WHERE track_id = ?`, [id]);
    expect((await open(user, id)).lyricSync).toBe('unavailable');
    expect(await jobs(id)).toMatchObject([{ status: 'failed' }]);

    await nightPasses();
    expect((await open(user, id)).lyricSync).toBe('syncing');
    expect(await jobs(id)).toMatchObject([{ status: 'queued', attempts: 0 }]);
  }, 60_000);

  it('leaves a heard or corrected song alone', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await oldSong(user);
    await query(`UPDATE tracks SET lyric_timings = ? WHERE id = ?`, [JSON.stringify({ source: 'corrected', aligner: 'human', lines }), id]);
    expect((await open(user, id)).lyricSync).toBe('synced');
    await query(`UPDATE tracks SET lyric_timings = ? WHERE id = ?`, [JSON.stringify({ source: 'aligned', aligner: 'mms-fa', lines }), id]);
    expect((await open(user, id)).lyricSync).toBe('synced');
    expect(await jobs(id)).toHaveLength(0);
  }, 60_000);

  it('lets a new song’s sync go first', async () => {
    const user = await h.createUser({ credits: 5 });
    const old = await oldSong(user);
    await open(user, old);
    const fresh = await oldSong(user);
    const master = (await queryOne<{ sha256: string }>(`SELECT sha256 FROM asset_versions WHERE track_id = ? AND kind = 'master'`, [fresh]))!;
    const { enqueueLyricSync } = await import('@yuha/db');
    await enqueueLyricSync({ trackId: fresh, masterSha: master.sha256, lyrics: LYRICS, trigger: 'delivery' });
    await tick();
    expect(await jobs(fresh)).toMatchObject([{ status: 'applied' }]);
    expect(await jobs(old)).toMatchObject([{ status: 'queued' }]);
  }, 60_000);
});

describe('with backfill off, for customers while only staff have it, or with no aligner that listens', () => {
  it('starts nothing', async () => {
    const off = await createHarness({ LYRIC_BACKFILL: 'off' });
    const staffOnly = await createHarness({ LYRIC_BACKFILL: 'staff' });
    const deaf = await createHarness({ LYRIC_BACKFILL: 'all' }); // the estimator: nothing would be heard
    try {
      for (const x of [off, staffOnly, deaf]) {
        if (x !== deaf) (x.ctx as { alignment: AlignmentProvider }).alignment = scripted;
      }
      const user = await h.createUser({ credits: 5 });
      const id = await oldSong(user);
      for (const x of [off, staffOnly, deaf]) {
        await x.app.inject({ method: 'GET', url: `/v1/tracks/${id}`, headers: user.authHeader });
      }
      expect(await jobs(id)).toHaveLength(0);

      const staff = await h.createUser({ credits: 5, role: 'support' });
      const theirs = await oldSong(staff);
      await staffOnly.app.inject({ method: 'GET', url: `/v1/tracks/${theirs}`, headers: staff.authHeader });
      expect(await jobs(theirs)).toMatchObject([{ trigger_kind: 'backfill' }]);
    } finally {
      await off.close();
      await staffOnly.close();
      await deaf.close();
    }
  }, 90_000);
});
