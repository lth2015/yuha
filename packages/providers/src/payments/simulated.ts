import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  CheckoutParams,
  CheckoutSession,
  PaymentsAdapter,
  VerifiedWebhook,
} from './types.js';

interface SimSession {
  sessionId: string;
  orderId: string;
  userId: string;
  amountMinor: number;
  currency: string;
  kind: 'one_time' | 'subscription';
  customerId: string;
  subscriptionId: string | null;
  paymentIntentId: string;
  paymentStatus: 'unpaid' | 'paid';
  status: 'open' | 'complete' | 'expired';
  createdAt: Date;
}

/**
 * Simulated payments for demo mode.
 *
 * It moves no money and issues no commercial commitment (§3.1). It exists so
 * the *downstream* logic — order state, webhook verification, idempotent
 * entitlement grants — runs on exactly the same code path as Stripe: events it
 * produces are signed and go through the same verify → persist → process
 * pipeline. The config layer refuses to construct this adapter in production
 * mode (SEC-03).
 */
export class SimulatedPaymentsAdapter implements PaymentsAdapter {
  readonly kind = 'simulated';
  readonly realCharges = false;
  private readonly sessions = new Map<string, SimSession>();
  private readonly secret: string;
  private readonly checkoutBaseUrl: string;

  constructor(params: { signingSecret: string; checkoutBaseUrl: string }) {
    this.secret = params.signingSecret;
    this.checkoutBaseUrl = params.checkoutBaseUrl;
  }

  async createCheckout(params: CheckoutParams): Promise<CheckoutSession> {
    const sessionId = `cs_sim_${randomUUID().replace(/-/g, '')}`;
    const session: SimSession = {
      sessionId,
      orderId: params.orderId,
      userId: params.userId,
      amountMinor: params.amountMinor,
      currency: params.currency,
      kind: params.kind,
      customerId: params.existingCustomerId ?? `cus_sim_${params.userId.slice(0, 8)}`,
      subscriptionId: params.kind === 'subscription' ? `sub_sim_${randomUUID().slice(0, 12)}` : null,
      paymentIntentId: `pi_sim_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      paymentStatus: 'unpaid',
      status: 'open',
      createdAt: new Date(),
    };
    this.sessions.set(sessionId, session);

    const url = new URL(this.checkoutBaseUrl);
    url.searchParams.set('session_id', sessionId);
    url.searchParams.set('order_id', params.orderId);
    url.searchParams.set('amount', String(params.amountMinor));
    // Without this the demo confirmation screen had no currency to format
    // with and fell back to USD, printing $49.80 for a 4,980-yen plan.
    url.searchParams.set('currency', params.currency);
    return { sessionId, url: url.toString(), customerId: session.customerId, simulated: true };
  }

  /** Drives the simulated session forward; called by the demo-only API route. */
  settle(sessionId: string, outcome: 'paid' | 'failed'): SimSession | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    if (outcome === 'paid') {
      s.paymentStatus = 'paid';
      s.status = 'complete';
    } else {
      s.status = 'expired';
    }
    return s;
  }

  getSession(sessionId: string): SimSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Signs a synthetic event with the same scheme shape the verifier expects. */
  signPayload(rawBody: Buffer): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const mac = createHmac('sha256', this.secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
    return `t=${timestamp},v1=${mac}`;
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): VerifiedWebhook {
    if (!signatureHeader) return { verified: false, event: null, error: 'missing signature header' };
    const parts = Object.fromEntries(
      signatureHeader.split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return [k?.trim() ?? '', v?.trim() ?? ''];
      }),
    );
    const t = Number.parseInt(parts['t'] ?? '', 10);
    const v1 = parts['v1'] ?? '';
    if (!Number.isFinite(t) || !v1) return { verified: false, event: null, error: 'malformed signature' };
    // Reject stale signatures, mirroring Stripe's tolerance window.
    if (Math.abs(Date.now() / 1000 - t) > 300) {
      return { verified: false, event: null, error: 'signature timestamp outside tolerance' };
    }
    const expected = createHmac('sha256', this.secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(v1, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { verified: false, event: null, error: 'signature mismatch' };
    }
    let parsed: { id?: string; type?: string; created?: number };
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { verified: false, event: null, error: 'body is not JSON' };
    }
    if (!parsed.id || !parsed.type) {
      return { verified: false, event: null, error: 'event is missing id or type' };
    }
    return {
      verified: true,
      event: {
        id: parsed.id,
        type: parsed.type,
        createdAt: new Date((parsed.created ?? Math.floor(Date.now() / 1000)) * 1000),
        raw: JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>,
      },
    };
  }

  async retrieveCheckoutSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return {
      status: s.status,
      paymentStatus: s.paymentStatus,
      paymentIntentId: s.paymentIntentId,
      subscriptionId: s.subscriptionId,
      customerId: s.customerId,
      amountTotal: s.amountMinor,
      currency: s.currency,
    };
  }

  async retrieveSubscription(subscriptionId: string) {
    const s = [...this.sessions.values()].find((x) => x.subscriptionId === subscriptionId);
    if (!s) return null;
    const start = s.createdAt;
    const end = new Date(start.getTime() + 30 * 86400_000);
    return {
      status: s.paymentStatus === 'paid' ? 'active' : 'incomplete',
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      customerId: s.customerId,
      priceId: null,
      latestInvoiceId: `in_sim_${s.sessionId.slice(-8)}`,
    };
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string) {
    const sub = await this.retrieveSubscription(subscriptionId);
    return { cancelAtPeriodEnd: true, effectiveAt: sub?.currentPeriodEnd ?? null };
  }
}
