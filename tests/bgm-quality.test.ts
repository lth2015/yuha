/**
 * BGM quality from the DGX's render report (docs/BGM_STUDIO_PLAN.md, B2).
 *
 * A BGM records what the service measured on its raw render — model, render
 * time, clipping, voice heard in it — next to the choices it was made from.
 * Nothing measured here stops a delivery or costs a credit. The owner is told
 * when a voice may be in it; a threshold decides that at read time, so tuning
 * it after the listening review changes past BGM too. A song records nothing
 * here, and nobody but the owner sees the verdict; the raw numbers are never
 * sent to a page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, query, queryOne, withTx } from '@yuha/db';
import type { MusicAudioRef, MusicRenderReport } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let report: MusicRenderReport | undefined;

const measured = (over: Partial<MusicRenderReport> = {}): MusicRenderReport => ({
  engine: 'v15', model: 'ace-step-1.5:xl', renderSeconds: 38.4, peakDbfs: -0.3, clippedRatio: 0, vocalRatio: 0.02, vocalSeconds: 0, ...over,
});

beforeAll(async () => {
  h = await createHarness({ BGM_STUDIO: 'all', BGM_VOICE_SECONDS_MAX: '2' });
  const music = h.ctx.music;
  const withReport = (audio: MusicAudioRef): MusicAudioRef => (report ? { ...audio, report } : audio);
  const submit = music.submit.bind(music);
  const poll = music.poll.bind(music);
  music.submit = async (req) => {
    const r = await submit(req);
    return r.status === 'completed' ? { ...r, audio: withReport(r.audio) } : r;
  };
  music.poll = async (req) => {
    const r = await poll(req);
    return r.status === 'completed' ? { ...r, audio: withReport(r.audio) } : r;
  };
});
beforeEach(async () => {
  await resetData();
  report = undefined;
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const vlog = { scenario: 'vlog', genre: 'japanese_healing', mood: 'warm', durationSeconds: 30, tempo: 'medium', note: '' };

async function make(user: TestUser, body: Record<string, unknown>): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `q-${randomUUID()}` },
    payload: body as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 8; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `q-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}
const stored = async (id: string) => {
  const b = (await queryOne<{ b: unknown }>(`SELECT bgm AS b FROM tracks WHERE id = ?`, [id]))!.b;
  return (typeof b === 'string' ? JSON.parse(b) : b) as Record<string, unknown> | null;
};
const view = async (user: TestUser | null, id: string) =>
  (await h.app.inject({ method: 'GET', url: `/v1/tracks/${id}`, headers: user ? user.authHeader : {} })).json();

describe('a BGM’s render report', () => {
  it('is recorded with the BGM, and the owner is told when a voice may be in it', async () => {
    const user = await h.createUser({ credits: 3 });
    report = measured({ vocalRatio: 0.21, vocalSeconds: 6.5, clippedRatio: 0.004 });
    const id = await make(user, { bgm: vlog });
    expect((await stored(id))?.quality).toEqual({
      engine: 'v15', model: 'ace-step-1.5:xl', renderSeconds: 38.4, peakDbfs: -0.3, clippedRatio: 0.004, vocalRatio: 0.21, vocalSeconds: 6.5,
    });
    const v = await view(user, id);
    expect(v.bgmVoiceHeard).toBe(true);
    // The page gets a verdict, not the measurements, and the choices stay the choices.
    expect(v.bgm).toEqual({ ...vlog });
    expect(JSON.stringify(v)).not.toContain('vocalRatio');
    expect(JSON.stringify(v)).not.toContain('clippedRatio');
  }, 60_000);

  it('says no voice under the threshold, and "not measured" when nothing was measured', async () => {
    const user = await h.createUser({ credits: 3 });
    report = measured({ vocalSeconds: 1.5 });
    expect((await view(user, await make(user, { bgm: vlog }))).bgmVoiceHeard).toBe(false);
    report = measured({ vocalRatio: null, vocalSeconds: null });
    expect((await view(user, await make(user, { bgm: vlog }))).bgmVoiceHeard).toBeNull();
    report = undefined; // a DGX not yet updated
    const none = await make(user, { bgm: vlog });
    expect((await stored(none))?.quality).toBeNull();
    expect((await view(user, none)).bgmVoiceHeard).toBeNull();
  }, 90_000);

  it('is the owner’s to see; a visitor on a shared link is not told', async () => {
    const user = await h.createUser({ credits: 3 });
    report = measured({ vocalSeconds: 9 });
    const id = await make(user, { bgm: vlog });
    await query(`UPDATE tracks SET visibility = 'public' WHERE id = ?`, [id]);
    const stranger = await h.createUser({ credits: 0 });
    for (const who of [null, stranger]) {
      const v = await view(who, id);
      expect(v.trackId).toBe(id); // the link opens
      expect(v.bgm).toEqual({ ...vlog }); // the choices, as the owner sees them
      expect('bgmVoiceHeard' in v).toBe(false);
      for (const word of ['quality', 'vocalSeconds', 'vocalRatio', 'clippedRatio', 'ace-step-1.5']) expect(JSON.stringify(v)).not.toContain(word);
    }
  }, 60_000);

  it('records nothing on a song, report or not', async () => {
    const user = await h.createUser({ credits: 3 });
    report = measured({ vocalSeconds: 30 });
    const id = await make(user, { mode: 'simple', prompt: 'a quiet walk', instrumental: true, durationSeconds: 30 });
    expect(await stored(id)).toBeNull();
    expect((await view(user, id)).bgmVoiceHeard ?? null).toBeNull();
  }, 60_000);
});
