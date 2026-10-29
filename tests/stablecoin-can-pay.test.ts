/**
 * The check before signing (apps/web/src/lib/stablecoin.ts): a wallet that
 * cannot cover the transfer is told which coin is short, instead of being
 * handed a transaction its wallet already knows will fail.
 */
import { describe, expect, it } from 'vitest';
import { balanceOfCall, canPayVerdict, hexToBigInt } from '../apps/web/src/lib/stablecoin.js';

const need = 980n * 10n ** 18n;

describe('canPayVerdict', () => {
  it('lets a wallet with the token and some gas pay', () => {
    expect(canPayVerdict({ tokenBalance: need, nativeBalance: 1n, needAtomic: need })).toEqual({ ok: true });
  });

  it('says the token is short, and by how much — the old JPYC reads as zero of the new one', () => {
    expect(canPayVerdict({ tokenBalance: 0n, nativeBalance: 10n ** 18n, needAtomic: need })).toEqual({
      ok: false,
      reason: 'tokenShort',
      haveAtomic: 0n,
      needAtomic: need,
    });
  });

  it('says there is nothing to pay the fee with', () => {
    expect(canPayVerdict({ tokenBalance: need * 2n, nativeBalance: 0n, needAtomic: need })).toEqual({ ok: false, reason: 'noGas' });
  });
});

describe('the reads it makes', () => {
  it('builds balanceOf for an address, whatever its case', () => {
    expect(balanceOfCall('0x7E54000000000000000000000000000000AB797b')).toBe(
      '0x70a08231' + '0000000000000000000000007e54000000000000000000000000000000ab797b',
    );
    expect(() => balanceOfCall('0x1234')).toThrow();
  });

  it('reads a 32-byte word and an empty answer', () => {
    expect(hexToBigInt('0x' + (980n * 10n ** 18n).toString(16).padStart(64, '0'))).toBe(need);
    expect(hexToBigInt('0x')).toBe(0n);
    expect(() => hexToBigInt(null)).toThrow();
  });
});
