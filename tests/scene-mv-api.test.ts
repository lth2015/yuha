/**
 * The scene MV API (docs/AI_SCENE_MV_TICKETS.md, T7), as the page Codex is
 * building reads it (docs/agents/CODEX_SCENE_MV_UI.md).
 *
 * Pinned: the owner's alone; off for everyone but staff until the switch is
 * on, and for everyone when no video service is configured; a storyboard to
 * confirm before anything starts; one in progress per person; the whole way
 * through to a download link on the demo service; cancel and delete.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, queryOne, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { sceneMvTick } from '@yuha/worker/scene-mv';
import { composeNextSceneMv } from '@yuha/worker/scene-mv-compose';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let on: Harness;
let off: Harness;
let none: Harness;
beforeAll(async () => {
  on = await createHarness({ FEATURE_SCENE_MV_ENABLED: 'true', VIDEO_ADAPTER: 'demo' });
  off = await createHarness({ VIDEO_ADAPTER: 'demo' });
  none = await createHarness({ FEATURE_SCENE_MV_ENABLED: 'true', VIDEO_ADAPTER: 'none' });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await on?.close();
  await off?.close();
  await none?.close();
  await teardown();
});

async function song(h: Harness, user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `smva-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 60, lyrics: '[Verse]\nlo-fi hearts\nslow down' } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `a-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}

const call = (h: Harness, who: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  h.app.inject({ method, url, headers: who.authHeader, ...(payload !== undefined ? { payload: payload as never } : {}) });
const draft = (h: Harness, who: TestUser, track: string, body: Record<string, unknown> = {}) =>
  call(h, who, 'POST', `/v1/tracks/${track}/scene-mvs`, { clipStart: 10, clipEnd: 26, style: 'neon_rain', ...body });

/** Ticks the worker on the harness's own video service until the MV settles. */
async function make(h: Harness, id: string, who: TestUser) {
  for (let i = 0; i < 300; i += 1) {
    await sceneMvTick({ video: h.ctx.video!, storage: h.ctx.storage, owner: 'w', log: () => undefined });
    await composeNextSceneMv({ storage: h.ctx.storage, owner: 'w', log: () => undefined });
    const v = (await call(h, who, 'GET', `/v1/scene-mvs/${id}`)).json() as { status: string };
    if (['ready', 'failed', 'cancelled'].includes(v.status)) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('never settled');
}

describe('who can use it', () => {
  it('is offered to everyone when switched on, to staff only when not, and to nobody without a video service', async () => {
    const user = await on.createUser();
    const staff = await off.createUser({ role: 'support' });
    const plain = await off.createUser();
    const runtime = async (h: Harness, who: TestUser) => (await call(h, who, 'GET', '/v1/runtime')).json().features.sceneMv;
    expect(await runtime(on, user)).toBe(true);
    expect(await runtime(off, staff)).toBe(true);
    expect(await runtime(off, plain)).toBe(false);
    expect(await runtime(none, await none.createUser({ role: 'admin' }))).toBe(false);
    // And the routes agree with what the runtime says.
    const track = randomUUID();
    expect((await draft(off, plain, track)).statusCode).toBe(503);
    expect((await draft(none, await none.createUser({ role: 'admin' }), track)).statusCode).toBe(503);
  });

  it('is the owner’s alone', async () => {
    const user = await on.createUser({ credits: 10 });
    const other = await on.createUser({ credits: 10 });
    const track = await song(on, user);
    expect((await draft(on, other, track)).statusCode).toBe(404);
    const id = (await draft(on, user, track)).json().id as string;
    for (const [m, u] of [['GET', ''], ['POST', '/start'], ['POST', '/cancel'], ['GET', '/download'], ['DELETE', '']] as const) {
      expect((await call(on, other, m, `/v1/scene-mvs/${id}${u}`)).statusCode).toBe(404);
    }
    expect((await call(on, other, 'GET', `/v1/tracks/${track}/scene-mvs`)).statusCode).toBe(404);
  }, 60_000);
});

describe('making one', () => {
  it('drafts a storyboard to confirm, takes edits only while it is a draft, and refuses spans it cannot draw', async () => {
    const user = await on.createUser({ credits: 10 });
    const track = await song(on, user);
    const res = await draft(on, user, track, { description: 'a lighthouse on a cliff' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; status: string; shots: { idx: number; prompt: string }[] };
    expect(body.status).toBe('draft');
    expect(body.shots).toHaveLength(4);
    expect(body.shots.every((s) => s.prompt.includes('a lighthouse on a cliff'))).toBe(true);
    const edited = await call(on, user, 'PATCH', `/v1/scene-mvs/${body.id}`, { shots: ['one', 'two', 'three'] });
    expect(edited.statusCode).toBe(200);
    expect((edited.json() as { shots: { prompt: string }[] }).shots.map((s) => s.prompt)).toEqual(['one', 'two', 'three']);
    expect((await draft(on, user, track, { style: 'disco' })).statusCode).toBe(400);
    expect((await draft(on, user, track, { clipStart: 0, clipEnd: 40 })).statusCode).toBe(400); // past 4 × 8 s
    expect((await draft(on, user, track, { clipStart: 50, clipEnd: 70 })).statusCode).toBe(400); // past the song's end
    expect((await call(on, user, 'POST', `/v1/scene-mvs/${body.id}/start`)).statusCode).toBe(202);
    expect((await call(on, user, 'PATCH', `/v1/scene-mvs/${body.id}`, { shots: ['late'] })).statusCode).toBe(409);
  }, 60_000);

  it('goes the whole way to a download, which lasts a week', async () => {
    const user = await on.createUser({ credits: 10 });
    const track = await song(on, user);
    const id = (await draft(on, user, track)).json().id as string;
    expect((await call(on, user, 'POST', `/v1/scene-mvs/${id}/start`)).statusCode).toBe(202);
    const v = (await make(on, id, user)) as { status: string; drawn: number; total: number; expiresAt: string };
    expect([v.status, v.drawn, v.total]).toEqual(['ready', 4, 4]);
    expect(new Date(v.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const dl = await call(on, user, 'GET', `/v1/scene-mvs/${id}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.json().url).toMatch(/^https?:\/\//);
    // It is found again from the song, newest first.
    const list = (await call(on, user, 'GET', `/v1/tracks/${track}/scene-mvs`)).json() as { items: { id: string; status: string }[] };
    expect(list.items.map((i) => [i.id, i.status])).toEqual([[id, 'ready']]);
    // And never shows what was written for it to anyone but its owner — the view carries no description at all.
    expect(JSON.stringify(v)).not.toContain('description');
  }, 120_000);

  it('lets one be in progress at a time, and says which', async () => {
    const user = await on.createUser({ credits: 10 });
    const track = await song(on, user);
    const a = (await draft(on, user, track)).json().id as string;
    const b = (await draft(on, user, track)).json().id as string;
    await call(on, user, 'POST', `/v1/scene-mvs/${a}/start`);
    const busy = await call(on, user, 'POST', `/v1/scene-mvs/${b}/start`);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatchObject({ code: 'CONFLICT', details: { reason: 'busy', activeId: a } });
  }, 60_000);

  it('cancels one in progress but not one finished, and deletes one with its file', async () => {
    const user = await on.createUser({ credits: 10 });
    const track = await song(on, user);
    const a = (await draft(on, user, track)).json().id as string;
    await call(on, user, 'POST', `/v1/scene-mvs/${a}/start`);
    expect((await call(on, user, 'POST', `/v1/scene-mvs/${a}/cancel`)).statusCode).toBe(200);
    expect((await call(on, user, 'GET', `/v1/scene-mvs/${a}`)).json().status).toBe('cancelled');

    const b = (await draft(on, user, track)).json().id as string;
    await call(on, user, 'POST', `/v1/scene-mvs/${b}/start`);
    await make(on, b, user);
    expect((await call(on, user, 'POST', `/v1/scene-mvs/${b}/cancel`)).statusCode).toBe(409);
    const key = (await queryOne<{ output_key: string }>(`SELECT output_key FROM scene_mvs WHERE id = ?`, [b]))!.output_key;
    expect((await call(on, user, 'DELETE', `/v1/scene-mvs/${b}`)).statusCode).toBe(204);
    expect((await call(on, user, 'GET', `/v1/scene-mvs/${b}`)).statusCode).toBe(404);
    await expect(on.ctx.storage.get('delivery', key)).rejects.toThrow();
  }, 120_000);
});
