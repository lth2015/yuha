/**
 * The official BGM licence, before anything is sold (docs/PAYMENTS_DESIGN.md
 * §1, "The official BGM licence"): a product that exists but cannot be bought
 * through the generic routes, can never turn into generation credits, a sales
 * switch separate from the listening one, and a sale-rights decision made per
 * track that publishing never makes for you.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getBalance, query, withTx, type OrderRow } from '@yuha/db';
import { grantEntitlementForOrder } from '../apps/api/src/services/fulfilment.js';
import { importOfficialBgm } from '../apps/api/src/services/official-bgm-import.js';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

let h: Harness;
let closed: Harness;
beforeAll(async () => {
  h = await createHarness({ OFFICIAL_BGM_MARKETPLACE: 'all', OFFICIAL_BGM_MARKETPLACE_SALES: 'staff', ADMIN_MFA_REQUIRED: 'false' });
  closed = await createHarness({ OFFICIAL_BGM_MARKETPLACE: 'all' });
});
beforeEach(async () => await resetData());
afterAll(async () => {
  await Promise.all([h?.close(), closed?.close()]);
  await teardown();
});

const tone = (hz: number) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i',
  `sine=frequency=${hz}:sample_rate=44100`, '-t', '62', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 8_000_000 });

describe('the official BGM licence product', () => {
  it('cannot be bought through the generic checkout, which carries no track', async () => {
    const buyer = await h.createUser({ credits: 0 });
    const res = await h.app.inject({ method: 'POST', url: '/v1/checkout', headers: buyer.authHeader,
      payload: { priceKey: 'official_bgm_license', idempotencyKey: `idem_${Date.now()}_official` } as never });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/BGM library/);
    expect(await query(`SELECT id FROM orders WHERE user_id = ?`, [buyer.id])).toEqual([]);
  });

  it('is never fulfilled as generation credits', async () => {
    const buyer = await h.createUser({ credits: 0 });
    const order = { id: randomUUID(), user_id: buyer.id, price_key: 'official_bgm_license', price_version: 1, metadata: {} } as unknown as OrderRow;
    await expect(withTx((tx) => grantEntitlementForOrder(order, tx))).rejects.toThrow(/no fulfilment/);
    expect((await getBalance(buyer.id)).available).toBe(0);
  });
});

describe('who may buy', () => {
  it('is its own switch, off by default and separate from who may listen', async () => {
    const support = await h.createUser({ role: 'support' });
    const runtime = async (hh: Harness, headers: Record<string, string> = {}) =>
      (await hh.app.inject({ url: '/v1/runtime', headers })).json().features;
    expect(await runtime(closed)).toMatchObject({ officialBgmMarketplace: true, officialBgmSales: false });
    expect(await runtime(h)).toMatchObject({ officialBgmMarketplace: true, officialBgmSales: false });
    expect(await runtime(h, support.authHeader)).toMatchObject({ officialBgmSales: true });
  });
});

describe('sale rights', () => {
  it('are decided per track with a basis, by an admin, and never by publishing', async () => {
    const admin = await h.createUser({ role: 'admin' });
    const support = await h.createUser({ role: 'support' });
    const a = await importOfficialBgm(h.ctx, { sourceKey: 'sale-01', title: 'Harbour', genre: 'jazz', scenario: 'travel', mood: 'warm' }, tone(330));
    const b = await importOfficialBgm(h.ctx, { sourceKey: 'sale-02', title: 'Lanterns', genre: 'ambient', scenario: 'vlog', mood: 'calm' }, tone(550));
    const base = '/v1/admin/marketplace/bgm';
    const decide = (id: string, body: unknown, headers = admin.authHeader) =>
      h.app.inject({ method: 'POST', url: `${base}/${id}/sale-rights`, headers, payload: body as never });

    // Publishing opens listening only.
    const { revision } = (await h.app.inject({ url: base, headers: admin.authHeader })).json().pendingPublication;
    expect((await h.app.inject({ method: 'POST', url: `${base}/publish-all`, headers: admin.authHeader,
      payload: { reason: 'All checked by ear', revision } })).json()).toEqual({ published: 2, failed: [] });
    const listed = (await h.app.inject({ url: base, headers: admin.authHeader })).json().items as Array<{ id: string; saleRights: string; onSale: boolean }>;
    expect(listed.map((i) => [i.saleRights, i.onSale])).toEqual([['unreviewed', false], ['unreviewed', false]]);

    expect((await decide(a.id, { status: 'cleared', basis: 'ok' })).statusCode).toBe(400);
    expect((await decide(a.id, { status: 'cleared', basis: 'Generated in-house on ACE-Step 1.5 (MIT)' }, support.authHeader)).statusCode).toBe(403);
    const cleared = await decide(a.id, { status: 'cleared', basis: 'Generated in-house on ACE-Step 1.5 (MIT)' });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ saleRights: 'cleared', saleRightsBasis: 'Generated in-house on ACE-Step 1.5 (MIT)', onSale: true });
    expect((await decide(b.id, { status: 'refused', basis: 'Prompt quotes a third-party title' })).json()).toMatchObject({ saleRights: 'refused', onSale: false });
    const audit = await query<{ subject_id: string; reason: string }>(
      `SELECT subject_id, reason FROM audit_logs WHERE action = 'official_bgm.sale_rights' ORDER BY created_at`, []);
    expect(audit).toEqual([
      { subject_id: a.id, reason: 'Generated in-house on ACE-Step 1.5 (MIT)' },
      { subject_id: b.id, reason: 'Prompt quotes a third-party title' },
    ]);
    // Back to unreviewed clears the basis; the visitor view never carries any of it.
    expect((await decide(a.id, { status: 'unreviewed' })).json()).toMatchObject({ saleRights: 'unreviewed', saleRightsBasis: null, onSale: false });
    const visitor = (await h.app.inject({ url: '/v1/marketplace/bgm' })).json().items as Array<Record<string, unknown>>;
    expect(visitor).toHaveLength(2);
    for (const item of visitor) {
      expect(item).not.toHaveProperty('saleRights');
      expect(item).not.toHaveProperty('saleRightsBasis');
    }
  }, 120_000);
});
