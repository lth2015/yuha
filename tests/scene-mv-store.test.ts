/**
 * Scene MV jobs and their shots, as records (docs/AI_SCENE_MV_TICKETS.md, T4;
 * docs/AI_SCENE_MV_SPEC.md: Draft → Queued → Generating → Composing → Ready,
 * plus Failed and Cancelled).
 *
 * Pinned here, at the data layer, so no route or worker can get them wrong:
 * a job only moves forward; one person has one job in the queue at a time,
 * enforced by the database itself rather than by a check two requests can
 * race past; a cancel stops every shot not yet drawn; and the records go with
 * the song.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  advanceSceneMv,
  cancelSceneMv,
  claimNextShot,
  createSceneMvDraft,
  execute,
  finishShot,
  getSceneMv,
  queryOne,
  queueSceneMv,
  withTx,
  claimOutboxBatch,
} from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { removeSceneMvsOfTrack } from '../apps/api/src/services/scene-mv-cleanup.js';
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
    headers: { ...user.authHeader, 'idempotency-key': `smv-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: '[Verse]\nlo-fi hearts' } as never,
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

/** Retries without the five-minute wait the service asks for; the wait itself is pinned below. */
const NOW = { retryAfterSeconds: 0 };
const SHOTS = ['neon street in rain', 'a window, raindrops', 'a train passing', 'dawn over rooftops'];
const draft = (ownerId: string, trackId: string) =>
  createSceneMvDraft({ ownerId, trackId, style: 'neon_rain', description: 'a city at night', clipStart: 30, clipEnd: 60, timingsSha: null, shots: SHOTS });

describe('scene MV records', () => {
  it('keeps a draft with its storyboard, in order, and nothing queued', async () => {
    const user = await h.createUser({ credits: 10 });
    const id = await draft(user.id, await song(user));
    const mv = await getSceneMv(id);
    expect(mv?.status).toBe('draft');
    expect(mv?.shots.map((s) => [s.idx, s.prompt, s.status])).toEqual(SHOTS.map((p, i) => [i, p, 'pending']));
    expect(await claimNextShot('w1', NOW)).toBeNull(); // a draft's shots are not work
  }, 60_000);

  it('lets one person have one job in the queue at a time, and frees the slot when it ends', async () => {
    const user = await h.createUser({ credits: 10 });
    const track = await song(user);
    const a = await draft(user.id, track);
    const b = await draft(user.id, track);
    expect(await queueSceneMv(a, user.id)).toEqual({ ok: true });
    // Two at once, as two tabs would: still only the one.
    const [b1, b2] = await Promise.all([queueSceneMv(b, user.id), queueSceneMv(b, user.id)]);
    expect([b1, b2]).toEqual([{ ok: false, reason: 'busy' }, { ok: false, reason: 'busy' }]);
    expect(await advanceSceneMv(a, 'queued', 'generating')).toBe(true);
    expect(await advanceSceneMv(a, 'generating', 'composing')).toBe(true);
    expect(await advanceSceneMv(a, 'composing', 'ready', { outputKey: 'scene-mv/a.mp4' })).toBe(true);
    expect(await queueSceneMv(b, user.id)).toEqual({ ok: true });
    // Somebody else's queue is theirs.
    const other = await h.createUser({ credits: 10 });
    expect(await queueSceneMv(await draft(other.id, await song(other)), other.id)).toEqual({ ok: true });
  }, 60_000);

  it('moves only forward', async () => {
    const user = await h.createUser({ credits: 10 });
    const id = await draft(user.id, await song(user));
    expect(await advanceSceneMv(id, 'queued', 'generating')).toBe(false); // it is a draft
    await queueSceneMv(id, user.id);
    expect(await queueSceneMv(id, user.id)).toEqual({ ok: false, reason: 'not_draft' });
    expect(await advanceSceneMv(id, 'queued', 'composing')).toBe(false); // skips a stage
    await advanceSceneMv(id, 'queued', 'generating');
    await advanceSceneMv(id, 'generating', 'composing');
    await advanceSceneMv(id, 'composing', 'ready', { outputKey: 'k' });
    expect(await cancelSceneMv(id, user.id)).toBe(false); // finished is finished
    expect(await advanceSceneMv(id, 'ready', 'failed')).toBe(false);
    expect((await getSceneMv(id))?.status).toBe('ready');
  }, 60_000);

  it('works its shots one at a time, oldest job first, and counts the tries', async () => {
    const user = await h.createUser({ credits: 10 });
    const id = await draft(user.id, await song(user));
    await queueSceneMv(id, user.id);
    await advanceSceneMv(id, 'queued', 'generating');
    const first = await claimNextShot('w1', NOW);
    expect(first?.idx).toBe(0);
    expect(await claimNextShot('w2', NOW)).toBeNull(); // one shot in flight across every worker
    await finishShot(first!.id, { status: 'failed', failure: 'out_of_memory' });
    const again = await claimNextShot('w1', NOW);
    expect([again?.idx, again?.attempts]).toEqual([0, 2]); // the failed one again, before the next
    await finishShot(again!.id, { status: 'succeeded', clipKey: 'scene-mv/s0.mp4' });
    expect((await claimNextShot('w1', NOW))?.idx).toBe(1);
  }, 60_000);

  it('tries a failed shot again only after five minutes, drawing the others meanwhile', async () => {
    const user = await h.createUser({ credits: 10 });
    const id = await draft(user.id, await song(user));
    await queueSceneMv(id, user.id);
    await advanceSceneMv(id, 'queued', 'generating');
    const first = await claimNextShot('w1');
    await finishShot(first!.id, { status: 'failed', failure: 'thermal' });
    expect((await claimNextShot('w1'))?.idx).toBe(1); // shot 0 is resting
    await finishShot((await getSceneMv(id))!.shots[1]!.id, { status: 'succeeded', clipKey: 'k1' });
    await execute(`UPDATE scene_mv_shots SET finished_at = UTC_TIMESTAMP(3) - INTERVAL 301 SECOND WHERE id = ?`, [first!.id]);
    expect((await claimNextShot('w1'))?.idx).toBe(0);
  }, 60_000);

  it('gives up on a shot after its one retry, and the job with it', async () => {
    const user = await h.createUser({ credits: 10 });
    const id = await draft(user.id, await song(user));
    await queueSceneMv(id, user.id);
    await advanceSceneMv(id, 'queued', 'generating');
    for (let i = 0; i < 2; i += 1) {
      const s = await claimNextShot('w1', NOW);
      expect(s?.idx).toBe(0);
      await finishShot(s!.id, { status: 'failed', failure: 'out_of_memory' });
    }
    expect(await claimNextShot('w1', NOW)).toBeNull();
    const mv = await getSceneMv(id);
    expect([mv?.status, mv?.failure]).toEqual(['failed', 'shot_failed']);
    // The slot is free again: the platform failed, not the person.
    expect(await queueSceneMv(await draft(user.id, mv!.track_id), user.id)).toEqual({ ok: true });
  }, 60_000);

  it('stops every shot not yet drawn when cancelled, and keeps the ones already done', async () => {
    const user = await h.createUser({ credits: 10 });
    const id = await draft(user.id, await song(user));
    await queueSceneMv(id, user.id);
    await advanceSceneMv(id, 'queued', 'generating');
    const s = await claimNextShot('w1', NOW);
    await finishShot(s!.id, { status: 'succeeded', clipKey: 'k0' });
    const stranger = await h.createUser({ credits: 10 });
    expect(await cancelSceneMv(id, stranger.id)).toBe(false);
    expect(await cancelSceneMv(id, user.id)).toBe(true);
    const mv = await getSceneMv(id);
    expect(mv?.status).toBe('cancelled');
    expect(mv?.shots.map((x) => x.status)).toEqual(['succeeded', 'cancelled', 'cancelled', 'cancelled']);
    expect(await claimNextShot('w1', NOW)).toBeNull();
    // A shot that was in flight when the cancel landed is not saved as done.
    const id2 = await draft(user.id, mv!.track_id);
    await queueSceneMv(id2, user.id);
    await advanceSceneMv(id2, 'queued', 'generating');
    const inFlight = await claimNextShot('w1', NOW);
    await cancelSceneMv(id2, user.id);
    await finishShot(inFlight!.id, { status: 'succeeded', clipKey: 'late' });
    expect((await getSceneMv(id2))?.shots[0]?.status).toBe('cancelled');
  }, 60_000);

  it('goes, with its files and the words written for it, when the owner deletes the song', async () => {
    const user = await h.createUser({ credits: 10 });
    const track = await song(user);
    const done = await draft(user.id, track);
    await queueSceneMv(done, user.id);
    await advanceSceneMv(done, 'queued', 'generating');
    const shot = await claimNextShot('w1', NOW);
    const clipKey = `scene-mv/${randomUUID()}/s0.mp4`;
    await h.ctx.storage.put({ zone: 'delivery', key: clipKey, body: Buffer.from('clip'), contentType: 'video/mp4' });
    await finishShot(shot!.id, { status: 'succeeded', clipKey });
    const res = await h.app.inject({ method: 'DELETE', url: `/v1/tracks/${track}`, headers: user.authHeader });
    expect(res.statusCode).toBeLessThan(300);
    expect(await getSceneMv(done)).toBeNull();
    expect(await queryOne(`SELECT id FROM scene_mv_shots WHERE scene_mv_id = ?`, [done])).toBeFalsy();
    await expect(h.ctx.storage.get('delivery', clipKey)).rejects.toThrow();
    // The slot it held is free: the next song can have one.
    expect(await queueSceneMv(await draft(user.id, await song(user)), user.id)).toEqual({ ok: true });
  }, 60_000);

  it('keeps no words but keeps the record of a file that would not delete', async () => {
    const user = await h.createUser({ credits: 10 });
    const track = await song(user);
    const id = await draft(user.id, track);
    await queueSceneMv(id, user.id);
    await advanceSceneMv(id, 'queued', 'generating');
    const shot = await claimNextShot('w1', NOW);
    await finishShot(shot!.id, { status: 'succeeded', clipKey: 'scene-mv/stuck.mp4' });
    const storage = { ...h.ctx.storage, remove: async () => { throw new Error('storage down'); } } as typeof h.ctx.storage;
    expect(await removeSceneMvsOfTrack(storage, track)).toBe(false);
    const mv = await getSceneMv(id);
    expect([mv?.status, mv?.description]).toEqual(['cancelled', null]);
    expect(mv?.shots.map((x) => x.prompt)).toEqual(['', '', '', '']);
    expect(mv?.shots[0]?.clip_key).toBe('scene-mv/stuck.mp4');
  }, 60_000);
});
