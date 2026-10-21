/**
 * NETX is priced at a fixed ¥20 per token (decided 2026-10-21, see
 * docs/NETX_PAYMENT.md §3), on BNB Smart Chain.
 *
 * Until now pricing was a two-way branch — JPYC at one yen, and everything
 * else at the USD/JPY rate with the USDC buffer — so a third token would have
 * been quoted as if it were a dollar. Each token now says how it is priced.
 */
import { describe, expect, it } from 'vitest';
import { JPYC_POLYGON, NETX_BSC, USDC_POLYGON, parseDecimalRate, quoteAmountAtomic, whitelistedTokens } from '@yuha/providers';

describe('the NETX token', () => {
  it('is the NETX BEP-20 contract on BNB Smart Chain', () => {
    expect(NETX_BSC.key).toBe('netx');
    expect(NETX_BSC.chainId).toBe(56);
    expect(NETX_BSC.address).toBe('0x4c32964715e9a42f8d119bfa8917d57822d3adf1');
    expect(whitelistedTokens()).toContain(NETX_BSC);
  });

  it('is priced at a fixed twenty yen; the others keep their rules', () => {
    expect(NETX_BSC.pricing).toEqual({ kind: 'fixed-yen', yenPerToken: 20 });
    expect(JPYC_POLYGON.pricing).toEqual({ kind: 'yen' });
    expect(USDC_POLYGON.pricing).toEqual({ kind: 'usd-market' });
  });
});

describe('quoting NETX', () => {
  const unit = 10n ** BigInt(NETX_BSC.decimals);

  it('divides the yen price by twenty, with no rate and no buffer', () => {
    expect(quoteAmountAtomic({ priceJpy: 980, token: NETX_BSC, rate: null })).toEqual({
      amountAtomic: 49n * unit,
      rounded: false,
    });
    expect(quoteAmountAtomic({ priceJpy: 1980, token: NETX_BSC, rate: null }).amountAtomic).toBe(99n * unit);
  });

  it('ignores a rate or buffer passed by mistake: the price is fixed', () => {
    const q = quoteAmountAtomic({ priceJpy: 980, token: NETX_BSC, rate: parseDecimalRate('150'), bufferBps: 100 });
    expect(q.amountAtomic).toBe(49n * unit);
  });

  it('rounds up, so a price never costs less than its yen value', () => {
    // A token with no decimals makes the remainder visible: 990 / 20 = 49.5.
    const whole = { ...NETX_BSC, decimals: 0 };
    expect(quoteAmountAtomic({ priceJpy: 990, token: whole, rate: null })).toEqual({ amountAtomic: 50n, rounded: true });
  });
});
