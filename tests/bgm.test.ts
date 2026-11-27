/**
 * AI BGM, Phase 1 (docs/BGM_STUDIO_PLAN.md): instrumental background music
 * through the same generation pipeline as songs, from a deterministic prompt
 * template rather than the text model, 15/30/60 seconds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  BGM_GENRES,
  BGM_MOODS,
  BGM_SCENARIOS,
  BGM_TEMPOS,
  bgmIntent,
  musicIntent,
  type BgmRequest,
} from '@yuha/contracts';
import { claimOutboxBatch, query, queryOne, withTx } from '@yuha/db';
import type { MusicSubmitRequest } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { BGM_PROHIBITED_USES } from '../apps/api/src/services/delivery.js';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let submitted: MusicSubmitRequest[] = [];

beforeAll(async () => {
  h = await createHarness({ BGM_STUDIO: 'all' });
  const music = h.ctx.music;
  const submit = music.submit.bind(music);
  music.submit = async (req: MusicSubmitRequest) => {
    submitted.push(req);
    return submit(req);
  };
});
beforeEach(async () => {
  await resetData();
  submitted = [];
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const vlog: BgmRequest = { scenario: 'vlog', genre: 'japanese_healing', mood: 'warm', durationSeconds: 30, tempo: 'medium', note: '' };

async function post(user: TestUser, body: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `bgm-${randomUUID()}` },
    payload: body as never,
  });
}

async function run(jobId: string): Promise<string | null> {
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 8; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `bgm-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  return null;
}

describe('the BGM prompt template', () => {
  it('turns every choice into words the music model receives, for every combination', () => {
    for (const scenario of BGM_SCENARIOS)
      for (const genre of BGM_GENRES)
        for (const mood of BGM_MOODS)
          for (const tempo of BGM_TEMPOS) {
            const intent = bgmIntent({ scenario, genre, mood, tempo, durationSeconds: 30, note: '' });
            expect(musicIntent.safeParse(intent).success).toBe(true);
            expect(intent.vocalMode).toBe('instrumental');
            expect(intent.lyrics).toBeNull();
            expect(intent.tempoHint).toBe(tempo);
            expect(intent.brief.length).toBeLessThanOrEqual(400);
          }
    // Different choices, different words: no option is silently dropped.
    const briefs = (key: keyof BgmRequest, values: readonly string[]) =>
      new Set(values.map((v) => { const i = bgmIntent({ ...vlog, [key]: v }); return `${i.brief}|${i.styles.join(',')}|${i.mood}`; }));
    expect(briefs('scenario', BGM_SCENARIOS).size).toBe(BGM_SCENARIOS.length);
    expect(briefs('genre', BGM_GENRES).size).toBe(BGM_GENRES.length);
    expect(briefs('mood', BGM_MOODS).size).toBe(BGM_MOODS.length);
  });
});

describe('making a BGM', () => {
  it('goes through the song pipeline as an instrumental, from the template, without the text model, for one unit', async () => {
    const user = await h.createUser({ credits: 3 });
    const res = await post(user, { bgm: vlog });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().jobId as string;
    const trackId = await run(jobId);
    expect(trackId).toBeTruthy();

    expect(submitted).toHaveLength(1);
    const sent = submitted[0]!.intent;
    expect(sent.vocalMode).toBe('instrumental');
    expect(sent.lyrics).toBeNull();
    expect(sent.durationSeconds).toBe(30);
    expect(sent).toMatchObject({ brief: bgmIntent(vlog).brief, styles: bgmIntent(vlog).styles, tempoHint: 'medium' });

    const textCalls = await query(`SELECT id FROM provider_cost_events WHERE job_id = ? AND provider_kind = 'text'`, [jobId]);
    expect(textCalls).toHaveLength(0);

    const t = (await queryOne<{ kind: string; vocal_mode: string; duration_ms: number; bgm: unknown }>(
      `SELECT kind, vocal_mode, duration_ms, bgm FROM tracks WHERE id = ?`,
      [trackId],
    ))!;
    expect(t).toMatchObject({ kind: 'bgm', vocal_mode: 'instrumental' });
    expect(Math.abs(Number(t.duration_ms) - 30_000)).toBeLessThan(1000);
    const view = (await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}`, headers: user.authHeader })).json();
    expect(view.kind).toBe('bgm');
    expect(view.bgm).toMatchObject({ scenario: 'vlog', genre: 'japanese_healing', mood: 'warm', durationSeconds: 30, tempo: 'medium' });

    // Its usage record is frozen under Terms §4a, not a song's §4: the BGM
    // limits travel with the BGM even before commercial delivery is on.
    const rec = (await queryOne<{ prohibited_uses: unknown }>(`SELECT prohibited_uses FROM license_snapshots WHERE track_id = ?`, [trackId]))!;
    const prohibited = (typeof rec.prohibited_uses === 'string' ? JSON.parse(rec.prohibited_uses) : rec.prohibited_uses) as string[];
    expect(prohibited).toEqual([...BGM_PROHIBITED_USES]);

    // One unit, like a song (docs/BGM_STUDIO_PLAN.md, decision 1).
    const { getBalance } = await import('@yuha/db');
    expect((await getBalance(user.id)).available).toBe(2);
  }, 60_000);

  it('is made at 15 and 60 seconds too', async () => {
    const user = await h.createUser({ credits: 3 });
    for (const seconds of [15, 60]) {
      const res = await post(user, { bgm: { ...vlog, durationSeconds: seconds } });
      expect(res.statusCode).toBe(202);
      const trackId = await run(res.json().jobId as string);
      const t = (await queryOne<{ duration_ms: number }>(`SELECT duration_ms FROM tracks WHERE id = ?`, [trackId]))!;
      expect(Math.abs(Number(t.duration_ms) - seconds * 1000)).toBeLessThan(1000);
    }
  }, 90_000);

  it('passes a note through the text model and the safety screen, never raw to the music model', async () => {
    const user = await h.createUser({ credits: 3 });
    const note = 'a quiet morning at a seaside café';
    const res = await post(user, { bgm: { ...vlog, note } });
    expect(res.statusCode).toBe(202);
    await run(res.json().jobId as string);
    const brief = submitted[0]!.intent.brief;
    expect(brief.startsWith(bgmIntent(vlog).brief.slice(0, 40))).toBe(true);
    expect(brief).not.toContain(note);
    expect(submitted[0]!.intent.vocalMode).toBe('instrumental');
  }, 60_000);

  it('refuses what a BGM cannot be', async () => {
    const user = await h.createUser({ credits: 3 });
    for (const bad of [
      { bgm: { ...vlog, durationSeconds: 45 } },
      { bgm: { ...vlog, durationSeconds: 120 } },
      { bgm: { ...vlog, genre: 'opera' } },
      { bgm: vlog, lyrics: '[Verse]\nla la', mode: 'custom' },
    ]) {
      expect((await post(user, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await query(`SELECT id FROM generation_jobs`)).toHaveLength(0);
  });

  it('is its owner’s alone, and the library can list BGM apart from songs', async () => {
    const user = await h.createUser({ credits: 3 });
    const bgm = await run((await post(user, { bgm: vlog })).json().jobId as string);
    const song = await run((await post(user, { mode: 'simple', prompt: 'a quiet walk', instrumental: true, durationSeconds: 30 })).json().jobId as string);
    const stranger = await h.createUser({ credits: 0 });
    expect((await h.app.inject({ method: 'GET', url: `/v1/tracks/${bgm}`, headers: stranger.authHeader })).statusCode).toBe(404);
    const list = async (q: string) =>
      (await h.app.inject({ method: 'GET', url: `/v1/tracks${q}`, headers: user.authHeader })).json().items.map((i: { trackId: string }) => i.trackId);
    expect(await list('?kind=bgm')).toEqual([bgm]);
    expect(await list('?kind=song')).toEqual([song]);
    expect((await list('')).sort()).toEqual([bgm, song].sort());
  }, 90_000);
});

describe('while only staff have it', () => {
  it('refuses a customer before any spend, lets staff make one, and says so in /v1/runtime', async () => {
    const s = await createHarness({ BGM_STUDIO: 'staff' });
    try {
      const customer = await s.createUser({ credits: 2 });
      const staff = await s.createUser({ credits: 2, role: 'support' });
      const ask = (u: TestUser) =>
        s.app.inject({ method: 'POST', url: '/v1/generations', headers: { ...u.authHeader, 'idempotency-key': `st-${randomUUID()}` }, payload: { bgm: vlog } as never });
      expect((await ask(customer)).statusCode).toBe(503);
      expect(await query(`SELECT id FROM generation_jobs WHERE user_id = ?`, [customer.id])).toHaveLength(0);
      expect((await ask(staff)).statusCode).toBe(202);
      const flag = async (u: TestUser) => (await s.app.inject({ method: 'GET', url: '/v1/runtime', headers: u.authHeader })).json().features.bgmStudio;
      expect(await flag(customer)).toBe(false);
      expect(await flag(staff)).toBe(true);
    } finally {
      await s.close();
    }
  }, 60_000);
});
