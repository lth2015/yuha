import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, type UserRole } from '@yuha/contracts';
import type { UserRow } from '@yuha/db';
import type { AuthAdapter } from '../auth/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `requireAuth`; absent on public routes. */
    user?: UserRow;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (roles: UserRole[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAgeConfirmed: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async function authPlugin(app: FastifyInstance, opts: { adapter: AuthAdapter }) {
  const { adapter } = opts;

  app.decorateRequest('user', undefined);

  app.decorate('requireAuth', async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHENTICATED', 'a bearer token is required');
    }
    const user = await adapter.verify(header.slice('Bearer '.length).trim());
    if (user.status !== 'active' || user.deleted_at) {
      throw new AppError('FORBIDDEN', 'this account is not active');
    }
    req.user = user;
  });

  /**
   * Role gate for the operations console. Roles come from our own users table,
   * never from a token claim, so an IdP attribute cannot escalate (SEC-02).
   */
  app.decorate('requireRole', (roles: UserRole[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(req, reply);
    if (!roles.includes(req.user!.role)) {
      throw new AppError('FORBIDDEN', 'insufficient privileges');
    }
  });

  /** Generation and purchase are limited to confirmed 18+ accounts. */
  app.decorate('requireAgeConfirmed', async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(req, reply);
    if (!req.user!.age_confirmed_at) {
      throw new AppError('AGE_NOT_CONFIRMED', '18歳以上であることの確認が必要です');
    }
  });
});
