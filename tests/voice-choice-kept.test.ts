/**
 * The voice chosen in /create reaches the song.
 *
 * The request carried `voice` and the worker read `input.voice`, but the job
 * row was written without it, so every song was made with `auto` whatever the
 * creator picked. `auto-length-and-voice.test.ts` covers the brief built from
 * a voice; this covers the step before it, from the request to the job.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, queryOne, withTx } from '@yuha/db';
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

const asJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;

describe('the voice the creator picked', () => {
  it('is kept on the job and used for the song', async () => {
    const user = await h.createUser({ credits: 2 });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: { ...user.authHeader, 'idempotency-key': `voice-${randomUUID()}` },
      payload: { mode: 'simple', prompt: '雨の日の駅', instrumental: false, durationSeconds: 30, voice: 'male' } as never,
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().jobId as string;

    const job = await queryOne<{ input: unknown }>(`SELECT input FROM generation_jobs WHERE id = ?`, [jobId]);
    expect(asJson(job!.input)['voice']).toBe('male');

    const rows = await withTx((tx) => claimOutboxBatch(50, tx));
    for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
    await runJobStep({ ctx: h.ctx, owner: 'voice-1', log: () => undefined }, jobId);
    const resolved = await queryOne<{ resolved_params: unknown }>(`SELECT resolved_params FROM generation_jobs WHERE id = ?`, [jobId]);
    expect(asJson(resolved!.resolved_params)['voice']).toBe('male');
  });
});
