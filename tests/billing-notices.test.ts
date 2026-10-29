/**
 * Telling a customer about their refund and their plan, and asking for 3-D
 * Secure at checkout.
 *
 * A subscriber was refunded and had their plan cancelled, and received no
 * notice of either; they also noticed their card was charged without the
 * one-time password Japanese card payments usually ask for. What is pinned:
 * a refund sends one email with the right amounts however Stripe describes
 * it, a cancellation one, an ending one; none twice; none to a deleted
 * account; and every Checkout Session asks for 3DS on cards.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processWebhookEvent } from '@yuha/api';
import { claimWebhookEvents, getOrder, query, recordWebhookEvent, withTx } from '@yuha/db';
import { StripePaymentsAdapter, type EmailAdapter, type EmailMessage, type EmailResult } from '@yuha/providers';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

class RecordingEmail implements EmailAdapter {
  readonly kind = 'log' as const;
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return { delivered: true, id: 'test' };
  }
}

let h: Harness;
let mail: RecordingEmail;

beforeAll(async () => {
  h = await createHarness({ FEATURE_SUBSCRIPTIONS_ENABLED: 'true' });
});
beforeEach(async () => {
  await resetData();
  mail = new RecordingEmail();
  h.ctx.email = mail;
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

async function drainWebhooks(): Promise<void> {
  const events = await withTx(async (tx) => claimWebhookEvents(20, tx));
  for (const ev of events) await processWebhookEvent(h.ctx, ev);
}

async function event(type: string, id: string, object: Record<string, unknown>): Promise<void> {
  await recordWebhookEvent({
    provider: 'stripe',
    eventId: id,
    eventType: type,
    signatureVerified: true,
    payload: { id, type, created: Math.floor(Date.now() / 1000), data: { object } },
  });
  await drainWebhooks();
}

/** A DROP bought and paid through the real pipeline. */
async function buy(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/checkout',
    headers: user.authHeader,
    payload: { priceKey: 'drop_5', idempotencyKey: `idem_${Math.random().toString(36).slice(2)}` } as never,
  });
  const body = res.json() as { orderId: string; checkoutUrl: string };
  const sessionId = new URL(body.checkoutUrl).searchParams.get('session_id')!;
  await h.app.inject({ method: 'POST', url: '/v1/dev/simulate-payment', headers: user.authHeader, payload: { sessionId, outcome: 'paid' } as never });
  await drainWebhooks();
  return body.orderId;
}

async function chargeRefunded(orderId: string, cumulative: number, tag: string) {
  const order = (await getOrder(orderId))!;
  await event('charge.refunded', `evt_ch_${tag}`, {
    id: 'ch_one',
    object: 'charge',
    currency: 'jpy',
    payment_intent: order.stripe_payment_intent_id,
    amount: order.amount_minor,
    amount_refunded: cumulative,
    metadata: { order_id: orderId },
  });
}

async function refundCreated(orderId: string, amount: number, tag: string) {
  const order = (await getOrder(orderId))!;
  await event('refund.created', `evt_re_${tag}`, {
    id: `re_${tag}`,
    object: 'refund',
    currency: 'jpy',
    charge: 'ch_one',
    payment_intent: order.stripe_payment_intent_id,
    amount,
    metadata: { order_id: orderId },
  });
}

describe('a refund', () => {
  it('sends one notice, in Japanese, Chinese and English, with the amounts', async () => {
    const user = await h.createUser();
    const orderId = await buy(user);
    const paid = (await getOrder(orderId))!.amount_minor;
    await refundCreated(orderId, paid, 'full');
    await chargeRefunded(orderId, paid, 'full'); // the same refund, described again
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0]!;
    expect(m.to).toBe(user.email);
    const yen = `¥${paid.toLocaleString('en-US')}`;
    expect(m.text).toContain(yen);
    expect(m.text).toMatch(/返金/);
    expect(m.text).toMatch(/退款/);
    expect(m.text).toMatch(/refunded in full/);
  });

  it('sends one notice per partial refund, each with its own amount and the running total', async () => {
    const user = await h.createUser();
    const orderId = await buy(user);
    await chargeRefunded(orderId, 300, 'p1');
    await chargeRefunded(orderId, 500, 'p2');
    await chargeRefunded(orderId, 500, 'p2-again'); // redelivery of the same total
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[0]!.text).toContain('¥300');
    expect(mail.sent[1]!.text).toContain('¥200');
    expect(mail.sent[1]!.text).toContain('¥500');
  });

  it('is not sent to a deleted account', async () => {
    const user = await h.createUser();
    const orderId = await buy(user);
    await query(`UPDATE users SET status = 'deleted', deleted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [user.id]);
    await chargeRefunded(orderId, 300, 'gone');
    expect(mail.sent).toHaveLength(0);
  });
});

describe('a subscription', () => {
  const sub = (user: TestUser, over: Record<string, unknown>) => ({
    id: 'sub_notice',
    object: 'subscription',
    customer: 'cus_notice',
    status: 'active',
    cancel_at_period_end: false,
    current_period_start: Math.floor(Date.now() / 1000) - 86400,
    current_period_end: Math.floor(Date.UTC(2026, 10, 20, 3) / 1000),
    metadata: { user_id: user.id, price_key: 'pro_monthly' },
    ...over,
  });

  it('set to end at the close of its period sends one notice naming the last day, in Tokyo', async () => {
    const user = await h.createUser();
    await event('customer.subscription.created', 'evt_s1', sub(user, {}));
    expect(mail.sent).toHaveLength(0);
    await event('customer.subscription.updated', 'evt_s2', sub(user, { cancel_at_period_end: true }));
    await event('customer.subscription.updated', 'evt_s3', sub(user, { cancel_at_period_end: true }));
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.text).toContain('2026-11-20');
    expect(mail.sent[0]!.text).toMatch(/解約/);
    expect(mail.sent[0]!.text).toMatch(/订阅已取消/);
  });

  it('cancelled in the app and then confirmed by Stripe is still one notice', async () => {
    const user = await h.createUser();
    await event('customer.subscription.created', 'evt_a1', sub(user, {}));
    const [row] = await query<{ id: string }>(`SELECT id FROM subscriptions WHERE stripe_subscription_id = 'sub_notice'`);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/subscription/cancel',
      headers: user.authHeader,
      payload: { subscriptionId: row!.id, idempotencyKey: 'cancel-notice-1' } as never,
    });
    expect(res.statusCode).toBe(200);
    await event('customer.subscription.updated', 'evt_a2', sub(user, { cancel_at_period_end: true }));
    expect(mail.sent).toHaveLength(1);
  });

  it('that has ended sends one notice, however often Stripe says so', async () => {
    const user = await h.createUser();
    await event('customer.subscription.created', 'evt_d1', sub(user, {}));
    await event('customer.subscription.deleted', 'evt_d2', sub(user, { status: 'canceled' }));
    await event('customer.subscription.deleted', 'evt_d3', sub(user, { status: 'canceled' }));
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.text).toMatch(/終了/);
    expect(mail.sent[0]!.text).toMatch(/订阅已结束/);
  });
});

describe('checkout', () => {
  it('asks Stripe for 3-D Secure on every card payment, one-time and subscription', async () => {
    const adapter = new StripePaymentsAdapter({ secretKey: 'sk_test_notreal', webhookSecret: 'whsec_test' } as never);
    const seen: Array<Record<string, unknown>> = [];
    (adapter as unknown as { stripe: unknown }).stripe = {
      checkout: { sessions: { create: async (p: Record<string, unknown>) => { seen.push(p); return { id: 'cs_test', url: 'https://checkout.stripe.test/cs_test' }; } } },
    };
    for (const kind of ['one_time', 'subscription'] as const) {
      await adapter.createCheckout({
        orderId: 'o', userId: 'u', userEmail: 'a@example.test', priceKey: 'drop_5', priceVersion: 1,
        stripePriceId: 'price_x', kind, successUrl: 'https://yuha.studio/ok', cancelUrl: 'https://yuha.studio/no', idempotencyKey: `k-${kind}`,
      } as never);
    }
    expect(seen).toHaveLength(2);
    for (const p of seen) expect(p['payment_method_options']).toEqual({ card: { request_three_d_secure: 'any' } });
  });
});

/*
 * Review S2: the claim was kept whether or not the mail left. One SMTP
 * failure, and the second event for the same refund found it claimed.
 */
describe('a notice that did not go out', () => {
  it('is sent by the next attempt', async () => {
    const { noticeRefund } = await import('../apps/api/src/services/billing-notices.js');
    const user = await h.createUser({ email: 'retry-notice@example.jp' });
    let calls = 0;
    const sent: EmailMessage[] = [];
    h.ctx.email = {
      kind: 'smtp',
      async send(m: EmailMessage): Promise<EmailResult> {
        calls += 1;
        if (calls === 1) return { delivered: false, id: null };
        sent.push(m);
        return { delivered: true, id: 'ok' };
      },
    };
    const params = { userId: user.id, ref: 'ch_retry', amountMinor: 980, totalRefundedMinor: 980, paidMinor: 980, currency: 'jpy' };
    await noticeRefund(h.ctx, params);
    await noticeRefund(h.ctx, params);
    await noticeRefund(h.ctx, params);
    expect(calls).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it('is retried after the adapter throws, too', async () => {
    const { noticeRefund } = await import('../apps/api/src/services/billing-notices.js');
    const user = await h.createUser({ email: 'retry-notice2@example.jp' });
    let calls = 0;
    h.ctx.email = {
      kind: 'smtp',
      async send(): Promise<EmailResult> {
        calls += 1;
        if (calls === 1) throw new Error('smtp down');
        return { delivered: true, id: 'ok' };
      },
    };
    const params = { userId: user.id, ref: 'ch_retry2', amountMinor: 980, totalRefundedMinor: 980, paidMinor: 980, currency: 'jpy' };
    await noticeRefund(h.ctx, params);
    await noticeRefund(h.ctx, params);
    expect(calls).toBe(2);
  });
});

