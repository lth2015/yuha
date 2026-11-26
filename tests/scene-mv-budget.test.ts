/**
 * The AI scene MV's money (docs/AI_SCENE_MV_VEO_SPEC.md §3; migration 0038).
 *
 * A paid video service bills by the second. Pinned here, at the API and the
 * worker together: a start reserves what its shots may cost against a total
 * and a daily cap, atomically, so two people racing for the last of the budget
 * cannot both get it; each person and the site start at most so many a day;
 * nothing starts when no budget is configured; what is known not to cost
 * anything is given back, and what may have is not; and the record of what was
 * spent outlives the MV.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, queryOne, sceneMvSpendMicros, withTx } from '@yuha/db';
import { DemoVideoProvider, type VideoProvider } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { sceneMvTick } from '@yuha/worker/scene-mv';
import { sceneMvBudget } from '@yuha/api';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

/** A demo that bills like Veo Lite: $0.03 a second, 4/6/8-second clips. */
class PaidDemo extends DemoVideoProvider {
  override readonly kind = 'paid-demo';
  readonly durations = [4, 6, 8] as const;
  readonly pricePerSecondUsd = 0.03;
}

let h: Harness;
let unfunded: Harness;
beforeAll(async () => {
  h = await createHarness({
    FEATURE_SCENE_MV_ENABLED: 'true',
    VIDEO_ADAPTER: 'demo',
    SCENE_MV_BUDGET_USD_TOTAL: '1.00',
    SCENE_MV_BUDGET_USD_DAILY: '1.00',
    SCENE_MV_PER_USER_DAILY: '2',
    SCENE_MV_SITE_DAILY: '10',
  });
  unfunded = await createHarness({ FEATURE_SCENE_MV_ENABLED: 'true', VIDEO_ADAPTER: 'demo' });
});
let video: PaidDemo;
beforeEach(async () => {
  await resetData();
  video = new PaidDemo({ delayMs: 5 });
  (h.ctx as { video: VideoProvider }).video = video;
  (unfunded.ctx as { video: VideoProvider }).video = new PaidDemo({ delayMs: 5 });
});
afterAll(async () => {
  await h?.close();
  await unfunded?.close();
  await teardown();
});

async function song(hh: Harness, user: TestUser): Promise<string> {
  const res = await hh.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `smvb-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 60, lyrics: '[Verse]\nlo-fi hearts' } as never,
  });
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await hh.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: hh.ctx, owner: `b-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}

const call = (hh: Harness, who: TestUser, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  hh.app.inject({ method, url, headers: who.authHeader, ...(payload !== undefined ? { payload: payload as never } : {}) });

/** A two-shot draft over 16 s: two 8-second clips, $0.48 at $0.03/s. */
async function twoShotDraft(hh: Harness, who: TestUser): Promise<string> {
  const track = await song(hh, who);
  const d = await call(hh, who, 'POST', `/v1/tracks/${track}/scene-mvs`, { clipStart: 0, clipEnd: 16, style: 'neon_rain' });
  const id = d.json().id as string;
  await call(hh, who, 'PATCH', `/v1/scene-mvs/${id}`, { shots: ['one', 'two'] });
  return id;
}
const start = (hh: Harness, who: TestUser, id: string) => call(hh, who, 'POST', `/v1/scene-mvs/${id}/start`);
const tick = (provider: VideoProvider, owner = 'w') =>
  sceneMvTick({ video: provider, storage: h.ctx.storage, owner, log: () => undefined, retryAfterSeconds: 0, budget: sceneMvBudget(h.ctx) });

describe('the scene MV budget', () => {
  it('reserves what a start may cost, and refuses the start that would go past the cap', async () => {
    const [a, b, c] = [await h.createUser({ credits: 10 }), await h.createUser({ credits: 10 }), await h.createUser({ credits: 10 })];
    expect((await start(h, a, await twoShotDraft(h, a))).statusCode).toBe(202);
    expect(await sceneMvSpendMicros()).toBe(480_000);
    expect((await start(h, b, await twoShotDraft(h, b))).statusCode).toBe(202);
    const refused = await start(h, c, await twoShotDraft(h, c));
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.details).toEqual({ reason: 'budget' });
    expect(await sceneMvSpendMicros()).toBe(960_000); // nothing reserved for the refused one
  }, 120_000);

  it('lets only one of two people racing for the last of the budget start', async () => {
    const pad = await h.createUser({ credits: 10 });
    await start(h, pad, await twoShotDraft(h, pad)); // $0.48 of $1.00 used
    const [a, b] = [await h.createUser({ credits: 10 }), await h.createUser({ credits: 10 })];
    const [da, db] = [await twoShotDraft(h, a), await twoShotDraft(h, b)];
    const codes = (await Promise.all([start(h, a, da), start(h, b, db)])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([202, 429]);
    expect(await sceneMvSpendMicros()).toBe(960_000);
  }, 120_000);

  it('lets one person start two a day', async () => {
    const user = await h.createUser({ credits: 10 });
    for (let i = 0; i < 2; i += 1) {
      const id = await twoShotDraft(h, user);
      expect((await start(h, user, id)).statusCode).toBe(202);
      await call(h, user, 'POST', `/v1/scene-mvs/${id}/cancel`); // one active at a time
    }
    const third = await start(h, user, await twoShotDraft(h, user));
    expect([third.statusCode, third.json().error.details.reason]).toEqual([429, 'user_daily_limit']);
  }, 120_000);

  it('starts nothing on a paid service with no budget configured', async () => {
    const user = await unfunded.createUser({ credits: 10 });
    const r = await start(unfunded, user, await twoShotDraft(unfunded, user));
    expect([r.statusCode, r.json().error.details.reason]).toEqual([429, 'budget']);
  }, 120_000);

  it('gives back what was never sent, and what failed at the service, but not what may have been drawn', async () => {
    const user = await h.createUser({ credits: 10 });
    const id = await twoShotDraft(h, user);
    await start(h, user, id);
    // Cancelled before anything was sent: all of it comes back.
    await call(h, user, 'POST', `/v1/scene-mvs/${id}/cancel`);
    expect(await sceneMvSpendMicros()).toBe(0);

    const other = await h.createUser({ credits: 10 });
    const id2 = await twoShotDraft(h, other);
    await start(h, other, id2);
    // The first clip fails at the service (refunded there), and its retry is drawn.
    video.failNext = { count: 1, reason: 'out_of_memory' };
    for (let i = 0; i < 300; i += 1) {
      await tick(video);
      if ((await queryOne<{ status: string }>(`SELECT status FROM scene_mvs WHERE id = ?`, [id2]))!.status === 'composing') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // Two clips drawn, one failure refunded: what stays is two clips' worth.
    expect(await sceneMvSpendMicros({ sceneMvId: id2 })).toBe(480_000);
  }, 120_000);

  it('keeps the charge for a submit nobody can vouch for, and fails the MV rather than spend past the cap on a retry', async () => {
    const user = await h.createUser({ credits: 10 });
    const id = await twoShotDraft(h, user);
    await start(h, user, id);
    const unsure: VideoProvider = {
      kind: 'paid-demo',
      durations: [4, 6, 8],
      pricePerSecondUsd: 0.03,
      submit: async () => ({ status: 'rejected', reason: 'uncertain', retryable: false }),
      status: async () => ({ status: 'unknown', reason: 'not_found' }),
      fetchClip: async () => Buffer.alloc(0),
      discard: async () => undefined,
      health: async () => ({ ok: true, queued: 0 }),
    };
    await tick(unsure);
    // It may be running, and billed: its share stays; the other shot, never sent, comes back.
    expect(await sceneMvSpendMicros({ sceneMvId: id })).toBe(240_000);
    expect((await queryOne<{ status: string }>(`SELECT status FROM scene_mvs WHERE id = ?`, [id]))!.status).toBe('failed');
  }, 120_000);

  it('keeps the record of what was spent after the MV is deleted', async () => {
    const user = await h.createUser({ credits: 10 });
    const id = await twoShotDraft(h, user);
    await start(h, user, id);
    for (let i = 0; i < 300; i += 1) {
      await tick(video);
      if ((await queryOne<{ status: string }>(`SELECT status FROM scene_mvs WHERE id = ?`, [id]))!.status === 'composing') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await call(h, user, 'DELETE', `/v1/scene-mvs/${id}`)).statusCode).toBe(204);
    expect(await sceneMvSpendMicros()).toBe(480_000);
  }, 120_000);
});
