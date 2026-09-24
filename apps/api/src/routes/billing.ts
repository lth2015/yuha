import type { FastifyInstance } from 'fastify';
import {
  AppError,
  cancelSubscriptionRequest,
  createCheckoutRequest,
} from '@yuha/contracts';
import { listOrders, recordWebhookEvent, listPayments } from '@yuha/db';
import { SimulatedPaymentsAdapter } from '@yuha/providers';
import type { AppContext } from '../context.js';
import {
  cancelSubscription,
  createCheckout,
  getEntitlements,
  getOrderView,
  listProducts,
  toJst,
} from '../services/billing.js';

export default async function billingRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  /** Public price list. Amounts are tax-inclusive JPY from the server catalogue. */
  app.get('/v1/products', async () => ({ items: await listProducts(ctx) }));

  app.post('/v1/checkout', { preHandler: app.requireAgeConfirmed }, async (req) => {
    const body = createCheckoutRequest.parse(req.body);
    const result = await createCheckout(ctx, {
      userId: req.user!.id,
      priceKey: body.priceKey,
      idempotencyKey: body.idempotencyKey,
      ...(body.successPath ? { successPath: body.successPath } : {}),
      ...(body.cancelPath ? { cancelPath: body.cancelPath } : {}),
    });
    return result;
  });

  app.get('/v1/orders/:id', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return getOrderView(req.user!.id, id);
  });

  app.get('/v1/orders', { preHandler: app.requireAuth }, async (req) => {
    const rows = await listOrders(req.user!.id);
    return {
      items: rows.map((o) => ({
        orderId: o.id,
        priceKey: o.price_key,
        priceVersion: o.price_version,
        kind: o.kind,
        amountMinor: o.amount_jpy,
        currency: o.currency,
        status: o.status,
        entitlementGranted: o.entitlement_granted_at !== null,
        createdAt: o.created_at.toISOString(),
        createdAtJst: toJst(o.created_at),
        paidAt: o.paid_at?.toISOString() ?? null,
        receiptUrl: o.receipt_url,
      })),
    };
  });

  /** Payment / fee / refund breakdown for one order (PAY-11). */
  app.get('/v1/orders/:id/payments', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    await getOrderView(req.user!.id, id); // ownership check
    const rows = await listPayments(id);
    return {
      items: rows.map((p) => ({
        kind: p.kind,
        amountMinor: p.amount_jpy,
        feeJpy: p.fee_jpy,
        netJpy: p.net_jpy,
        status: p.status,
        occurredAt: p.occurred_at.toISOString(),
      })),
    };
  });

  app.get('/v1/entitlements', { preHandler: app.requireAuth }, async (req) =>
    getEntitlements(req.user!.id),
  );

  app.post('/v1/subscription/cancel', { preHandler: app.requireAuth }, async (req) => {
    const body = cancelSubscriptionRequest.parse(req.body);
    return cancelSubscription(ctx, {
      userId: req.user!.id,
      subscriptionId: body.subscriptionId,
      idempotencyKey: body.idempotencyKey,
    });
  });

  /**
   * POST /v1/webhooks/stripe
   *
   * PAY-04: the signature is verified over the RAW body with the endpoint's own
   * secret. A forged, stale or malformed signature changes nothing — the event
   * is stored as unverified and never processed. Verified events are persisted
   * and acknowledged immediately; the worker does the work asynchronously so a
   * slow handler cannot cause provider-side retries (§4.2).
   */
  app.post(
    '/v1/webhooks/stripe',
    {
      config: { rawBody: true },
      // The raw body is required for signature verification, so the JSON parser
      // is bypassed for this route only.
      preValidation: async (req) => {
        // handled by the content type parser below
        void req;
      },
    },
    async (req, reply) => {
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw)) {
        throw new AppError('WEBHOOK_SIGNATURE_INVALID', 'raw body was not preserved');
      }
      const signature = req.headers['stripe-signature'];
      const result = ctx.payments.verifyWebhook(
        raw,
        Array.isArray(signature) ? signature[0] : signature,
      );

      if (!result.verified || !result.event) {
        req.log.warn({ reason: result.error }, 'rejected webhook with invalid signature');
        // Recorded for audit, flagged unverified, never processed.
        await recordWebhookEvent({
          provider: 'stripe',
          eventId: `unverified:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
          eventType: 'unverified',
          signatureVerified: false,
          payload: { reason: result.error ?? 'unknown' },
        });
        return reply.status(400).send({
          error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'signature verification failed' },
        });
      }

      const { duplicate } = await recordWebhookEvent({
        provider: 'stripe',
        eventId: result.event.id,
        eventType: result.event.type,
        signatureVerified: true,
        payload: result.event.raw,
      });

      // Acknowledge fast; the outbox worker picks it up.
      return reply.status(200).send({ received: true, duplicate });
    },
  );

  /**
   * Demo-only: drives a simulated checkout to a terminal state and emits a
   * signed synthetic event through the real webhook pipeline, so the demo
   * exercises the same verification and grant code as Stripe.
   */
  if (ctx.payments instanceof SimulatedPaymentsAdapter) {
    const sim = ctx.payments;
    app.post('/v1/dev/simulate-payment', { preHandler: app.requireAuth }, async (req) => {
      if (ctx.config.mode === 'production') {
        throw new AppError('FORBIDDEN', 'simulated payments do not exist in production');
      }
      const body = req.body as { sessionId?: string; outcome?: 'paid' | 'failed' };
      if (!body.sessionId) throw new AppError('VALIDATION_FAILED', 'sessionId is required');

      const session = sim.settle(body.sessionId, body.outcome ?? 'paid');
      if (!session) throw new AppError('NOT_FOUND', 'unknown simulated session');

      const event = {
        id: `evt_sim_${body.sessionId.slice(-16)}_${body.outcome ?? 'paid'}`,
        type:
          (body.outcome ?? 'paid') === 'paid'
            ? 'checkout.session.completed'
            : 'checkout.session.async_payment_failed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: session.sessionId,
            object: 'checkout.session',
            client_reference_id: session.orderId,
            payment_status: session.paymentStatus,
            status: session.status,
            amount_total: session.amountMinor,
            currency: session.currency,
            customer: session.customerId,
            payment_intent: session.paymentIntentId,
            subscription: session.subscriptionId,
            metadata: { order_id: session.orderId, user_id: session.userId },
          },
        },
      };
      const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/stripe',
        payload: rawBody,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': sim.signPayload(rawBody),
        },
      });
      return { delivered: res.statusCode === 200, statusCode: res.statusCode };
    });
  }
}
