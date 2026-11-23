import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, type UserRole } from '@yuha/contracts';
import { findByExternalId, getEnabledMfaFactor, type UserRow } from '@yuha/db';
import type { AuthAdapter } from '../auth/index.js';
import { GUEST_PROVIDER } from '../auth/guest.js';
import type { SessionTokenIssuer } from '../auth/tokens.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * A trial without an account may use this route (docs/GROWTH_SPEC.md,
     * part three). Absent means no: every route refuses a guest unless it says
     * otherwise, so a new route is closed to guests until somebody decides.
     */
    guestAllowed?: boolean;
  }
  interface FastifyRequest {
    /** Populated by `requireAuth`; absent on public routes. */
    user?: UserRow;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Sets `req.user` when a valid bearer token is present; never rejects. */
    optionalAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (roles: UserRole[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAgeConfirmed: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async function authPlugin(
  app: FastifyInstance,
  opts: { adapter: AuthAdapter; adminMfaRequired: boolean; guests?: SessionTokenIssuer | null },
) {
  const { adapter } = opts;

  /** A guest's session, or null when the token is not one (it may be an account's). */
  async function guestFor(token: string): Promise<UserRow | null> {
    const claims = opts.guests?.verify(token, GUEST_PROVIDER);
    if (!claims) return null;
    const user = await findByExternalId(GUEST_PROVIDER, claims.sub);
    if (!user || user.role !== 'guest' || user.status !== 'active' || user.deleted_at) {
      throw new AppError('UNAUTHENTICATED', 'this trial has ended');
    }
    return user;
  }

  async function verify(token: string): Promise<UserRow> {
    return (await guestFor(token)) ?? adapter.verify(token);
  }

  function refuseGuestHere(req: FastifyRequest, user: UserRow): void {
    if (user.role === 'guest' && req.routeOptions.config.guestAllowed !== true) {
      throw new AppError('FORBIDDEN', 'sign up to use this');
    }
  }

  app.decorateRequest('user', undefined);

  app.decorate('requireAuth', async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHENTICATED', 'a bearer token is required');
    }
    const user = await verify(header.slice('Bearer '.length).trim());
    refuseInactive(user);
    refuseGuestHere(req, user);
    req.user = user;
  });

  /**
   * For routes a visitor with no account may read (a published song's page).
   * A missing, invalid or expired token, or an inactive account, leaves the
   * request anonymous rather than failing it: the reader still gets what
   * anyone may see, and nothing an account would add.
   */
  app.decorate('optionalAuth', async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    try {
      const user = await verify(header.slice('Bearer '.length).trim());
      // A guest reads a public page as anyone does, and its own song as its owner.
      if (user.status === 'active' && !user.deleted_at) req.user = user;
    } catch {
      /* treated as anonymous */
    }
  });

  /**
   * Role gate for the operations console. Roles come from our own users table,
   * never from a token claim, so an IdP attribute cannot escalate (SEC-02).
   */
  app.decorate('requireRole', (roles: UserRole[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(req, reply);
    if (!(roles as readonly string[]).includes(req.user!.role)) {
      throw new AppError('FORBIDDEN', 'insufficient privileges');
    }
    /*
     * A second factor, checked at the gate rather than at sign-in.
     *
     * Enforcing it here means an account that is GIVEN a staff role later
     * cannot use the console until it enrols — where a login-time check would
     * have let an already-open session straight through. The way out is open:
     * enrolment is an ordinary authenticated route, so a locked-out admin can
     * still set up their authenticator and come back.
     */
    if (opts.adminMfaRequired) {
      const factor = await getEnabledMfaFactor(req.user!.id);
      if (!factor) {
        throw new AppError('MFA_REQUIRED', 'staff accounts need two-factor authentication — enrol first');
      }
      /*
       * And this session presented it — after the factor it presented was set
       * up. Asking only whether the account had a factor let a session copied
       * before the admin enrolled into the console the moment they did, and a
       * factor set up again would not retire sessions verified against the
       * old one (security review YSEC02).
       */
      if (adapter.sessionMfaAt) {
        const at = adapter.sessionMfaAt(req.headers.authorization!.slice('Bearer '.length).trim());
        const since = factor.confirmed_at ? Math.floor(factor.confirmed_at.getTime() / 1000) : Infinity;
        if (at === null || at < since) {
          throw new AppError('MFA_REQUIRED', 'sign in again with your second factor to use the console');
        }
      }
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

/**
 * The one test for "may this account act at all", used by every request and
 * by every place a session is minted (dev login, the Google exchange, the MFA
 * verify). Sign-in used to skip it, so a suspended person signed in
 * successfully and then watched every screen fail.
 */
export function refuseInactive(user: { status: string; deleted_at: Date | null }): void {
  if (user.deleted_at || user.status === 'deleted') {
    throw new AppError('FORBIDDEN', 'this account is not active');
  }
  if (user.status === 'suspended') {
    throw new AppError('ACCOUNT_SUSPENDED', 'this account has been suspended');
  }
  if (user.status !== 'active') {
    throw new AppError('FORBIDDEN', 'this account is not active');
  }
}
