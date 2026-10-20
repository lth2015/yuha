/**
 * Changing the card on a subscription.
 *
 * A subscriber could cancel online and do nothing else: a new card, an
 * expired one, an invoice to download all meant writing to support. Stripe's
 * Customer Portal does those, for the customer the subscription belongs to.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertSubscription, withTx } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `198.18.9.${(callNo++ % 200) + 10}` });

beforeAll(async () => {
  h = await createHarness({ ADMIN_MFA_REQUIRED: 'false' });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await teardown();
});

async function subscribe(user: TestUser, n: number): Promise<string> {
  const now = new Date();
  await withTx((tx) =>
    upsertSubscription(
      {
        userId: user.id,
        stripeSubscriptionId: `sub_test_${n}`,
        stripeCustomerId: `cus_test_${n}`,
        priceKey: 'creator_monthly',
        priceVersion: 1,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
        cancelAtPeriodEnd: false,
        canceledAt: null,
        eventAt: now,
      },
      tx,
    ),
  );
  const res = await h.app.inject({ method: 'GET', url: '/v1/entitlements', headers: { ...user.authHeader, ...freshIp() } });
  const sub = (res.json() as { subscription?: { subscriptionId: string } | null }).subscription;
  expect(sub, res.body).toBeTruthy();
  return sub!.subscriptionId;
}

const portal = (user: TestUser | null, subscriptionId: string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/subscription/portal',
    headers: { ...(user?.authHeader ?? {}), ...freshIp() },
    payload: { subscriptionId } as never,
  });

describe('the card and invoices of a subscription', () => {
  it('opens the payment provider’s portal for the subscriber, coming back to billing', async () => {
    const user = await h.createUser({ email: 'portal-owner@example.test' });
    const id = await subscribe(user, 1);

    const res = await portal(user, id);
    expect(res.statusCode, res.body).toBe(200);
    const { url } = res.json() as { url: string };
    expect(url).toMatch(/^https?:\/\//);
  });

  it('is nobody else’s to open', async () => {
    const owner = await h.createUser({ email: 'portal-a@example.test' });
    const other = await h.createUser({ email: 'portal-b@example.test' });
    const id = await subscribe(owner, 2);

    const res = await portal(other, id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SUBSCRIPTION_NOT_FOUND');
    expect((await portal(null, id)).statusCode).toBe(401);
  });
});
