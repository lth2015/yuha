/**
 * The BGM listening review's sample (docs/quality/BGM_REVIEW.md): staff BGM
 * only, read from the database with what the DGX measured kept apart from what
 * a reviewer sees. A customer's BGM is their own; it is never in the review.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bgmReviewSet, claimOutboxBatch, query, queryOne, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ BGM_STUDIO: 'all' });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const choice = { scenario: 'vlog', genre: 'lofi', mood: 'calm', durationSeconds: 30, tempo: 'slow', note: '' };

async function bgm(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `br-${randomUUID()}` },
    payload: { bgm: choice } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 8; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `br-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}

describe('the BGM review set', () => {
  it('is staff BGM, with the choices for the sheet and the measurements kept apart', async () => {
    const staff = await h.createUser({ credits: 5, role: 'support' });
    const id = await bgm(staff);
    const quality = { engine: 'v15', model: 'm', renderSeconds: 30, peakDbfs: -1, clippedRatio: 0, vocalRatio: 0.1, vocalSeconds: 4 };
    await query(`UPDATE tracks SET bgm = JSON_SET(bgm, '$.quality', CAST(? AS JSON)) WHERE id = ?`, [JSON.stringify(quality), id]);
    const set = await bgmReviewSet();
    expect(set).toEqual([{ trackId: id, choice: { scenario: 'vlog', genre: 'lofi', mood: 'calm', durationSeconds: 30, tempo: 'slow' }, quality }]);
  }, 60_000);

  it('never holds a customer’s BGM, a song, or a deleted BGM; unmeasured quality is null', async () => {
    const customer = await h.createUser({ credits: 5 });
    await bgm(customer);
    const staff = await h.createUser({ credits: 5, role: 'admin' });
    const gone = await bgm(staff);
    await query(`UPDATE tracks SET deleted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [gone]);
    const kept = await bgm(staff);
    const set = await bgmReviewSet();
    expect(set.map((s) => s.trackId)).toEqual([kept]);
    expect(set[0]!.quality).toBeNull();
  }, 90_000);
});
