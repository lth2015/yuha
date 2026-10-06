import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { issueWalletChallenge, verifyWalletChallenge } from '../services/stablecoin-wallet.js';
import {
  createStablecoinQuote,
  prepareStablecoinPayment,
  stablecoinPaymentStatus,
} from '../services/stablecoin.js';

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

  app.get('/v1/orders/:id/payment-status', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    return stablecoinPaymentStatus({ userId: req.user!.id, orderId: id });
  });
}
