import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AppError,
  cancelSubscriptionRequest,
  createCheckoutRequest,
} from '@yuha/contracts';
import { listOrders, recordWebhookEvent, listPayments } from '@yuha/db';
import { SimulatedPaymentsAdapter } from '@yuha/providers';
import type { AppContext } from '../context.js';
import { STRIPE_WEBHOOK_PATHS, STRIPE_WEBHOOK_PRIMARY_PATH } from '../webhook-paths.js';
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
        displayName: o.display_name,
        priceVersion: o.price_version,
        kind: o.kind,
        amountMinor: o.amount_minor,
        currency: o.currency,
        status: o.status,
        entitlementGranted: o.entitlement_granted_at !== null,
        heldForReview: o.held_for_review,
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
        amountMinor: p.amount_minor,
        feeMinor: p.fee_minor,
        netMinor: p.net_minor,
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
   * POST /api/webhooks/stripe, and POST /v1/webhooks/stripe
   *
   * PAY-04: the signature is verified over the RAW body with the endpoint's own
   * secret. A forged, stale or malformed signature changes nothing — the event
   * is stored as unverified and never processed. Verified events are persisted
   * and acknowledged immediately; the worker does the work asynchronously so a
   * slow handler cannot cause provider-side retries (§4.2).
   *
   * Both paths, one handler, from `STRIPE_WEBHOOK_PATHS`. `/api/...` is what
   * the live endpoint posts to; `/v1/...` is what the CLI forwarder and any
   * already-registered endpoint still post to. Neither redirects to the other
   * — Stripe's retry would carry the signature of a body it re-sent — and
   * neither has its own copy of the verification or the dedupe.
   */
  const stripeWebhook = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
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
      /*
       * Recorded for audit, flagged unverified, never processed
       * (`claimWebhookEvents` requires `signature_verified = 1`).
       *
       * Bucketed to the minute rather than given a unique id per request.
       * This route is public and unauthenticated, and the global rate limit
       * is registered with `global: false` — a forged POST is rejected, but
       * the row it wrote was still a write, so anyone could grow this table
       * for as long as they cared to send requests. The minute bucket lets
       * the existing UNIQUE (provider, event_id) absorb the flood: the
       * second and later attempts in the same minute are a no-op insert.
       *
       * A rate limit on this route was the other option and was not taken:
       * Stripe bursts during a backfill, and throttling real deliveries to
       * bound an audit table is the wrong trade. Per-request detail stays in
       * the warn line above; the table keeps "probed during this minute".
       */
      await recordWebhookEvent({
        provider: 'stripe',
        eventId: `unverified:${new Date().toISOString().slice(0, 16)}`,
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
    //
    // Only after `recordWebhookEvent` has returned. If that insert throws, the
    // error plugin answers 5xx and Stripe redelivers — which is the behaviour
    // we want and the reason nothing is acknowledged before the row exists.
    return reply.status(200).send({ received: true, duplicate });
  };

  /*
   * Both paths, no route options.
   *
   * What used to sit here was `config: { rawBody: true }` and a
   * `preValidation` hook whose whole body was `void req`. Neither did
   * anything: `rawBody` is not a Fastify route-config key (`@fastify/raw-body`
   * is not installed), and the hook was a no-op with a comment saying the
   * parser was handled "below". The raw body arrives because
   * `keepsRawBody(req.url)` tells the content-type parser in `server.ts` to
   * hand the buffer through — that is the entire mechanism, and the two
   * decorations read as if it lived here.
   *
   * Worth removing rather than leaving: a future reader deciding whether a
   * third webhook path is safe would have found two settings that look like
   * the protection and one that is.
   */
  for (const path of STRIPE_WEBHOOK_PATHS) {
    app.post(
      path,
      {
        /*
         * A per-IP ceiling, two orders of magnitude above anything Stripe
         * does.
         *
         * The comment that used to sit here rejected a rate limit because
         * "Stripe bursts during a backfill", and throttling real deliveries to
         * bound an audit table would indeed be the wrong trade. But the
         * unverified row is minute-bucketed, so the table was never what
         * needed bounding — the WORK was. Every forged POST still runs an HMAC
         * over up to a megabyte, an INSERT and a SELECT, on a ten-connection
         * pool, from an unauthenticated public path with no limiter of any
         * kind (`rateLimit` is registered `global: false`). That is an API
         * anyone can take down.
         *
         * 600 a minute per IP: Stripe's heaviest backfill is far below it,
         * and it arrives from a handful of addresses. `trustProxy` is set, so
         * `req.ip` is the client rather than the load balancer.
         */
        config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      },
      stripeWebhook,
    );
  }

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
        // The operations path, deliberately: every purchase this suite drives
        // then travels the URL the live endpoint posts to, rather than proving
        // the old one works and leaving the new one untried. (The three
        // signature-rejection cases in tests/payments.test.ts still post to
        // /v1 directly, on purpose — they are about that path.)
        url: STRIPE_WEBHOOK_PRIMARY_PATH,
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
