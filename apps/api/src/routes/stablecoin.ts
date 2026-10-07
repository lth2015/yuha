import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@yuha/contracts';
import type { AppContext } from '../context.js';
import { listVerifiedWallets } from '@yuha/db';
import { toDisplayAddress } from '@yuha/providers';
import { issueWalletChallenge, verifyWalletChallenge } from '../services/stablecoin-wallet.js';
import {
  createStablecoinQuote,
  prepareStablecoinPayment,
  stablecoinPaymentStatus,
} from '../services/stablecoin.js';
import { settleReportedTransaction } from '../services/stablecoin-scan.js';
import {
  decideOrphanTransfer,
  decideStablecoinReview,
  stablecoinAccountingCsv,
  stablecoinReviewQueue,
} from '../services/stablecoin-admin.js';

/**
 * Stablecoin payment routes, on /v1 like every other route in this server —
 * the specification wrote /api, which this repository has never used.
 *
 * `stablecoin-transaction` (the client reporting a hash as a discovery hint)
 * and the admin review and export endpoints are not here yet: they need the
 * scanner and the RPC client to mean anything, and a route that answers before
 * its logic exists is a declared capability with nothing underneath.
 *
 * Every switch is off by default, so with default configuration all of these
 * answer SERVICE_DISABLED. That is the intended state until the business
 * conclusions in docs/STABLECOIN_V1_PLAN.md are in hand.
 */
export default async function stablecoinRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'not an Ethereum address');

  app.post(
    '/v1/payments/stablecoin/wallet-challenge',
    {
      preHandler: app.requireAuth,
      // Issuing a challenge is cheap for us and a signing prompt for the user;
      // a loose limit here is a way to spam somebody's wallet with popups.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = z
        .object({ address: addressSchema, chainId: z.number().int().positive() })
        .parse(req.body);
      const issued = await issueWalletChallenge(ctx, {
        userId: req.user!.id,
        chainId: body.chainId,
        address: body.address,
      });
      return { nonce: issued.nonce, message: issued.message, expiresAt: issued.expiresAt.toISOString() };
    },
  );

  app.post(
    '/v1/payments/stablecoin/wallet-verify',
    {
      preHandler: app.requireAuth,
      // Guessing a signature is not feasible, but a nonce is single-use and
      // this endpoint recovers a public key per call, so it is worth a cap.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = z
        .object({
          nonce: z.string().regex(/^[0-9a-f]{32}$/),
          address: addressSchema,
          signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
        })
        .parse(req.body);
      const wallet = await verifyWalletChallenge(ctx, {
        userId: req.user!.id,
        nonce: body.nonce,
        address: body.address,
        signature: body.signature,
      });
      return {
        address: wallet.address,
        chainId: wallet.chainId,
        verifiedAt: wallet.verifiedAt.toISOString(),
      };
    },
  );

  /**
   * The wallets this account has already proved control of.
   *
   * So the interface can tell "connect and pay" from "connect, sign, then
   * pay". Without it a page either asks for a SIWE signature before every
   * purchase — a wallet popup for something already established — or decides
   * by matching the text of an error message, which is not a protocol.
   *
   * Only the caller's own wallets, and nothing but what the caller already
   * told us: an address they signed for, the chain, and when.
   */
  app.get('/v1/payments/stablecoin/wallets', { preHandler: app.requireAuth }, async (req) => {
    const wallets = await listVerifiedWallets(req.user!.id);
    return {
      wallets: wallets.map((w) => ({
        address: toDisplayAddress(w.address),
        chainId: w.chain_id,
        verifiedAt: w.verified_at.toISOString(),
      })),
    };
  });

  app.post(
    '/v1/payments/stablecoin/quote',
    {
      preHandler: app.requireAgeConfirmed,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = z
        .object({
          priceKey: z.enum(['drop_5', 'market_license']),
          idempotencyKey: z.string().min(8).max(128),
          tokenKey: z.enum(['jpyc', 'usdc']),
          payer: addressSchema,
          trackId: z.string().uuid().optional(),
        })
        .parse(req.body);
      return createStablecoinQuote(ctx, {
        userId: req.user!.id,
        priceKey: body.priceKey,
        idempotencyKey: body.idempotencyKey,
        tokenKey: body.tokenKey,
        payer: body.payer,
        ...(body.trackId ? { trackId: body.trackId } : {}),
      });
    },
  );

  app.post(
    '/v1/orders/:id/stablecoin-prepare',
    { preHandler: app.requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const { id } = req.params as { id: string };
      return prepareStablecoinPayment(ctx, { userId: req.user!.id, orderId: id });
    },
  );

  app.post(
    '/v1/orders/:id/stablecoin-transaction',
    {
      preHandler: app.requireAuth,
      // Each call reads the chain, so it is capped; and there is nothing to
      // gain by hammering it, since the scanner finds the same payment anyway.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(req.body);

      /*
       * The order id is checked for ownership and is NOT used to attribute the
       * payment. Attribution comes from the open intent of the transaction's
       * own sender, so a hash copied off a block explorer resolves to that
       * sender's order or to nothing — never to whoever pasted it here.
       */
      const status = await stablecoinPaymentStatus({ userId: req.user!.id, orderId: id });

      if (!ctx.chain) throw new AppError('SERVICE_DISABLED', 'stablecoin payments are not available');
      const outcome = await settleReportedTransaction(ctx, ctx.chain, body.txHash);

      if (outcome.kind === 'not_found') {
        // 202: we looked, and there is nothing to act on yet. Not an error on
        // the customer's part, and not a promise that there never will be.
        return reply.code(202).send({ accepted: true, detail: outcome.reason, orderId: status.orderId });
      }
      return reply.send({ accepted: true, outcome: outcome.kind, orderId: status.orderId });
    },
  );

  app.get('/v1/orders/:id/payment-status', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return stablecoinPaymentStatus({ userId: req.user!.id, orderId: id });
  });

  // ----------------------------------------------------------------- console

  const staff = app.requireRole(['support', 'admin']);
  const adminOnly = app.requireRole(['admin']);

  /** Short, over, late and unattributed money, with the amounts side by side. */
  app.get('/v1/admin/stablecoin-payments', { preHandler: staff }, async () => stablecoinReviewQueue());

  app.post('/v1/admin/stablecoin-payments/:id/review', { preHandler: adminOnly }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        decision: z.enum(['accept_as_paid', 'reject']),
        reason: z.string().min(3).max(500),
      })
      .parse(req.body);
    return decideStablecoinReview({
      intentId: id,
      decision: body.decision,
      reason: body.reason,
      actorId: req.user!.id,
      actorRole: req.user!.role,
    });
  });

  /**
   * Attaching unattributed money to an order, or writing it off.
   *
   * Admin-only and reason-required, like every other money decision in the
   * console. This action is the repair path the design was missing: the
   * unattributed queue existed, with nothing able to act on it, while three
   * ordinary sequences put real payments in it permanently.
   */
  app.post('/v1/admin/stablecoin-transfers/:id/decide', { preHandler: adminOnly }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        decision: z.enum(['attach_to_order', 'dismiss']),
        orderId: z.string().uuid().optional(),
        reason: z.string().min(3).max(500),
      })
      .parse(req.body);
    return decideOrphanTransfer({
      orphanId: id,
      decision: body.decision,
      ...(body.orderId ? { orderId: body.orderId } : {}),
      reason: body.reason,
      actorId: req.user!.id,
      actorRole: req.user!.role,
    });
  });

  /**
   * The monthly reconciliation file. Staff rather than admin-only: reading
   * what was received is not the same authority as deciding a disputed
   * payment.
   */
  app.get('/v1/admin/accounting/stablecoin-export', { preHandler: staff }, async (req, reply) => {
    const q = z
      .object({ from: z.string().datetime(), to: z.string().datetime() })
      .parse(req.query);
    const csv = await stablecoinAccountingCsv({ from: new Date(q.from), to: new Date(q.to) });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="stablecoin-${q.from.slice(0, 10)}.csv"`)
      .send(csv);
  });
}
