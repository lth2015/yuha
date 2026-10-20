/**
 * How a product may be paid for, decided once (docs/PAYMENTS_DESIGN.md).
 *
 * The rule is "what the deployment has open × what the product kind allows",
 * and nothing per price key. The grid that offered JPYC on DROP and "card
 * closed" on the subscriptions beside it was each button deciding for itself
 * from a copy of the rules; these tests pin the one copy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProductView } from '@yuha/contracts';
import { paymentMethodsFor, stablecoinAllowedFor } from '../apps/api/src/services/payment-methods.js';
import {
  canBePaid,
  firstAvailableMethod,
  methodsOpenAnywhere,
  paymentMethodsOf,
  unavailableReason,
} from '../apps/web/src/lib/purchase.js';
import { createHarness, teardown, type Harness } from './helpers/harness.js';

describe('the matrix', () => {
  const allOpen = { card: true, stablecoins: ['jpyc', 'usdc'] as Array<'jpyc' | 'usdc'> };

  it('a top-up pack can be paid in every open channel', () => {
    expect(paymentMethodsFor('one_time', allOpen)).toEqual([
      { method: 'card', available: true, reason: null },
      { method: 'jpyc', available: true, reason: null },
      { method: 'usdc', available: true, reason: null },
    ]);
  });

  it('a subscription is card-only, and says why the stablecoins are not', () => {
    expect(paymentMethodsFor('subscription', allOpen)).toEqual([
      { method: 'card', available: true, reason: null },
      { method: 'jpyc', available: false, reason: 'no_auto_renewal' },
      { method: 'usdc', available: false, reason: 'no_auto_renewal' },
    ]);
  });

  it('a closed card is listed as closed, never dropped', () => {
    expect(paymentMethodsFor('one_time', { card: false, stablecoins: [] })).toEqual([
      { method: 'card', available: false, reason: 'card_closed' },
    ]);
  });

  it('a stablecoin the deployment has off is not advertised at all', () => {
    expect(paymentMethodsFor('one_time', { card: true, stablecoins: ['jpyc'] }).map((m) => m.method)).toEqual([
      'card',
      'jpyc',
    ]);
  });

  it('is decided by kind, so a new one-time product is payable everywhere the day it exists', () => {
    expect(stablecoinAllowedFor('one_time')).toBe(true);
    expect(stablecoinAllowedFor('subscription')).toBe(false);
  });
});

describe('what the browser does with it', () => {
  const p = (paymentMethods?: ProductView['paymentMethods']) => ({ paymentMethods });

  it('picks the first available method and reports none when none is', () => {
    expect(firstAvailableMethod(p([{ method: 'card', available: false, reason: 'card_closed' }, { method: 'usdc', available: true, reason: null }]))).toBe('usdc');
    expect(canBePaid(p([{ method: 'card', available: false, reason: 'card_closed' }]))).toBe(false);
  });

  it('explains a subscription with only stablecoins open as "no auto-renewal", not as "card closed" alone', () => {
    expect(
      unavailableReason(
        p([
          { method: 'card', available: false, reason: 'card_closed' },
          { method: 'jpyc', available: false, reason: 'no_auto_renewal' },
        ]),
      ),
    ).toBe('no_auto_renewal');
    expect(unavailableReason(p([{ method: 'card', available: false, reason: 'card_closed' }]))).toBe('card_closed');
    expect(unavailableReason(p([{ method: 'card', available: true, reason: null }]))).toBeNull();
  });

  it('treats a response from an API that has not rolled yet as card-only, rather than as nothing', () => {
    expect(paymentMethodsOf(p(undefined))).toEqual([{ method: 'card', available: true, reason: null }]);
  });

  it('summarises the methods open anywhere, in a fixed order', () => {
    expect(
      methodsOpenAnywhere([
        p([{ method: 'usdc', available: true, reason: null }, { method: 'card', available: false, reason: 'card_closed' }]),
        p([{ method: 'jpyc', available: true, reason: null }]),
      ]),
    ).toEqual(['jpyc', 'usdc']);
  });
});

describe('GET /v1/products carries the matrix', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({
      STABLECOIN_ENABLED: 'true',
      STABLECOIN_JPYC_ENABLED: 'true',
      STABLECOIN_USDC_ENABLED: 'true',
      STABLECOIN_RECEIVER_ADDRESS: '0x9999999999999999999999999999999999999999',
      POLYGON_RPC_PRIMARY_URL: 'https://polygon.primary.invalid/rpc/test',
      POLYGON_RPC_SECONDARY_URL: 'https://polygon.secondary.invalid/rpc/test',
    });
  });
  afterAll(async () => {
    await h.close();
    await teardown();
  });

  it('every one-time product takes all three; every subscription takes card only', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/products' });
    const items = res.json().items as ProductView[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const available = paymentMethodsOf(item).filter((m) => m.available).map((m) => m.method);
      expect(available).toEqual(item.kind === 'subscription' ? ['card'] : ['card', 'jpyc', 'usdc']);
    }
  });
});
