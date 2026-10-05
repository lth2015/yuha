import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { issueWalletChallenge, verifyWalletChallenge } from '../services/stablecoin-wallet.js';

/**
 * Stablecoin payment routes, on /v1 like every other route in this server —
 * the specification wrote /api, which this repository has never used.
 *
 * Only the wallet-identity pair exists so far. Quote, prepare, transaction and
 * status arrive with the code behind them; a route that answers before its
 * logic is written is a declared capability with nothing underneath, which is
 * the defect this project keeps catching in its own work.
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
}
