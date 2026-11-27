/**
 * Composing a scene MV (docs/AI_SCENE_MV_TICKETS.md, T6): the drawn shots
 * cut to the chosen span of the song, the song's own sound and nothing else,
 * the lyrics as subtitles on the timing the owner saved, vertical.
 *
 * Checked on the file itself with ffprobe, not on what the code says it did.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimOutboxBatch, createSceneMvDraft, execute, getSceneMv, query, queryOne, queueSceneMv, withTx } from '@yuha/db';
import { DemoVideoProvider } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { sceneMvTick } from '@yuha/worker/scene-mv';
import { buildAss, composeNextSceneMv } from '@yuha/worker/scene-mv-compose';
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

async function song(user: TestUser, body: Record<string, unknown> = {}): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `smvc-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: '[Verse]\nlo-fi hearts\nslow down', ...body } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `c-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}

/** A queued MV over [start, end] of a song, with its shots drawn: ready to compose. */
async function drawn(user: TestUser, track: string, start: number, end: number, shots = 4): Promise<string> {
  const id = await createSceneMvDraft({ ownerId: user.id, trackId: track, style: 'neon_rain', description: null, clipStart: start, clipEnd: end, timingsSha: null, shots: Array.from({ length: shots }, (_, i) => `shot ${i}`) });
  await queueSceneMv(id, user.id);
  const video = new DemoVideoProvider({ delayMs: 5 });
  for (let i = 0; i < 200; i += 1) {
    if ((await sceneMvTick({ video, storage: h.ctx.storage, owner: 'w', log: () => undefined })) === 'idle' && (await getSceneMv(id))?.status === 'composing') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect((await getSceneMv(id))?.status).toBe('composing');
  return id;
}

const composeDeps = () => ({ storage: h.ctx.storage, owner: 'w', log: () => undefined });

async function probe(bytes: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'yuha-mv-'));
  try {
    await writeFile(join(dir, 'mv.mp4'), bytes);
    const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', join(dir, 'mv.mp4')], { encoding: 'utf8' });
    const j = JSON.parse(out.stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
    return { streams: j.streams.map((s) => s.codec_type).sort(), video: j.streams.find((s) => s.codec_type === 'video'), seconds: Number(j.format.duration) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('composing a scene MV', () => {
  it('cuts the shots to the span, on the song’s own sound, vertical, and lets the shots go', async () => {
    const user = await h.createUser({ credits: 10 });
    const track = await song(user);
    const id = await drawn(user, track, 4, 16);
    // Heard by the aligner, so its lines may be burned in (isTrustedLine).
    await query(`UPDATE tracks SET lyric_timings = JSON_SET(lyric_timings, '$.source', 'aligned') WHERE id = ?`, [track]);
    const shotKeys = (await getSceneMv(id))!.shots.map((s) => s.clip_key!);
    const logged: Record<string, unknown>[] = [];
    expect(await composeNextSceneMv({ ...composeDeps(), log: (_l: string, _m: string, extra?: Record<string, unknown>) => void logged.push(extra ?? {}) })).toBe(id);
    expect(logged.find((e) => 'subtitles' in e)?.subtitles).toBe(true); // the song sings in the span
    const mv = await getSceneMv(id);
    expect(mv?.status).toBe('ready');
    const p = await probe(await h.ctx.storage.get('delivery', mv!.output_key!));
    expect(p.streams).toEqual(['audio', 'video']);
    expect([p.video?.width, p.video?.height]).toEqual([720, 1280]);
    expect(Math.abs(p.seconds - 12)).toBeLessThan(0.3);
    // Kept privately for a week (the proposed default), and the drawn shots are no longer needed.
    const days = (new Date(mv!.expires_at!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    for (const k of shotKeys) await expect(h.ctx.storage.get('delivery', k)).rejects.toThrow();
    expect(await composeNextSceneMv(composeDeps())).toBeNull();
  }, 120_000);

  it('burns no words from an estimate', async () => {
    const user = await h.createUser({ credits: 10 });
    const track = await song(user);
    expect((await queryOne<{ s: string }>(`SELECT JSON_UNQUOTE(JSON_EXTRACT(lyric_timings, '$.source')) AS s FROM tracks WHERE id = ?`, [track]))?.s).toBe('estimated');
    const id = await drawn(user, track, 4, 16);
    const logged: Record<string, unknown>[] = [];
    expect(await composeNextSceneMv({ ...composeDeps(), log: (_l: string, _m: string, extra?: Record<string, unknown>) => void logged.push(extra ?? {}) })).toBe(id);
    expect(logged.find((e) => 'subtitles' in e)?.subtitles).toBe(false);
    expect((await getSceneMv(id))?.status).toBe('ready');
  }, 120_000);

  it('fails the MV, and frees the owner’s slot, when it cannot be composed', async () => {
    const user = await h.createUser({ credits: 10 });
    const track = await song(user);
    const id = await drawn(user, track, 0, 8, 2);
    await h.ctx.storage.remove('delivery', (await getSceneMv(id))!.shots[0]!.clip_key!);
    expect(await composeNextSceneMv(composeDeps())).toBe(id);
    const mv = await getSceneMv(id);
    expect([mv?.status, mv?.failure, mv?.output_key]).toEqual(['failed', 'compose_failed', null]);
    expect(await queueSceneMv(await createSceneMvDraft({ ownerId: user.id, trackId: track, style: 's', description: null, clipStart: 0, clipEnd: 8, timingsSha: null, shots: ['a'] }), user.id)).toEqual({ ok: true });
  }, 120_000);

  it('does not compose an MV whose song was deleted meanwhile', async () => {
    const user = await h.createUser({ credits: 10 });
    const track = await song(user);
    const id = await drawn(user, track, 0, 8, 2);
    await execute(`UPDATE tracks SET deleted_at = UTC_TIMESTAMP(3), state = 'deleted' WHERE id = ?`, [track]);
    await composeNextSceneMv(composeDeps());
    expect((await getSceneMv(id))?.status).toBe('failed');
  }, 120_000);
});

describe('subtitles', () => {
  const lines = [
    { text: 'before', section: 'Verse', start: 0, end: 3 },
    { text: 'across the start', section: 'Verse', start: 8, end: 11 },
    { text: '晚风{吹过}\\街角', section: 'Chorus', start: 12, end: 15 },
    { text: 'after', section: 'Outro', start: 40, end: 43 },
  ];

  it('carries the lines sung in the span, on the span’s clock, cut at its edges', () => {
    const ass = buildAss(lines, 10, 30);
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(events).toHaveLength(2);
    expect(events[0]).toContain('0:00:00.00,0:00:01.00'); // 8–11 seen from 10
    expect(events[1]).toContain('0:00:02.00,0:00:05.00');
    expect(ass).not.toContain('before');
    expect(ass).not.toContain('after');
  });

  it('cannot be steered by what is in a line', () => {
    const ass = buildAss(lines, 10, 30);
    // Braces start an override block and a backslash a command in ASS: a lyric must not be able to write either.
    const text = ass.split('\n').find((l) => l.includes('晚风'))!.split(',').slice(9).join(',');
    expect(text).not.toMatch(/[{}]/);
    expect(text).not.toContain('\\');
  });

  it('is in a font that has the characters', () => {
    expect(buildAss(lines, 10, 30)).toMatch(/Style: Default,Noto Sans CJK SC,/);
  });
});
