/**
 * Drawing a scene MV's shots (docs/AI_SCENE_MV_TICKETS.md, T5), against the
 * demo video provider, which keeps the dgxv service's rules.
 *
 * Pinned: shots go to the machine one at a time and two people's jobs take
 * turns; each drawn shot is checked silent and kept; a failed shot is tried
 * again on its own and three failures end the job; a busy service does not
 * spend a try; a restarted worker asks after a shot rather than asking for it
 * again; and nothing more is asked for a cancelled job.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cancelSceneMv, claimNextShot, startQueuedSceneMvs, claimOutboxBatch, createSceneMvDraft, getSceneMv, queryOne, queueSceneMv, withTx } from '@yuha/db';
import { DemoVideoProvider, type VideoProvider } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { sceneMvTick, shotSeconds, type TickOutcome } from '@yuha/worker/scene-mv';
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

async function song(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `smvp-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: '[Verse]\nlo-fi hearts' } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `p-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}

async function queued(user: TestUser, shots: string[]): Promise<string> {
  const id = await createSceneMvDraft({ ownerId: user.id, trackId: await song(user), style: 'neon_rain', description: null, clipStart: 0, clipEnd: 4 * shots.length, timingsSha: null, shots });
  expect(await queueSceneMv(id, user.id)).toEqual({ ok: true });
  return id;
}

// Retries here do not wait the service's five minutes; tests/scene-mv-store.test.ts pins that wait.
const deps = (video: VideoProvider, owner = 'w1') => ({ video, storage: h.ctx.storage, owner, log: () => undefined, retryAfterSeconds: 0 });

/** Ticks until nothing is left to do, or the limit. */
async function run(video: VideoProvider, limit = 200, owner = 'w1'): Promise<TickOutcome[]> {
  const seen: TickOutcome[] = [];
  for (let i = 0; i < limit; i += 1) {
    const o = await sceneMvTick(deps(video, owner));
    seen.push(o);
    if (o === 'idle') return seen;
    if (o === 'waiting') await new Promise((r) => setTimeout(r, 15));
  }
  return seen;
}

describe('drawing a scene MV', () => {
  it('asks for each shot in turn, keeps it silent, and moves the MV on to composing', async () => {
    const user = await h.createUser({ credits: 10 });
    const video = new DemoVideoProvider({ delayMs: 10 });
    const id = await queued(user, ['neon street', 'a window', 'a train', 'dawn']);
    await run(video);
    expect(video.submitted.map((r) => [r.prompt, r.seconds, r.orientation])).toEqual([
      ['neon street', 4, 'portrait'],
      ['a window', 4, 'portrait'],
      ['a train', 4, 'portrait'],
      ['dawn', 4, 'portrait'],
    ]);
    const mv = await getSceneMv(id);
    expect(mv?.status).toBe('composing');
    // Kept here, so the service's copies are let go of, as its note asks.
    expect(video.discarded).toHaveLength(4);
    for (const s of mv!.shots) {
      expect(s.status).toBe('succeeded');
      const bytes = await h.ctx.storage.get('delivery', s.clip_key!);
      expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    }
  }, 60_000);

  it('lets two people take turns on the machine', async () => {
    const a = await h.createUser({ credits: 10 });
    const b = await h.createUser({ credits: 10 });
    const video = new DemoVideoProvider({ delayMs: 10 });
    await queued(a, ['a0', 'a1', 'a2']);
    await queued(b, ['b0', 'b1', 'b2']);
    await run(video);
    expect(video.submitted.map((r) => r.prompt)).toEqual(['a0', 'b0', 'a1', 'b1', 'a2', 'b2']);
  }, 60_000);

  it('tries a failed shot again on its own, once, and gives up on the MV after that', async () => {
    const user = await h.createUser({ credits: 10 });
    const video = new DemoVideoProvider({ delayMs: 10 });
    video.failNext = { count: 1, reason: 'out_of_memory' };
    const ok = await queued(user, ['s0', 's1']);
    await run(video);
    expect(video.submitted.map((r) => r.prompt)).toEqual(['s0', 's0', 's1']);
    expect((await getSceneMv(ok))?.status).toBe('composing');

    const other = await h.createUser({ credits: 10 });
    const bad = await queued(other, ['x0', 'x1']);
    video.failNext = { count: 2, reason: 'out_of_memory' };
    await run(video);
    const mv = await getSceneMv(bad);
    expect([mv?.status, mv?.failure]).toEqual(['failed', 'shot_failed']);
    expect(video.submitted.filter((r) => r.prompt === 'x1')).toHaveLength(0);
    // Every clip asked for — drawn or failed — is let go of at the service, prompt and all,
    // rather than left there for its seven days (docs/legal/PRIVACY_CHANGES_SCENE_MV.md).
    expect(video.discarded).toHaveLength(video.submitted.length);
  }, 60_000);

  it('does not spend a try when the service is busy', async () => {
    const user = await h.createUser({ credits: 10 });
    let busy = 2;
    const demo = new DemoVideoProvider({ delayMs: 10 });
    const video: VideoProvider = {
      kind: 'busy-then-fine',
      submit: async (req) => (busy-- > 0 ? { status: 'rejected', reason: 'queue_full', retryable: true } : demo.submit(req)),
      status: (id) => demo.status(id),
      fetchClip: (id) => demo.fetchClip(id),
      discard: (id) => demo.discard(id),
    };
    const id = await queued(user, ['only']);
    expect(await sceneMvTick(deps(video))).toBe('released');
    expect(await sceneMvTick(deps(video))).toBe('released');
    await run(video);
    const mv = await getSceneMv(id);
    expect([mv?.status, mv?.shots[0]?.attempts]).toEqual(['composing', 1]);
  }, 60_000);

  it('asks after a shot a stopped worker submitted, rather than asking for it again', async () => {
    const user = await h.createUser({ credits: 10 });
    const video = new DemoVideoProvider({ delayMs: 200 });
    const id = await queued(user, ['only']);
    expect(await sceneMvTick(deps(video, 'pod-a'))).toBe('submitted');
    // pod-a is gone; pod-b carries on.
    await run(video, 200, 'pod-b');
    expect(video.submitted).toHaveLength(1);
    expect((await getSceneMv(id))?.status).toBe('composing');
  }, 60_000);

  it('lets only the worker that claimed a shot ask for it, and takes over from one that stopped', async () => {
    const user = await h.createUser({ credits: 10 });
    const video = new DemoVideoProvider({ delayMs: 10 });
    const id = await queued(user, ['only']);
    await startQueuedSceneMvs();
    // pod-a has claimed it and not yet asked; pod-b ticks in that moment.
    expect((await claimNextShot('pod-a', { retryAfterSeconds: 0 }))?.idx).toBe(0);
    expect(await sceneMvTick(deps(video, 'pod-b'))).toBe('waiting');
    expect(video.submitted).toHaveLength(0);
    // pod-a never comes back: after a while pod-b hands the shot back, with its try, and draws it.
    expect(await sceneMvTick({ ...deps(video, 'pod-b'), claimStaleMs: -1 })).toBe('released');
    await run(video, 200, 'pod-b');
    const mv = await getSceneMv(id);
    expect([video.submitted.length, mv?.status, mv?.shots[0]?.attempts]).toEqual([1, 'composing', 1]);
  }, 60_000);

  it('asks for nothing more once the MV is cancelled', async () => {
    const user = await h.createUser({ credits: 10 });
    const video = new DemoVideoProvider({ delayMs: 50 });
    const id = await queued(user, ['s0', 's1', 's2']);
    expect(await sceneMvTick(deps(video))).toBe('submitted');
    expect(await cancelSceneMv(id, user.id)).toBe(true);
    await run(video);
    expect(video.submitted.map((r) => r.prompt)).toEqual(['s0']);
    const mv = await getSceneMv(id);
    expect(mv?.status).toBe('cancelled');
    expect(mv?.shots.every((s) => s.status === 'cancelled' && !s.clip_key)).toBe(true);
  }, 60_000);

  it('refuses a clip that carries sound, and one that has stopped answering', async () => {
    const user = await h.createUser({ credits: 10 });
    const withSound = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=288x512:rate=24', '-f', 'lavfi', '-i', 'sine', '-t', '1', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']).stdout;
    const noisy: VideoProvider = {
      kind: 'noisy',
      submit: async () => ({ status: 'accepted', id: 'n1' }),
      status: async () => ({ status: 'succeeded' }),
      fetchClip: async () => withSound,
      discard: async () => undefined,
    };
    const id = await queued(user, ['only']);
    await sceneMvTick(deps(noisy));
    await sceneMvTick(deps(noisy));
    expect((await getSceneMv(id))?.shots[0]).toMatchObject({ status: 'failed', failure: 'clip_has_audio', clip_key: null });

    const silent: VideoProvider = { kind: 'silent', submit: async () => ({ status: 'accepted', id: 's1' }), status: async () => ({ status: 'running', queuePosition: null }), fetchClip: async () => Buffer.alloc(0), discard: async () => undefined };
    await sceneMvTick({ ...deps(silent), shotTimeoutMs: -1 }); // submit the retry
    expect(await sceneMvTick({ ...deps(silent), shotTimeoutMs: -1 })).toBe('failed');
    expect((await getSceneMv(id))?.shots[0]?.failure).toBe('timeout');
  }, 60_000);
});

describe('shot length', () => {
  it('shares the span out, never past what the service draws', () => {
    expect(shotSeconds(30, 60, 4)).toBe(8);
    expect(shotSeconds(0, 16, 4)).toBe(4);
    expect(shotSeconds(0, 60, 4)).toBe(8);
    expect(shotSeconds(0, 2, 4)).toBe(1);
  });
});
