/**
 * Quote arithmetic, in integers only.
 *
 * `amount_atomic = ceil(price_jpy / rate × 10^decimals)` with no floating
 * point anywhere: a JPYC amount is eighteen decimal places wide, which is
 * eleven digits past what a double can hold exactly, and rounding the wrong
 * way by one atomic unit is an underpayment that lands in manual review.
 */
import { describe, expect, it } from 'vitest';
import { JPYC_POLYGON, USDC_POLYGON, parseDecimalRate, quoteAmountAtomic, rateUsable } from '@yuha/providers';

describe('JPYC', () => {
  it('quotes 980 JPY as exactly 980 JPYC, with nothing to round', () => {
    const q = quoteAmountAtomic({ priceJpy: 980, token: JPYC_POLYGON, rate: null });
    expect(q.amountAtomic).toBe(980n * 10n ** 18n);
    expect(q.rounded).toBe(false);
  });

  it('is a pricing policy, not a redemption promise — the rate is not consulted', () => {
    // 1 JPYC = 1 JPY is what YUHA charges. It says nothing about what the
    // token is worth, so no rate source can make this quote fail or drift.
    expect(quoteAmountAtomic({ priceJpy: 1980, token: JPYC_POLYGON, rate: null }).amountAtomic).toBe(
      1980n * 10n ** 18n,
    );
  });
});

describe('USDC', () => {
  const rate = (s: string) => parseDecimalRate(s);

  it('rounds up, so the customer is never a unit short', () => {
    // 980 / 150 = 6.5333... → 6.533334 at six decimals, not 6.533333.
    const q = quoteAmountAtomic({ priceJpy: 980, token: USDC_POLYGON, rate: rate('150.00') });
    expect(q.amountAtomic).toBe(6_533_334n);
    expect(q.rounded).toBe(true);
  });

  it('does not round when the division is exact', () => {
    const q = quoteAmountAtomic({ priceJpy: 300, token: USDC_POLYGON, rate: rate('150') });
    expect(q.amountAtomic).toBe(2_000_000n);
    expect(q.rounded).toBe(false);
  });

  it('keeps every digit of a long rate instead of a double’s nearest neighbour', () => {
    const q = quoteAmountAtomic({ priceJpy: 3980, token: USDC_POLYGON, rate: rate('149.873219') });
    // 3980 * 10^6 * 10^6 / 149873219, rounded up.
    expect(q.amountAtomic).toBe((3980n * 10n ** 6n * 10n ** 6n + 149_873_219n - 1n) / 149_873_219n);
  });

  it('refuses a rate of zero or less rather than quoting something enormous', () => {
    expect(() => quoteAmountAtomic({ priceJpy: 980, token: USDC_POLYGON, rate: rate('0') })).toThrow(/rate/);
    expect(() => parseDecimalRate('-150')).toThrow(/rate/);
  });

  it('refuses to quote USDC with no rate at all, instead of falling back to a constant', () => {
    expect(() => quoteAmountAtomic({ priceJpy: 980, token: USDC_POLYGON, rate: null })).toThrow(/rate/);
  });

  it('will not take a rate through a float', () => {
    // The point of the string form: 0.1 + 0.2 problems do not get to decide
    // how many atomic units a customer sends.
    expect(() => parseDecimalRate('1e2')).toThrow(/rate/);
    expect(() => parseDecimalRate('150.0.0')).toThrow(/rate/);
    expect(() => parseDecimalRate('')).toThrow(/rate/);
  });
});

describe('whether a rate may be used at all', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const fresh = { observedAtMs: now - 30_000, provider: 'primary' as const };

  it('accepts a fresh rate that agrees with the second source', () => {
    const v = rateUsable({
      primary: { ...fresh, rate: parseDecimalRate('150.00') },
      secondary: { ...fresh, rate: parseDecimalRate('150.05') },
      nowMs: now,
      maxAgeSeconds: 120,
      maxDivergenceBps: 50,
    });
    expect(v.usable).toBe(true);
  });

  it('refuses a stale rate — and does not quietly use the older number', () => {
    const v = rateUsable({
      primary: { ...fresh, observedAtMs: now - 600_000, rate: parseDecimalRate('150.00') },
      secondary: { ...fresh, rate: parseDecimalRate('150.00') },
      nowMs: now,
      maxAgeSeconds: 120,
      maxDivergenceBps: 50,
    });
    expect(v.usable).toBe(false);
    expect(v.reason).toBe('stale');
  });

  it('refuses when the two sources disagree beyond the operating threshold', () => {
    // A depeg or a broken feed shows up here first. Either way the answer is
    // to stop quoting, not to pick one.
    const v = rateUsable({
      primary: { ...fresh, rate: parseDecimalRate('150.00') },
      secondary: { ...fresh, rate: parseDecimalRate('142.00') },
      nowMs: now,
      maxAgeSeconds: 120,
      maxDivergenceBps: 50,
    });
    expect(v.usable).toBe(false);
    expect(v.reason).toBe('divergent');
  });

  it('refuses when there is no second source to check against', () => {
    const v = rateUsable({
      primary: { ...fresh, rate: parseDecimalRate('150.00') },
      secondary: null,
      nowMs: now,
      maxAgeSeconds: 120,
      maxDivergenceBps: 50,
    });
    expect(v.usable).toBe(false);
    expect(v.reason).toBe('unconfirmed');
  });

  it('records which source and when, so an invoice can be checked later', () => {
    const v = rateUsable({
      primary: { ...fresh, rate: parseDecimalRate('150.00') },
      secondary: { ...fresh, rate: parseDecimalRate('150.00') },
      nowMs: now,
      maxAgeSeconds: 120,
      maxDivergenceBps: 50,
    });
    expect(v.usable && v.chosen.provider).toBe('primary');
    expect(v.usable && v.chosen.observedAtMs).toBe(now - 30_000);
  });
});
