/**
 * A card purchase that cannot complete is not offered, and is not started.
 *
 * yuha.studio ran `RUN_MODE=integration` with the simulated payments adapter.
 * The API answered every purchase with a simulated checkout; the page that
 * settles one refuses outside demo mode; and the simulated sessions live in
 * one process's memory while the deployment runs two replicas. So every buyer
 * who pressed 充值 reached "this page is for demo mode only", with a pending
 * order left behind each time, and nothing anywhere said card payment was
 * closed.
 *
 * `cardPaymentsEnabled` is the one fact all of that should have been decided
 * by: Stripe, or the demo, where the simulated round trip is the point.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

let integration: Harness;
let demo: Harness;

beforeAll(async () => {
  integration = await createHarness({ RUN_MODE: 'integration' });
  demo = await createHarness();
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await integration.close();
  await demo.close();
  await teardown();
});

const orderCount = async () => Number((await query<{ n: number }>('SELECT COUNT(*) AS n FROM orders'))[0]!.n);

describe('the runtime says whether a card purchase can complete', () => {
  it('not with simulated payments outside the demo', async () => {
    const res = await integration.app.inject({ method: 'GET', url: '/v1/runtime' });
    expect(res.json().adapters.payments).toBe('simulated');
    expect(res.json().features.cardPaymentsEnabled).toBe(false);
  });

  it('yes in the demo, where the simulated round trip is the whole point', async () => {
    const res = await demo.app.inject({ method: 'GET', url: '/v1/runtime' });
    expect(res.json().features.cardPaymentsEnabled).toBe(true);
  });
});

describe('the API refuses to start one, before writing anything', () => {
  it('a credit pack', async () => {
    const user = await integration.createUser();
    const res = await integration.app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: user.authHeader,
      payload: { priceKey: 'drop_5', idempotencyKey: 'closed-card-0001' } as never,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CARD_PAYMENTS_CLOSED');
    // Each press used to leave a pending order that could never be paid.
    expect(await orderCount()).toBe(0);
  });

  it('a song licence', async () => {
    const user = await integration.createUser();
    const res = await integration.app.inject({
      method: 'POST',
      // Any id: refused before the track is looked up. (Not the all-zero UUID —
      // check:stewardship reads its digit groups as a telephone number.)
      url: `/v1/market/tracks/${randomUUID()}/license`,
      headers: { ...user.authHeader, 'idempotency-key': 'closed-card-0002' },
      payload: {} as never,
    });
    // Before the track is even looked up: whatever the song, a card
    // purchase cannot finish here.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CARD_PAYMENTS_CLOSED');
    expect(await orderCount()).toBe(0);
  });

  it('and the demo still sells', async () => {
    const user = await demo.createUser();
    const res = await demo.app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: user.authHeader,
      payload: { priceKey: 'drop_5', idempotencyKey: 'demo-card-00001' } as never,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().simulated).toBe(true);
  });
});

describe('the catalogue says, per product, that card cannot pay', () => {
  it('lists card as closed on every product outside the demo with simulated payments', async () => {
    const res = await integration.app.inject({ method: 'GET', url: '/v1/products' });
    const items = res.json().items as Array<{ priceKey: string; paymentMethods: Array<{ method: string; available: boolean; reason: string | null }> }>;
    expect(items.length).toBeGreaterThan(0);
    for (const p of items) {
      expect(p.paymentMethods).toEqual([{ method: 'card', available: false, reason: 'card_closed' }]);
    }
  });

  it('lists card as open in the demo, where the simulated round trip is the point', async () => {
    const res = await demo.app.inject({ method: 'GET', url: '/v1/products' });
    for (const p of res.json().items as Array<{ paymentMethods: unknown }>) {
      expect(p.paymentMethods).toEqual([{ method: 'card', available: true, reason: null }]);
    }
  });
});
