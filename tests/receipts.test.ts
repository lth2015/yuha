/**
 * The receipt link in the purchase history.
 *
 * It was read from the Checkout Session's `receipt_url`, and a Checkout
 * Session has no such field (stripe@17 types: not one occurrence) — the
 * receipt lives on the Charge, and for a subscription on its first invoice.
 * Every card purchase therefore showed "—" where its receipt should be.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query, withTx } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `198.18.7.${(callNo++ % 200) + 10}` });

beforeAll(async () => {
  h = await createHarness({ ADMIN_MFA_REQUIRED: 'false' });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await teardown();
});

async function drainWebhooks(): Promise<void> {
  const { claimWebhookEvents } = await import('@yuha/db');
  const { processWebhookEvent } = await import('../apps/api/src/services/webhooks.js');
  const events = await withTx(async (tx) => claimWebhookEvents(20, tx));
  for (const ev of events) await processWebhookEvent(h.ctx, ev);
}

async function buyDrop(user: TestUser, key: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/checkout',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { priceKey: 'drop_5', idempotencyKey: key } as never,
  });
  expect(res.statusCode, res.body).toBe(200);
  const { orderId, checkoutUrl } = res.json() as { orderId: string; checkoutUrl: string };
  const sessionId = new URL(checkoutUrl).searchParams.get('session_id')!;
  const paid = await h.app.inject({
    method: 'POST',
    url: '/v1/dev/simulate-payment',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { sessionId, outcome: 'paid' } as never,
  });
  expect(paid.statusCode, paid.body).toBeLessThan(300);
  await drainWebhooks();
  return orderId;
}

const history = async (user: TestUser) =>
  (await h.app.inject({ method: 'GET', url: '/v1/orders', headers: { ...user.authHeader, ...freshIp() } })).json()
    .items as Array<{ orderId: string; status: string; receiptUrl: string | null }>;

describe('the receipt link in the purchase history', () => {
  it('is recorded when a card purchase is paid', async () => {
    const user = await h.createUser({ email: 'receipt-buyer@example.test' });
    const orderId = await buyDrop(user, 'receipt-key-0001');

    const row = (await history(user)).find((o) => o.orderId === orderId)!;
    expect(row.status).toBe('paid');
    expect(row.receiptUrl).toMatch(/^https:\/\//);
  });

  it('is filled in for an order paid before receipts were recorded', async () => {
    const user = await h.createUser({ email: 'receipt-older@example.test' });
    const orderId = await buyDrop(user, 'receipt-key-0002');
    await query(`UPDATE orders SET receipt_url = NULL WHERE id = ?`, [orderId]);

    // The history answers at once with what it has, and fetches the missing
    // receipt from Stripe behind it, so the page is never held up by Stripe.
    await history(user);
    let receipt: string | null = null;
    for (let i = 0; i < 20 && !receipt; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      receipt = (await history(user)).find((o) => o.orderId === orderId)!.receiptUrl;
    }
    expect(receipt).toMatch(/^https:\/\//);
  });
});
