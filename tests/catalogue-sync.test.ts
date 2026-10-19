/**
 * `syncCatalogue`, the only thing a deployed environment runs to make the
 * pricing page sell anything.
 *
 * It was lifted out of `seed.ts` and its promises were checked once, by hand:
 * "writes the four products, writes nothing else, writes nothing at all when
 * Stripe disagrees". Each of those is a sentence a later change can quietly
 * make false — write before checking, return true on a refusal, start
 * creating accounts — so each is a test here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RemotePrice } from '@yuha/providers';
import { query } from '@yuha/db';
import { syncCatalogue } from '../apps/api/src/services/catalogue-sync.js';
import { catalogue } from '../apps/api/src/catalogue.js';
import type { AppConfig } from '../apps/api/src/config.js';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
  // The harness writes its own fixture catalogue; this suite is about the
  // real one arriving in an empty table, which is what a fresh environment is.
  await query(`DELETE FROM product_catalog`);
});
afterAll(async () => {
  await resetData();
  await teardown();
});

const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l), fail: (l: string) => lines.push(l) };
};

const products = () =>
  query<{ price_key: string; version: number; amount_minor: number; active: boolean }>(
    `SELECT price_key, version, amount_minor, active FROM product_catalog ORDER BY price_key`,
  );
const count = async (table: string) =>
  Number((await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n);

describe('syncCatalogue', () => {
  it('writes every catalogue product, and running it again changes nothing', async () => {
    const out = quiet();
    expect(await syncCatalogue(h.ctx, h.ctx.config, out.log, out.fail)).toBe(true);
    const expected = catalogue(h.ctx.config)
      .map((r) => ({ price_key: r.price_key, version: r.version, amount_minor: r.amount_minor, active: true }))
      .sort((a, b) => a.price_key.localeCompare(b.price_key));
    expect(await products()).toEqual(expected);

    expect(await syncCatalogue(h.ctx, h.ctx.config, out.log, out.fail)).toBe(true);
    expect(await products()).toEqual(expected);
  });

  it('writes the catalogue and nothing else — no accounts, no songs', async () => {
    const before = { users: await count('users'), tracks: await count('tracks') };
    const out = quiet();
    await syncCatalogue(h.ctx, h.ctx.config, out.log, out.fail);
    expect({ users: await count('users'), tracks: await count('tracks') }).toEqual(before);
  });

  it('refuses, and writes nothing, when Stripe disagrees with a configured id', async () => {
    // DROP's id points at a Price with the wrong amount: the swap this check
    // exists for. Stripe is asked BEFORE anything is written.
    const config = { ...h.ctx.config, STRIPE_PRICE_ID_DROP_5: 'price_wrong' } as AppConfig;
    const wrong: RemotePrice = {
      id: 'price_wrong',
      active: true,
      amountMinor: 1980,
      currency: 'jpy',
      interval: null,
      intervalCount: null,
      taxBehavior: 'inclusive',
      productId: 'prod_x',
      productName: 'CREATOR',
      productActive: true,
      usageType: null,
      billingScheme: 'per_unit',
    } as RemotePrice;
    const ctx = { ...h.ctx, payments: { retrievePrice: async () => wrong } } as never;

    const out = quiet();
    expect(await syncCatalogue(ctx, config, out.log, out.fail)).toBe(false);
    expect(await products()).toEqual([]);
    expect(out.lines.join('\n')).toContain('STRIPE_PRICE_ID_DROP_5');
    // It does not migrate, so it must not say that migrations ran: the
    // sentence was true inside `seed.ts` and false everywhere else.
    expect(out.lines.join('\n')).not.toMatch(/migration/i);
  });
});
