/**
 * A chargeback we lose is a refund by another name.
 *
 * Only `charge.dispute.created` was routed, and it deliberately revokes
 * nothing: a dispute being opened is not a dispute being lost, and taking
 * someone's credits while we may still win would punish a customer who turns
 * out to be wrong about nothing.
 *
 * But `charge.dispute.closed` was not routed at all. So the moment the money
 * actually goes — we lose, Stripe takes it back — nothing happened: no
 * revocation, and not even the operator signal, which fires on `created`. Money
 * gone, credits kept, nobody told. That is the same hole the subscription
 * refund had, one step further down the same path, and it is not a policy
 * question: a lost dispute has taken the money exactly as a refund has.
 *
 * Winning is the other half and has to stay harmless — the money stayed, so the
 * credits do.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processWebhookEvent, reconcilePendingCheckouts } from '@yuha/api';
import { claimWebhookEvents, getActiveProduct, query, recordWebhookEvent, withTx } from '@yuha/db';
import { SimulatedPaymentsAdapter } from '@yuha/providers';
import { balanceOf, createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let sim: SimulatedPaymentsAdapter;
let planUnits: number;
const PERIOD_MINOR = 198_000;

beforeAll(async () => {
  h = await createHarness({ FEATURE_SUBSCRIPTIONS_ENABLED: 'true' });
  sim = h.ctx.payments as SimulatedPaymentsAdapter;
  planUnits = (await getActiveProduct('pro_monthly'))!.units;
});
beforeEach(async () => { await resetData(); });
afterAll(async () => { await h?.close(); await teardown(); });

const drain = async () => {
  const events = await withTx(async (tx) => claimWebhookEvents(20, tx));
  for (const ev of events) await processWebhookEvent(h.ctx, ev);
  return events.length;
};

async function subscribedWithOnePaidPeriod(user: TestUser, tag: string) {
  const res = await h.app.inject({
    method: 'POST', url: '/v1/checkout', headers: user.authHeader,
    payload: { priceKey: 'pro_monthly', idempotencyKey: `idem_${tag}` } as never,
  });
  const body = res.json() as { checkoutUrl: string };
  const sessionId = new URL(body.checkoutUrl).searchParams.get('session_id')!;
  const session = sim.settle(sessionId, 'paid')!;
  await reconcilePendingCheckouts(h.ctx, 0);

  const invoiceId = `in_${tag}`;
  await recordWebhookEvent({
    provider: 'stripe', eventId: `evt_inv_${tag}`, eventType: 'invoice.paid',
    signatureVerified: true,
    payload: {
      id: `evt_inv_${tag}`, type: 'invoice.paid', created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: invoiceId, object: 'invoice', status: 'paid', paid: true,
        amount_paid: PERIOD_MINOR, charge: `ch_${tag}`,
        parent: { type: 'subscription_details', subscription_details: {
          subscription: session.subscriptionId!,
          metadata: { user_id: user.id, price_key: 'pro_monthly' },
        } },
      } },
    },
  });
  await drain();
  expect((await balanceOf(user.id)).available).toBe(planUnits);
  return { invoiceId, chargeId: `ch_${tag}` };
}

async function dispute(type: string, chargeId: string, status: string, tag: string) {
  await recordWebhookEvent({
    provider: 'stripe', eventId: `evt_dp_${tag}`, eventType: type,
    signatureVerified: true,
    payload: {
      id: `evt_dp_${tag}`, type, created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: `dp_${tag}`, object: 'dispute', charge: chargeId,
        amount: PERIOD_MINOR, status,
      } },
    },
  });
  await drain();
}

const eventsNamed = (name: string) =>
  query<{ id: string }>(`SELECT id FROM analytics_events WHERE name = ?`, [name]);

describe('a disputed subscription period', () => {
  it('keeps its credits while the dispute is merely open', async () => {
    const user = await h.createUser();
    const { chargeId } = await subscribedWithOnePaidPeriod(user, 'open');

    await dispute('charge.dispute.created', chargeId, 'needs_response', 'open');
    // We may still win. Taking the credits now would punish someone who has
    // done nothing wrong yet.
    expect((await balanceOf(user.id)).available).toBe(planUnits);
    expect(await eventsNamed('payment_disputed')).toHaveLength(1);
  });

  it('loses them when the dispute is lost, because the money is gone', async () => {
    const user = await h.createUser();
    const { chargeId } = await subscribedWithOnePaidPeriod(user, 'lost');

    await dispute('charge.dispute.created', chargeId, 'needs_response', 'lostopen');
    await dispute('charge.dispute.closed', chargeId, 'lost', 'lost');
    expect((await balanceOf(user.id)).available).toBe(0);
  });

  it('keeps them when the dispute is won, because the money stayed', async () => {
    const user = await h.createUser();
    const { chargeId } = await subscribedWithOnePaidPeriod(user, 'won');

    await dispute('charge.dispute.created', chargeId, 'needs_response', 'wonopen');
    await dispute('charge.dispute.closed', chargeId, 'won', 'won');
    expect((await balanceOf(user.id)).available).toBe(planUnits);
  });

  it('tells an operator either way a dispute closes', async () => {
    const user = await h.createUser();
    const { chargeId } = await subscribedWithOnePaidPeriod(user, 'tell');
    await dispute('charge.dispute.closed', chargeId, 'lost', 'tell');
    // Money moving without anyone being told is how the original dispute
    // handler went unnoticed in the first place.
    expect((await eventsNamed('payment_disputed')).length).toBeGreaterThan(0);
  });

  it('revokes once however many times the close is delivered', async () => {
    const user = await h.createUser();
    const { chargeId } = await subscribedWithOnePaidPeriod(user, 'dup');
    await dispute('charge.dispute.closed', chargeId, 'lost', 'dup');
    const after = (await balanceOf(user.id)).available;
    await dispute('charge.dispute.closed', chargeId, 'lost', 'dup2');
    expect((await balanceOf(user.id)).available).toBe(after);
  });
});
