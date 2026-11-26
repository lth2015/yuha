/**
 * The scene MV in the console's quality report (packages/db/src/quality.ts),
 * for watching the internal test: how many were started, finished, failed and
 * why, cancelled, and how long a finished one took. Drafts nobody started are
 * not counted: nothing was asked of the machine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  advanceSceneMv,
  cancelSceneMv,
  claimOutboxBatch,
  createSceneMvDraft,
  execute,
  qualityReport,
  queryOne,
  queueSceneMv,
  withTx,
} from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

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

async function songFor(userId: string, authHeader: Record<string, string>): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...authHeader, 'idempotency-key': `smvs-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: '[Verse]\nlo-fi hearts' } as never,
  });
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

/** One MV for a fresh person (one active each), started unless `draftOnly`. */
async function mv(end: 'ready' | 'failed' | 'cancelled' | 'running' | 'draft', failure = 'shot_failed') {
  const user = await h.createUser({ credits: 10 });
  const track = await songFor(user.id, user.authHeader);
  const id = await createSceneMvDraft({ ownerId: user.id, trackId: track, style: 'neon_rain', description: null, clipStart: 0, clipEnd: 8, timingsSha: null, shots: ['a', 'b'] });
  if (end === 'draft') return id;
  await queueSceneMv(id, user.id);
  if (end === 'cancelled') {
    await cancelSceneMv(id, user.id);
    return id;
  }
  await advanceSceneMv(id, 'queued', 'generating');
  if (end === 'running') return id;
  if (end === 'failed') {
    await advanceSceneMv(id, 'generating', 'failed', { failure });
    return id;
  }
  await advanceSceneMv(id, 'generating', 'composing');
  await advanceSceneMv(id, 'composing', 'ready', { outputKey: 'k' });
  // Finished twelve minutes after it was started.
  await execute(`UPDATE scene_mvs SET queued_at = finished_at - INTERVAL 12 MINUTE WHERE id = ?`, [id]);
  return id;
}

describe('scene MVs in the quality report', () => {
  it('counts what was started, how it ended, why it failed, and how long a finished one took', async () => {
    await mv('ready');
    await mv('ready');
    await mv('failed', 'shot_failed');
    await mv('failed', 'compose_failed');
    await mv('cancelled');
    await mv('running');
    await mv('draft');
    const r = await qualityReport({ hours: 24 });
    expect(r.sceneMvs).toEqual({
      started: 6,
      ready: 2,
      failed: 2,
      cancelled: 1,
      inProgress: 1,
      failures: [
        { reason: 'compose_failed', n: 1 },
        { reason: 'shot_failed', n: 1 },
      ],
      medianMinutesToReady: 12,
    });
  }, 120_000);

  it('says nothing when nothing was started', async () => {
    await mv('draft');
    const r = await qualityReport({ hours: 24 });
    expect(r.sceneMvs).toEqual({ started: 0, ready: 0, failed: 0, cancelled: 0, inProgress: 0, failures: [], medianMinutesToReady: null });
  }, 60_000);
});
