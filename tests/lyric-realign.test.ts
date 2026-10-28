/**
 * Re-aligning old songs' lyrics (docs/LYRIC_ALIGNMENT.md).
 *
 * The aligner on the DGX got better; songs made before that keep the timing
 * they were given until an admin runs this. What is pinned here is what a run
 * may and may not change: it rewrites a song only when the aligner actually
 * heard it, keeps what a song had when it could not, never touches a
 * person's correction (not even one saved while the aligner was busy), and
 * continues an interrupted run without re-doing the songs it finished.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { LyricTimings } from '@yuha/contracts';
import { claimOutboxBatch, query, queryOne, withTx } from '@yuha/db';
import type { AlignmentProvider, AlignmentRequest, AlignmentResult } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let admin: TestUser;
let original: AlignmentProvider;

const LYRICS = '[Verse]\nlo-fi hearts\n[Chorus]\nslow down';

beforeAll(async () => {
  h = await createHarness({ ADMIN_MFA_REQUIRED: 'false' });
  original = h.ctx.alignment;
});
beforeEach(async () => {
  await resetData();
  (h.ctx as { alignment: AlignmentProvider }).alignment = original;
  admin = await h.createUser({ email: 'realign-admin@example.test', role: 'admin' });
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

/** A delivered song, made the way a customer makes one. */
async function song(user: TestUser, body: Record<string, unknown> = {}): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `song-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, energy: 0.3, durationSeconds: 30, lyrics: LYRICS, ...body } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `t-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('song was not delivered');
}

const timingsOf = async (trackId: string) =>
  (await queryOne<{ t: LyricTimings | string | null }>(`SELECT lyric_timings AS t FROM tracks WHERE id = ?`, [trackId]))!.t;
const parsed = (t: LyricTimings | string | null) => (typeof t === 'string' ? (JSON.parse(t) as LyricTimings) : t);

/** An aligner that heard every song: each line starts 1s later than the last. */
function hearing(calls: AlignmentRequest[], before?: (req: AlignmentRequest) => Promise<void>): AlignmentProvider {
  return {
    kind: 'fake-whisper',
    async align(req): Promise<AlignmentResult> {
      calls.push(req);
      await before?.(req);
      const lines = req.lyrics
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('['))
        .map((text, i) => ({ text, section: '', start: 10 + i, end: 11 + i }));
      return { status: 'ok', timings: { source: 'aligned', aligner: 'fake-whisper', lines } };
    },
  };
}

const start = (who: TestUser, key = `realign-${randomUUID()}`) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/admin/lyric-realignments',
    headers: who.authHeader,
    payload: { reason: 'aligner improved', idempotencyKey: key } as never,
  });

async function waitDone(id: string) {
  for (let i = 0; i < 300; i += 1) {
    const r = await h.app.inject({ method: 'GET', url: `/v1/admin/lyric-realignments/${id}`, headers: admin.authHeader });
    if (r.json().status === 'done') return r.json();
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error('re-alignment did not finish');
}

async function realign() {
  const res = await start(admin);
  expect(res.statusCode).toBe(202);
  return waitDone(res.json().id);
}

describe('a re-alignment run', () => {
  it('rewrites an old song with what the aligner heard, finding its audio by the render id', async () => {
    const user = await h.createUser({ credits: 3 });
    const id = await song(user);
    expect(parsed(await timingsOf(id))?.source).toBe('estimated');

    const calls: AlignmentRequest[] = [];
    (h.ctx as { alignment: AlignmentProvider }).alignment = hearing(calls);
    const done = await realign();

    const attempt = await queryOne<{ provider_request_id: string }>(
      `SELECT a.provider_request_id FROM generation_attempts a JOIN tracks t ON t.job_id = a.job_id WHERE t.id = ? AND a.status = 'succeeded'`,
      [id],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.providerRequestId).toBe(attempt!.provider_request_id);
    expect(calls[0]!.lyrics).toBe(LYRICS);
    expect(calls[0]!.durationSeconds).toBeGreaterThan(29);
    const after = parsed(await timingsOf(id))!;
    expect(after.source).toBe('aligned');
    expect(after.lines[0]!.start).toBe(10);
    expect(done).toMatchObject({ tracksSeen: 1, tracksRealigned: 1, tracksKept: 0 });
  });

  it('keeps what a song had when the aligner could not hear it', async () => {
    const user = await h.createUser({ credits: 3 });
    const id = await song(user);
    const before = await timingsOf(id);

    // The production aligner falls back to an estimate when the box fails;
    // an estimate must never replace what the song already had.
    (h.ctx as { alignment: AlignmentProvider }).alignment = {
      kind: 'fallback',
      align: async () => ({ status: 'ok', timings: { source: 'estimated', aligner: 'estimated-v1', lines: [] } }),
    };
    const done = await realign();
    expect(await timingsOf(id)).toEqual(before);
    expect(done).toMatchObject({ tracksSeen: 1, tracksRealigned: 0, tracksKept: 1 });

    (h.ctx as { alignment: AlignmentProvider }).alignment = {
      kind: 'down',
      align: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    await realign();
    expect(await timingsOf(id)).toEqual(before);
  });

  it('never touches a song whose timing a person corrected', async () => {
    const user = await h.createUser({ credits: 3 });
    const id = await song(user);
    const corrected: LyricTimings = {
      source: 'corrected',
      aligner: 'human',
      lines: [
        { text: 'lo-fi hearts', section: 'Verse', start: 3, end: 6 },
        { text: 'slow down', section: 'Chorus', start: 7, end: 9 },
      ],
    };
    await query(`UPDATE tracks SET lyric_timings = ? WHERE id = ?`, [JSON.stringify(corrected), id]);

    const calls: AlignmentRequest[] = [];
    (h.ctx as { alignment: AlignmentProvider }).alignment = hearing(calls);
    const done = await realign();
    expect(calls).toHaveLength(0);
    expect(parsed(await timingsOf(id))).toEqual(corrected);
    expect(done.tracksSeen).toBe(0);
  });

  it('lets a correction saved while the aligner was busy win', async () => {
    const user = await h.createUser({ credits: 3 });
    const id = await song(user);
    const corrected = { source: 'corrected', aligner: 'human', lines: [{ text: 'lo-fi hearts', section: '', start: 2, end: 5 }] };
    (h.ctx as { alignment: AlignmentProvider }).alignment = hearing([], async () => {
      await query(`UPDATE tracks SET lyric_timings = ? WHERE id = ?`, [JSON.stringify(corrected), id]);
    });
    const done = await realign();
    expect(parsed(await timingsOf(id))).toEqual(corrected);
    expect(done).toMatchObject({ tracksRealigned: 0, tracksKept: 1 });
  });

  it('leaves instrumentals alone', async () => {
    const user = await h.createUser({ credits: 3 });
    await song(user, { instrumental: true, lyrics: undefined, mode: 'simple' });
    const calls: AlignmentRequest[] = [];
    (h.ctx as { alignment: AlignmentProvider }).alignment = hearing(calls);
    expect((await h.app.inject({ method: 'GET', url: '/v1/admin/lyric-realignments', headers: admin.authHeader })).json().preview.songs).toBe(0);
    await realign();
    expect(calls).toHaveLength(0);
  });

  it('continues an interrupted run after the last song it finished, and runs once however often it is asked', async () => {
    const user = await h.createUser({ credits: 5 });
    const ids = [await song(user), await song(user), await song(user)].sort();

    // A run a stopped process left behind, one song in.
    const key = `realign-${randomUUID()}`;
    const runId = randomUUID();
    await query(
      `INSERT INTO lyric_realignments (id, idempotency_key, actor_id, reason, cursor_track_id, tracks_seen, tracks_kept)
       VALUES (?, ?, ?, 'aligner improved', ?, 1, 1)`,
      [runId, key, admin.id, ids[0]],
    );
    const calls: AlignmentRequest[] = [];
    (h.ctx as { alignment: AlignmentProvider }).alignment = hearing(calls);

    // A new run is refused while that one is unfinished.
    expect((await start(admin)).statusCode).toBe(409);

    const res = await start(admin, key);
    expect(res.statusCode).toBe(202);
    expect(res.json().id).toBe(runId);
    const done = await waitDone(runId);
    expect(calls).toHaveLength(2);
    expect(parsed(await timingsOf(ids[0]!))?.source).toBe('estimated');
    expect(parsed(await timingsOf(ids[2]!))?.source).toBe('aligned');
    expect(done).toMatchObject({ tracksSeen: 3, tracksRealigned: 2, tracksKept: 1 });

    // Asking again with the same key is the same, finished run.
    const again = await start(admin, key);
    expect(again.json()).toMatchObject({ id: runId, status: 'done' });
    expect(calls).toHaveLength(2);

    const audit = await query<{ action: string }>(`SELECT action FROM audit_logs WHERE subject_id = ? ORDER BY created_at`, [runId]);
    expect(audit.map((a) => a.action)).toContain('lyric_realign.finished');
  });

  it('refuses to start, and says why, when this server has only the estimator', async () => {
    // The run happens in the API process. Configured like the worker it can
    // hear; left on the estimator it would report a clean run that changed
    // nothing.
    const user = await h.createUser({ credits: 3 });
    await song(user);
    const overview = await h.app.inject({ method: 'GET', url: '/v1/admin/lyric-realignments', headers: admin.authHeader });
    expect(overview.json().preview).toMatchObject({ songs: 1, ready: false, aligner: 'estimated-v1' });
    expect((await start(admin)).statusCode).toBe(409);
    expect(await query(`SELECT id FROM lyric_realignments`)).toHaveLength(0);
  });

  it('is for admins only', async () => {
    const support = await h.createUser({ role: 'support' });
    expect((await start(support)).statusCode).toBe(403);
    const customer = await h.createUser();
    expect((await start(customer)).statusCode).toBe(403);
  });
});
