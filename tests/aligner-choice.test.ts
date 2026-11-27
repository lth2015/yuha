/**
 * Which aligner a song is aligned with (LYRIC_ALIGNER; deploy/dgx/music
 * README, "Qwen3-ForcedAligner"): the DGX takes `method` per request, so
 * YUHA decides per song owner — off, staff only, or everyone — without the
 * DGX's own setting changing for anybody else. Never MMS_FA: its weights are
 * non-commercial, and no request can ask for it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HttpAlignmentProvider } from '@yuha/providers';
import { alignerFor } from '@yuha/api';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

const provider = new HttpAlignmentProvider({
  providerId: 'test-aligner', baseUrl: 'https://aligner.invalid', apiKey: 'test-only', submitPath: '/align',
  linesField: 'lines', lineTextField: 'text', lineStartField: 'start', lineEndField: 'end',
  audioUrlResolver: () => 'https://audio.invalid/test.mp3',
});
const request = { lyrics: '[verse]\n晚风吹过', durationSeconds: 30, providerRequestId: 'p' };

afterEach(() => vi.unstubAllGlobals());

describe('the aligner request', () => {
  it('names the method when one was chosen, and nothing otherwise', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return Response.json({ lines: [{ text: '晚风吹过', start: 1, end: 3 }] });
    });
    await provider.align({ ...request, method: 'qwen' });
    await provider.align(request);
    expect(bodies[0]).toMatchObject({ method: 'qwen' });
    expect(bodies[1]).not.toHaveProperty('method');
  });
});

describe('who gets Qwen', () => {
  let off: Harness, staff: Harness, all: Harness;
  beforeAll(async () => {
    off = await createHarness({ LYRIC_ALIGNER: 'off' });
    staff = await createHarness({ LYRIC_ALIGNER: 'staff' });
    all = await createHarness({ LYRIC_ALIGNER: 'all' });
    await resetData();
  });
  afterAll(async () => {
    for (const h of [off, staff, all]) await h?.close();
    await teardown();
  });

  it('follows LYRIC_ALIGNER: nobody, staff only, or everyone', async () => {
    const customer = await off.createUser({ credits: 0 });
    const support = await off.createUser({ credits: 0, role: 'support' });
    expect(await alignerFor(off.ctx, support.id)).toBeUndefined();
    expect(await alignerFor(staff.ctx, support.id)).toBe('qwen');
    expect(await alignerFor(staff.ctx, customer.id)).toBeUndefined();
    expect(await alignerFor(all.ctx, customer.id)).toBe('qwen');
    expect(await alignerFor(staff.ctx, randomUUID())).toBeUndefined(); // an owner that cannot be looked up is not staff
  });

  it('is off unless configured', () => {
    expect(off.ctx.config.LYRIC_ALIGNER).toBe('off');
  });
});

describe('a delivered song’s automatic sync', () => {
  it('asks the aligner for Qwen when LYRIC_ALIGNER says so, and for nothing when it does not', async () => {
    const { claimOutboxBatch, queryOne, withTx } = await import('@yuha/db');
    const { runJobStep } = await import('@yuha/worker/pipeline');
    const { lyricSyncTick } = await import('@yuha/worker/lyric-sync');
    const asked: Array<{ method?: string }> = [];
    const scripted = {
      kind: 'scripted',
      align: async (req: { method?: string }) => {
        asked.push(req);
        return { status: 'ok' as const, timings: { source: 'aligned' as const, aligner: 'x', lines: [{ text: 'slow down', section: 'Verse', start: 1, end: 3 }] } };
      },
    };
    for (const [mode, expected] of [['all', 'qwen'], ['off', undefined]] as const) {
      const h = await createHarness({ LYRIC_ALIGNER: mode, LYRIC_AUTO_SYNC: 'all' });
      try {
        await resetData();
        (h.ctx as { alignment: unknown }).alignment = scripted;
        asked.length = 0;
        const user = await h.createUser({ credits: 5 });
        const res = await h.app.inject({
          method: 'POST', url: '/v1/generations', headers: { ...user.authHeader, 'idempotency-key': `ac-${randomUUID()}` },
          payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: '[Verse]\nslow down' } as never,
        });
        const jobId = res.json().jobId as string;
        const rows = await withTx((tx) => claimOutboxBatch(50, tx));
        for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
        for (let i = 0; i < 6; i += 1) {
          await runJobStep({ ctx: h.ctx, owner: `ac-${i}`, log: () => undefined }, jobId);
          if (await queryOne(`SELECT id FROM tracks WHERE job_id = ?`, [jobId])) break;
        }
        await lyricSyncTick({ ctx: h.ctx, owner: 'ac', log: () => undefined });
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.at(-1)!.method).toBe(expected);
      } finally {
        await h.close();
      }
    }
  }, 90_000);
});
