/**
 * Market licensing: license purchases, the authorship record, buyer download
 * rights — plus the lyric-alignment provenance the synced display relies on.
 *
 * The purchase path drives the real webhook pipeline (simulated payments in
 * the harness), so these cover money movement, not optimistic UI state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processWebhookEvent } from '../apps/api/src/services/webhooks.js';
import { claimWebhookEvents, query, withTx } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';
import { runJobStep } from '@yuha/worker/pipeline';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h.close();
  await teardown();
});

const log = () => undefined;

/** Delivers one song through the real pipeline; returns the track row. */
async function deliverSong(user: TestUser, key: string, publish: boolean): Promise<{ trackId: string; jobId: string }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': key },
    payload: {
      mode: 'custom',
      title: `Market Song ${key}`,
      prompt: '',
      lyrics: '[Verse]\nNeon reflections on the wet street\nI follow the sound of the night\n[Chorus]\nWe glow, we glow',
      styles: ['synthwave'],
      instrumental: false,
      energy: 0.5,
      durationSeconds: 60,
      visibility: publish ? 'public' : 'private',
    } as never,
  });
  expect(res.statusCode).toBe(202);
  const { jobId } = res.json();
  for (let i = 0; i < 6; i += 1) {
    const job = await query<{ state: string; track_id: string | null }>(
      `SELECT state, track_id FROM generation_jobs WHERE id = ?`,
      [jobId],
    );
    if (['DELIVERED', 'FAILED', 'REJECTED'].includes(job[0]!.state)) {
      expect(job[0]!.state).toBe('DELIVERED');
      return { trackId: job[0]!.track_id!, jobId };
    }
    await runJobStep({ ctx: h.ctx, owner: `test-${i}`, log }, jobId);
  }
  throw new Error('song did not deliver');
}

/** Drives a checkout session through the signed webhook pipeline, as the worker does. */
async function payOrder(checkoutUrl: string, payer: TestUser): Promise<void> {
  const sessionId = new URL(checkoutUrl).searchParams.get('session_id')!;
  const settleRes = await h.app.inject({
    method: 'POST',
    url: '/v1/dev/simulate-payment',
    headers: payer.authHeader,
    payload: { sessionId, outcome: 'paid' } as never,
  });
  expect([200, 201, 202]).toContain(settleRes.statusCode);
  const events = await withTx(async (tx) => claimWebhookEvents(10, tx));
  for (const ev of events) await processWebhookEvent(h.ctx, ev);
}

describe('lyric alignment provenance', () => {
  it('stores line timings labelled "estimated" when no real aligner is configured', async () => {
    const creator = await h.createUser({ credits: 2 });
    const { trackId } = await deliverSong(creator, 'align-est-1', false);

    const timings = await query<{ lyric_timings: { source: string; aligner: string; lines: unknown[] } }>(
      `SELECT lyric_timings FROM tracks WHERE id = ?`,
      [trackId],
    );
    const parsed = timings[0]!.lyric_timings;
    // The honesty contract: without a vocal-sync model the label says estimated.
    expect(parsed.source).toBe('estimated');
    expect(parsed.aligner).toBe('estimated-v1');
    expect(parsed.lines.length).toBeGreaterThan(0);
  });

  it('instrumental songs store no timings at all', async () => {
    const creator = await h.createUser({ credits: 2 });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: { ...creator.authHeader, 'idempotency-key': 'align-inst-1' },
      payload: {
        mode: 'simple',
        prompt: 'quiet piano for reading',
        styles: ['ambient'],
        instrumental: true,
        durationSeconds: 30,
      } as never,
    });
    const { jobId } = res.json();
    for (let i = 0; i < 6; i += 1) {
      const job = await query<{ state: string }>(`SELECT state FROM generation_jobs WHERE id = ?`, [jobId]);
      if (['DELIVERED', 'FAILED', 'REJECTED'].includes(job[0]!.state)) break;
      await runJobStep({ ctx: h.ctx, owner: `t-${i}`, log }, jobId);
    }
    const timings = await query<{ lyric_timings: unknown }>(
      `SELECT lyric_timings FROM tracks WHERE job_id = ?`,
      [jobId],
    );
    expect(timings[0]!.lyric_timings).toBeNull();
  });
});

describe('market licensing', () => {
  it('a paid license grants the buyer download rights and records the author', async () => {
    const creator = await h.createUser({ credits: 2 });
    const buyer = await h.createUser({ credits: 0 });
    const { trackId } = await deliverSong(creator, 'market-song-1', true);

    // The buyer cannot export before licensing.
    const denied = await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/exports`,
      headers: buyer.authHeader,
      payload: { clipStartSeconds: 0, clipDurationSeconds: 60, fadeOut: false } as never,
    });
    expect(denied.statusCode).toBe(404);

    // License checkout → simulated payment → webhook grant.
    const checkout = await h.app.inject({
      method: 'POST',
      url: `/v1/market/tracks/${trackId}/license`,
      headers: { ...buyer.authHeader, 'idempotency-key': 'market-key-0001' },
    });
    expect(checkout.statusCode).toBe(202);
    const { orderId, checkoutUrl } = checkout.json();
    await payOrder(checkoutUrl, buyer);

    // The license row exists exactly once, with the frozen share rate.
    const license = await query<{ buyer_id: string; creator_id: string; price_paid: number }>(
      `SELECT buyer_id, creator_id, price_paid FROM track_licenses WHERE track_id = ?`,
      [trackId],
    );
    expect(license).toHaveLength(1);
    expect(license[0]!.buyer_id).toBe(buyer.id);
    // The authorship record is the part that must survive: who made it, who
    // bought it, and what was paid. This is what a later on-chain proof reads.
    expect(license[0]!.creator_id).toBe(creator.id);
    expect(license[0]!.price_paid).toBe(499);

    // The buyer can now export the song.
    const exportRes = await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/exports`,
      headers: buyer.authHeader,
      payload: { clipStartSeconds: 0, clipDurationSeconds: 60, fadeOut: false } as never,
    });
    expect(exportRes.statusCode).toBe(200);

    void orderId;
  });

  it('a replayed payment event grants nothing further', async () => {
    const creator = await h.createUser({ credits: 2 });
    const buyer = await h.createUser();
    const { trackId } = await deliverSong(creator, 'market-song-2', true);

    const checkout = await h.app.inject({
      method: 'POST',
      url: `/v1/market/tracks/${trackId}/license`,
      headers: { ...buyer.authHeader, 'idempotency-key': 'market-key-0002' },
    });
    const { checkoutUrl } = checkout.json();
    await payOrder(checkoutUrl, buyer);

    const before = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM track_licenses`);
    // Re-deliver every webhook event (the replay scenario).
    const events = await withTx(async (tx) => claimWebhookEvents(10, tx));
    for (const ev of events) await processWebhookEvent(h.ctx, ev);
    const after = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM track_licenses`);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  });

  it('creators cannot license their own song; private songs are not licensable', async () => {
    const creator = await h.createUser({ credits: 2 });
    const other = await h.createUser();
    const pub = await deliverSong(creator, 'market-song-3', true);
    const priv = await deliverSong(creator, 'market-song-4', false);

    const own = await h.app.inject({
      method: 'POST',
      url: `/v1/market/tracks/${pub.trackId}/license`,
      headers: { ...creator.authHeader, 'idempotency-key': 'market-key-0003' },
    });
    expect(own.statusCode).toBe(409);

    const privRes = await h.app.inject({
      method: 'POST',
      url: `/v1/market/tracks/${priv.trackId}/license`,
      headers: { ...other.authHeader, 'idempotency-key': 'market-key-0004' },
    });
    expect(privRes.statusCode).toBe(404);
  });

});
