/**
 * How long a granted subscription period lasts when nothing authoritative says.
 *
 * `handleInvoicePaid` prefers Stripe's own period end. When no source has one —
 * an invoice shape that moved, a reconstructed event — it grants anyway, with
 * an inferred expiry rather than one that never comes, because a paid
 * subscription that delivers nothing is the bug those paths were written for.
 *
 * The inference was a flat 31 days. Every plan in the catalogue is monthly, so
 * that was right, and it was right by coincidence: nothing recorded the
 * cadence, so an annual plan would have been granted a month and the subscriber
 * would have lost eleven. "Infer it from the price key's spelling" is the shape
 * of guess this repository keeps finding in itself, so the cadence is a column.
 *
 * It still errs long, deliberately: a batch that lives a few days past its
 * period is a bounded error in the customer's favour, and the next invoice
 * grants the next period under its own key regardless, so it never compounds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execute, getActiveProduct, inferredPeriodDays, query, upsertProduct } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness';

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
beforeEach(async () => { await resetData(); });
afterAll(async () => { await h?.close(); await teardown(); });

/*
 * `product_catalog` is reference data: `resetData` does not truncate it, it is
 * replayed by an upsert. So a product a test adds outlives that test, outlives
 * the file, and outlives the run — the first draft of the backfill case below
 * failed on a `test_annual` row left by the case above it, and before that on
 * one left by a run that had aborted half way. Clean up what this file adds.
 */
beforeEach(async () => {
  await execute(`DELETE FROM product_catalog WHERE price_key LIKE 'test\\_%'`);
});

describe('how long an inferred period lasts', () => {
  it('gives a monthly plan the month it had before', () => {
    expect(inferredPeriodDays('month')).toBe(31);
  });

  it('gives an annual plan a year, not a month', () => {
    // The whole point: 31 days for an annual subscriber is eleven months of
    // paid-for credits that never arrive.
    expect(inferredPeriodDays('year')).toBe(366);
  });

  it('errs long for both, never short', () => {
    // A batch a few days past its period costs us a little; one that ends
    // early takes something the subscriber paid for.
    expect(inferredPeriodDays('month')).toBeGreaterThan(30);
    expect(inferredPeriodDays('year')).toBeGreaterThan(365);
  });

  it('falls back to a month for anything it does not recognise', () => {
    // A cadence from the database is a string; an unknown one must not produce
    // NaN and an Invalid Date on the grant path.
    expect(inferredPeriodDays(null)).toBe(31);
    expect(inferredPeriodDays('fortnight')).toBe(31);
  });
});

describe('what the catalogue records about cadence', () => {
  it('keeps the interval it was given', async () => {
    await upsertProduct({
      price_key: 'test_annual', version: 1, kind: 'subscription',
      display_name: 'Annual', amount_minor: 1_980_000, currency: 'jpy',
      tax_included: true, units: 180, validity_days: null, auto_renew: true,
      billing_interval: 'year', stripe_price_id: null, active: true,
    });
    const got = await getActiveProduct('test_annual');
    expect(got?.billing_interval).toBe('year');
  });

  it('refuses a subscription that does not say how often it bills', async () => {
    // The guess cannot come back by someone forgetting the column: a
    // subscription with no cadence is rejected by the database, not defaulted.
    await expect(
      upsertProduct({
        price_key: 'test_silent', version: 1, kind: 'subscription',
        display_name: 'Silent', amount_minor: 198_000, currency: 'jpy',
        tax_included: true, units: 15, validity_days: null, auto_renew: true,
        billing_interval: null, stripe_price_id: null, active: true,
      }),
    ).rejects.toThrow();
  });

  it('leaves one-time products without one, because they do not bill again', async () => {
    await upsertProduct({
      price_key: 'test_drop', version: 1, kind: 'one_time',
      display_name: 'Drop', amount_minor: 50_000, currency: 'jpy',
      tax_included: true, units: 5, validity_days: 90, auto_renew: false,
      billing_interval: null, stripe_price_id: null, active: true,
    });
    expect((await getActiveProduct('test_drop'))?.billing_interval).toBeNull();
  });

  it('gave the subscriptions that already existed the month they were sold as', async () => {
    // Backfill check, scoped to the seeded catalogue rather than to whatever
    // is in the table: products other tests add are still there.
    const rows = await query<{ price_key: string; billing_interval: string | null }>(
      `SELECT price_key, billing_interval FROM product_catalog
        WHERE kind = 'subscription' AND price_key NOT LIKE 'test\\_%'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.billing_interval, r.price_key).toBe('month');
  });

  it('refuses to change a plan\'s cadence under the same version', async () => {
    // A version is what an order was placed against. Re-defining monthly as
    // annual under it changes what somebody already bought, and the UPDATE
    // clause would not even have applied it — the row would keep the old
    // interval while the seed said otherwise.
    const monthly = {
      price_key: 'test_cadence', version: 1, kind: 'subscription' as const,
      display_name: 'Cadence', amount_minor: 198_000, currency: 'jpy',
      tax_included: true, units: 15, validity_days: null, auto_renew: true,
      billing_interval: 'month' as const, stripe_price_id: null, active: true,
    };
    await upsertProduct(monthly);
    await expect(upsertProduct({ ...monthly, billing_interval: 'year' }))
      .rejects.toThrow(/billing_interval/);
    expect((await getActiveProduct('test_cadence'))?.billing_interval).toBe('month');
  });
});
