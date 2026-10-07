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
import {
  balanceOf,
  createHarness,
  resetData,
  teardown,
  type Harness,
  type TestUser,
} from './helpers/harness.js';
import { runJobStep } from '@yuha/worker/pipeline';

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

  /**
   * The quote service reads only `ctx.config`, so this is a context with the
   * stablecoin switches on rather than a second server — one server per file
   * is enough, and the wallet-verification route is not what is under test.
   */
  const stablecoinCtx = () =>
    ({
      ...h.ctx,
      config: {
        ...h.ctx.config,
        STABLECOIN_ENABLED: true,
        STABLECOIN_JPYC_ENABLED: true,
        STABLECOIN_RECEIVER_ADDRESS: '0x9999999999999999999999999999999999999999',
      },
    }) as typeof h.ctx;

  it('a licence bought in stablecoin carries the author, so delivery does not throw', async () => {
    /*
     * The stablecoin quote wrote `track_id` and not `creator_id`, and
     * `grantEntitlementForOrder` throws without both. A licence bought in
     * JPYC took the money, confirmed the intent, marked the order paid, and
     * threw on delivery — and the recovery sweep re-ran the same code and
     * threw again, forever. Found by an adversarial review with a working
     * proof while the whole suite was green.
     */
    const creator = await h.createUser({ credits: 2 });
    const buyer = await h.createUser({ credits: 0, email: 'sc-licence-buyer@example.jp' });
    const { trackId } = await deliverSong(creator, 'market-song-sc', true);

    const wallet = '0x2222222222222222222222222222222222222222';
    await query(`INSERT INTO verified_wallets (user_id, chain_id, address) VALUES (?, 137, ?)`, [buyer.id, wallet]);

    const { createStablecoinQuote } = await import('../apps/api/src/services/stablecoin.js');
    const quote = await createStablecoinQuote(stablecoinCtx(), {
      userId: buyer.id,
      priceKey: 'market_license',
      idempotencyKey: 'sc-licence-0001',
      tokenKey: 'jpyc',
      payer: wallet,
      trackId,
    });

    const order = await query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM orders WHERE id = ?`, [
      quote.orderId,
    ]);
    expect(order[0]!.metadata['track_id']).toBe(trackId);
    expect(order[0]!.metadata['creator_id']).toBe(creator.id);

    // And delivery actually works, which is the thing that did not.
    const { grantEntitlementForOrder } = await import('../apps/api/src/services/fulfilment.js');
    const { getOrder } = await import('@yuha/db');
    await withTx(async (tx) => {
      const row = (await getOrder(quote.orderId, tx))!;
      await grantEntitlementForOrder(row, tx);
    });
    const licences = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM track_licenses WHERE order_id = ?`, [
      quote.orderId,
    ]);
    expect(Number(licences[0]!.n)).toBe(1);
  });

  it('refuses a stablecoin licence for your own song, like the card path', async () => {
    const creator = await h.createUser({ credits: 2, email: 'sc-own-song@example.jp' });
    const { trackId } = await deliverSong(creator, 'market-song-own', true);
    await query(`INSERT INTO verified_wallets (user_id, chain_id, address) VALUES (?, 137, ?)`, [
      creator.id,
      '0x3333333333333333333333333333333333333333',
    ]);
    const { createStablecoinQuote } = await import('../apps/api/src/services/stablecoin.js');
    await expect(
      createStablecoinQuote(stablecoinCtx(), {
        userId: creator.id,
        priceKey: 'market_license',
        idempotencyKey: 'sc-own-0001',
        tokenKey: 'jpyc',
        payer: '0x3333333333333333333333333333333333333333',
        trackId,
      }),
    ).rejects.toThrow(/your own song/);
  });


  it('the recovery sweep gives a licence order its licence, not a credit', async () => {
    /*
     * `recoverUngrantedOrders` granted credits inline, filtered on
     * `product.kind !== 'one_time'` — and `market_license` IS kind
     * 'one_time'. So a licence order that reached the sweep was handed one
     * generation credit instead of the licence it paid for, and then marked
     * granted, so the licence never arrived at all. The sweep now runs the
     * same `grantEntitlementForOrder` both payment channels run.
     */
    const creator = await h.createUser({ credits: 2 });
    const buyer = await h.createUser({ credits: 0 });
    const { trackId } = await deliverSong(creator, 'market-song-sweep', true);

    const checkout = await h.app.inject({
      method: 'POST',
      url: `/v1/market/tracks/${trackId}/license`,
      headers: { ...buyer.authHeader, 'idempotency-key': 'market-key-sweep-1' },
    });
    expect(checkout.statusCode).toBe(202);
    const { orderId } = checkout.json();

    // The state a crash between payment and delivery leaves behind.
    await query(
      `UPDATE orders SET status = 'paid', paid_at = UTC_TIMESTAMP(3), entitlement_granted_at = NULL WHERE id = ?`,
      [orderId],
    );

    const { recoverUngrantedOrders } = await import('@yuha/api');
    await recoverUngrantedOrders(h.ctx);

    const licences = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM track_licenses WHERE order_id = ?`, [
      orderId,
    ]);
    expect(Number(licences[0]!.n)).toBe(1);
    // And no credits: a licence is not a generation pack.
    expect((await balanceOf(buyer.id)).available).toBe(0);
  });

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
    expect(license[0]!.price_paid).toBe(980);

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

  /** Buys a licence for `trackId` and returns the buyer's export id. */
  async function licenceAndExport(buyer: TestUser, trackId: string, key: string): Promise<string> {
    const checkout = await h.app.inject({
      method: 'POST',
      url: `/v1/market/tracks/${trackId}/license`,
      headers: { ...buyer.authHeader, 'idempotency-key': key },
    });
    expect(checkout.statusCode).toBe(202);
    await payOrder(checkout.json().checkoutUrl, buyer);
    const exported = await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/exports`,
      headers: buyer.authHeader,
      payload: { clipStartSeconds: 0, clipDurationSeconds: 60, fadeOut: false } as never,
    });
    expect(exported.statusCode).toBe(200);
    return exported.json().exportId as string;
  }

  /*
   * The buyer's route to their audio went through `getPublicTrack`, which
   * requires `visibility = 'public'`. So the seller could destroy a paid
   * licence with one call to the visibility endpoint — the one documented as
   * "unpublishing revokes the shared link immediately", which is true of the
   * link and must not be true of a purchase.
   */
  it('a paid licence survives the seller unpublishing the song', async () => {
    const creator = await h.createUser({ credits: 2 });
    const buyer = await h.createUser();
    const { trackId } = await deliverSong(creator, 'market-unpublish', true);
    const exportId = await licenceAndExport(buyer, trackId, 'market-key-0010');

    const unpublished = await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/visibility`,
      headers: creator.authHeader,
      payload: { visibility: 'private' } as never,
    });
    expect(unpublished.statusCode).toBe(200);

    // Still exportable, and the earlier download link still re-issues.
    const again = await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/exports`,
      headers: buyer.authHeader,
      payload: { clipStartSeconds: 0, clipDurationSeconds: 30, fadeOut: false } as never,
    });
    expect(again.statusCode, 'unpublishing revoked a paid licence').toBe(200);
    const reissued = await h.app.inject({
      method: 'POST',
      url: `/v1/exports/${exportId}/download-url`,
      headers: buyer.authHeader,
    });
    expect(reissued.statusCode).toBe(200);
  });

  /*
   * The retention sweep and account erasure both hold a licensed song's audio
   * back on purpose — `listExpiredTrackAssets` excludes it,
   * `executeAccountDeletion` reports `licensed_by_others` — so the bytes are
   * there. Nothing could reach them.
   */
  it('a paid licence survives the seller deleting the song', async () => {
    const creator = await h.createUser({ credits: 2 });
    const buyer = await h.createUser();
    const { trackId } = await deliverSong(creator, 'market-deleted', true);
    await licenceAndExport(buyer, trackId, 'market-key-0011');

    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/v1/tracks/${trackId}`,
      headers: creator.authHeader,
    });
    expect([200, 204]).toContain(removed.statusCode);

    const again = await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/exports`,
      headers: buyer.authHeader,
      payload: { clipStartSeconds: 0, clipDurationSeconds: 30, fadeOut: false } as never,
    });
    expect(again.statusCode, 'deleting revoked a paid licence').toBe(200);
  });

  /*
   * `DOWNLOAD_URL_TTL_SECONDS` is minutes, so re-issuing is the normal case,
   * not an edge one. `issueDownloadUrl` resolved the track with
   * `getTrackForUser`, which matches on `owner_id` — always undefined for a
   * buyer — and then reported a rights review that did not exist.
   */
  it("re-issues a buyer's download link, and does not blame a rights review", async () => {
    const creator = await h.createUser({ credits: 2 });
    const buyer = await h.createUser();
    const { trackId } = await deliverSong(creator, 'market-reissue', true);
    const exportId = await licenceAndExport(buyer, trackId, 'market-key-0012');

    const again = await h.app.inject({
      method: 'POST',
      url: `/v1/exports/${exportId}/download-url`,
      headers: buyer.authHeader,
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().url).toMatch(/^https?:\/\//);
  });

  /*
   * The stored object's key is built from the user id, so two buyers asking
   * for the same clip must not share one asset row: `createExport` answered
   * the second buyer with the first buyer's `exportId`, whose `owner_id` then
   * failed `getAssetForUser` and left the paid download unreachable.
   */
  it('gives each buyer their own export row for the same clip', async () => {
    const creator = await h.createUser({ credits: 2 });
    const first = await h.createUser();
    const second = await h.createUser();
    const { trackId } = await deliverSong(creator, 'market-shared-clip', true);

    const a = await licenceAndExport(first, trackId, 'market-key-0013');
    const b = await licenceAndExport(second, trackId, 'market-key-0014');
    expect(b).not.toBe(a);

    for (const [buyer, id] of [
      [first, a],
      [second, b],
    ] as const) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/exports/${id}/download-url`,
        headers: buyer.authHeader,
      });
      expect(res.statusCode, res.body).toBe(200);
    }
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
