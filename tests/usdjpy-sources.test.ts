/**
 * Reading USD/JPY, and turning it into a USDC amount.
 *
 * The response shapes below are the ones read from the live endpoints on
 * 2026-10-20; the cases are the ways a feed changes underneath you.
 */
import { describe, expect, it } from 'vitest';
import {
  JPYC_POLYGON,
  USDC_POLYGON,
  parseDecimalRate,
  quoteAmountAtomic,
  rateUsable,
  readCoinbaseUsdJpy,
  readFrankfurterUsdJpy,
  type FetchLike,
} from '@yuha/providers';

const answer = (body: unknown, status = 200): FetchLike => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const NOW = Date.parse('2026-10-20T03:00:00Z');

describe('Coinbase (primary)', () => {
  it('keeps the rate exactly as the source wrote it', async () => {
    const o = await readCoinbaseUsdJpy(answer({ data: { currency: 'USD', rates: { JPY: '158.0465', USDC: '1' } } }), {
      nowMs: () => NOW,
    });
    expect(o.rate.text).toBe('158.0465');
    expect(o.provider).toBe('coinbase-usd-jpy');
    expect(o.observedAtMs).toBe(NOW);
    expect(o.sourceTimestampMs).toBeUndefined();
  });

  it('refuses a table for another base currency, which would parse perfectly and be wrong', async () => {
    await expect(readCoinbaseUsdJpy(answer({ data: { currency: 'EUR', rates: { JPY: '171.2' } } }))).rejects.toThrow(/not a USD/);
  });

  it('refuses a missing or non-string JPY rate, and a rate in scientific notation', async () => {
    await expect(readCoinbaseUsdJpy(answer({ data: { currency: 'USD', rates: {} } }))).rejects.toThrow(/no JPY/);
    await expect(readCoinbaseUsdJpy(answer({ data: { currency: 'USD', rates: { JPY: 158.04 } } }))).rejects.toThrow(/no JPY/);
    await expect(readCoinbaseUsdJpy(answer({ data: { currency: 'USD', rates: { JPY: '1.58e2' } } }))).rejects.toThrow(/plain decimal/);
  });

  it('refuses an error status rather than reading its body', async () => {
    await expect(readCoinbaseUsdJpy(answer({}, 503))).rejects.toThrow(/503/);
  });
});

describe('Frankfurter (reference)', () => {
  it('reads the numeric rate and dates it from the publication day', async () => {
    const o = await readFrankfurterUsdJpy(answer({ date: '2026-10-20', base: 'USD', quote: 'JPY', rate: 158.16 }), {
      nowMs: () => NOW,
    });
    expect(o.rate.text).toBe('158.16');
    expect(o.sourceTimestampMs).toBe(Date.parse('2026-10-20T00:00:00Z'));
  });

  it('refuses another pair, a missing rate and a missing date', async () => {
    await expect(readFrankfurterUsdJpy(answer({ date: '2026-10-20', base: 'EUR', quote: 'JPY', rate: 171 }))).rejects.toThrow(/not USD\/JPY/);
    await expect(readFrankfurterUsdJpy(answer({ date: '2026-10-20', base: 'USD', quote: 'JPY' }))).rejects.toThrow(/no numeric rate/);
    await expect(readFrankfurterUsdJpy(answer({ base: 'USD', quote: 'JPY', rate: 158.16 }))).rejects.toThrow(/publication date/);
  });
});

describe('the amount', () => {
  const rate = parseDecimalRate('158.0465');

  it('adds the buffer before converting and rounds up to the atomic unit', () => {
    // ceil(980 * 1.01 / 158.0465 * 10^6) = ceil(6262713.82…)
    expect(quoteAmountAtomic({ priceJpy: 980, token: USDC_POLYGON, rate, bufferBps: 100 })).toEqual({
      amountAtomic: 6_262_714n,
      rounded: true,
    });
  });

  it('with no buffer is the plain conversion, as before', () => {
    expect(quoteAmountAtomic({ priceJpy: 980, token: USDC_POLYGON, rate }).amountAtomic).toBe(6_200_707n);
    expect(quoteAmountAtomic({ priceJpy: 980, token: USDC_POLYGON, rate, bufferBps: 0 }).amountAtomic).toBe(6_200_707n);
  });

  it('never applies a buffer to JPYC, which is 1:1 by policy', () => {
    expect(quoteAmountAtomic({ priceJpy: 980, token: JPYC_POLYGON, rate: null, bufferBps: 100 }).amountAtomic).toBe(
      980n * 10n ** 18n,
    );
  });

  it('refuses a buffer that is not whole basis points between 0 and 1000', () => {
    expect(() => quoteAmountAtomic({ priceJpy: 980, token: USDC_POLYGON, rate, bufferBps: 1001 })).toThrow(/buffer/);
    expect(() => quoteAmountAtomic({ priceJpy: 980, token: USDC_POLYGON, rate, bufferBps: 1.5 })).toThrow(/buffer/);
  });
});

describe('whether a rate may be used', () => {
  const fresh = (text: string, extra: object = {}) => ({ rate: parseDecimalRate(text), provider: 'x', observedAtMs: NOW, ...extra });

  it('refuses a reference whose own publication is too old, even when it was read just now', () => {
    const verdict = rateUsable({
      primary: fresh('158.0465'),
      secondary: fresh('158.16', { sourceTimestampMs: NOW - 5 * 86_400_000 }),
      nowMs: NOW,
      maxAgeSeconds: 60,
      maxDivergenceBps: 300,
      maxSourceAgeSeconds: 96 * 3600,
    });
    expect(verdict).toEqual({ usable: false, reason: 'stale' });
  });

  it('accepts the two sources of 2026-10-20 and prices from the primary', () => {
    const verdict = rateUsable({
      primary: fresh('158.0465'),
      secondary: fresh('158.16', { sourceTimestampMs: NOW - 3 * 3600_000 }),
      nowMs: NOW,
      maxAgeSeconds: 60,
      maxDivergenceBps: 300,
      maxSourceAgeSeconds: 96 * 3600,
    });
    expect(verdict.usable).toBe(true);
    if (verdict.usable) {
      expect(verdict.chosen.rate.text).toBe('158.0465');
      expect(verdict.divergenceBps).toBeLessThan(10);
    }
  });
});
