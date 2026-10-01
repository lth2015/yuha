import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError, type UserRole } from '@yuha/contracts';
import { findByExternalId, upsertUser, type UserRow } from '@yuha/db';
import type { AppConfig } from '../config.js';
import { SessionTokenIssuer } from './tokens.js';

export interface AuthPrincipal {
  userId: string;
  email: string;
  role: UserRole;
  ageConfirmed: boolean;
  /** Which adapter authenticated this request; recorded in audit entries. */
  authProvider: string;
}

export interface AuthAdapter {
  readonly kind: string;
  /** Verifies a bearer token and returns the local user. */
  verify(token: string): Promise<UserRow>;
}

/**
 * Cognito adapter (SEC-02).
 *
 * Checks the signature against the pool's JWKS, plus issuer, audience/client
 * binding, expiry and token *use*: an access token is not accepted where an id
 * token is expected. Role is never read from the token — it comes from our own
 * users table, so an IdP attribute cannot escalate privilege.
 */
export class CognitoAuthAdapter implements AuthAdapter {
  readonly kind = 'cognito';
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly clientId: string;

  constructor(params: { region: string; userPoolId: string; appClientId: string }) {
    this.issuer = `https://cognito-idp.${params.region}.amazonaws.com/${params.userPoolId}`;
    this.clientId = params.appClientId;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async verify(token: string): Promise<UserRow> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        algorithms: ['RS256'],
        clockTolerance: 30,
      }));
    } catch (err) {
      throw new AppError('UNAUTHENTICATED', `token verification failed: ${(err as Error).message}`);
    }

    if (payload['token_use'] !== 'id') {
      throw new AppError('UNAUTHENTICATED', 'an id token is required for this API');
    }
    // Application binding: the token must have been issued for our app client.
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(this.clientId) : aud === this.clientId;
    if (!audOk) throw new AppError('UNAUTHENTICATED', 'token audience does not match the app client');

    const sub = payload.sub;
    const email = payload['email'];
    if (typeof sub !== 'string' || typeof email !== 'string') {
      throw new AppError('UNAUTHENTICATED', 'token is missing sub or email');
    }
    if (payload['email_verified'] === false) {
      throw new AppError('UNAUTHENTICATED', 'email address is not verified');
    }
    /*
     * Cognito still creates here, and that is a known hole with the same shape
     * as the dev one fixed above: an erased user's unexpired id token would
     * re-create them. It cannot simply be removed — there is no Cognito login
     * route, so this call IS first contact for a new user, and refusing would
     * lock out everyone who has never used the API before.
     *
     * Closing it properly needs a record of which subjects have been erased
     * (a hash, not the subject itself), checked here before creating. That is
     * a schema change and is written up in docs/OPEN_ITEMS.md rather than
     * invented at speed. Cognito is not the adapter any deployed environment
     * runs today — the trial build uses dev — so the live exposure is the one
     * above.
     */
    return upsertUser({ authProvider: 'cognito', externalId: sub, email });
  }
}

/**
 * Development identity for demo mode.
 *
 * Issues an HMAC-signed opaque session via the shared token issuer, so the
 * local flow exercises real bearer auth rather than a "pretend I am user X"
 * header. `loadConfig` refuses to construct this in production (SEC-03), and
 * every user it creates is stored with auth_provider = 'dev', keeping the two
 * identity spaces permanently distinguishable.
 */
export class DevAuthAdapter implements AuthAdapter {
  readonly kind = 'dev';
  private readonly issuer: SessionTokenIssuer;

  constructor(params: { secret: string; ttlSeconds?: number }) {
    this.issuer = new SessionTokenIssuer(params.secret, params.ttlSeconds);
  }

  issue(params: { externalId: string; email: string }): { token: string; expiresAt: Date } {
    return this.issuer.issue({ provider: 'dev', externalId: params.externalId, email: params.email });
  }

  async verify(token: string): Promise<UserRow> {
    const claims = this.issuer.verify(token, 'dev');
    if (!claims) throw new AppError('UNAUTHENTICATED', 'invalid or expired dev session token');

    /*
     * Look up only. Creating here undoes an erasure.
     *
     * This used to fall through to `upsertUser`, which looked harmless: the
     * dev-login route upserts before it issues a token, so the row always
     * exists for a real session. It is reachable in exactly one case — the row
     * is gone — and that case is account deletion. `anonymiseUser` rotates
     * `external_id` so a later sign-in starts a fresh account, which means the
     * lookup above misses, which means the fall-through would INSERT a new
     * active user carrying the email out of the still-valid token. Tokens last
     * seven days, so for a week after an erasure the person's own browser
     * would write their address back and keep its API access.
     *
     * `GoogleSessionAdapter` below has always done it this way, with the
     * reason in its comment. Dev now agrees with it.
     */
    const existing = await findByExternalId('dev', claims.sub);
    if (!existing) throw new AppError('UNAUTHENTICATED', 'session no longer maps to an account');
    return existing;
  }
}

/**
 * Session side of the Google adapter: the OAuth dance lives in ./google.ts and
 * the auth routes; this part turns the session token minted at the end of it
 * back into a user row. No auto-create on verify — a deleted Google account's
 * session dies with the row.
 */
export class GoogleSessionAdapter implements AuthAdapter {
  readonly kind = 'google';
  private readonly issuer: SessionTokenIssuer;

  constructor(params: { secret: string }) {
    this.issuer = new SessionTokenIssuer(params.secret);
  }

  sessionIssuer(): SessionTokenIssuer {
    return this.issuer;
  }

  async verify(token: string): Promise<UserRow> {
    const claims = this.issuer.verify(token, 'google');
    if (!claims) throw new AppError('UNAUTHENTICATED', 'invalid or expired session token');
    const user = await findByExternalId('google', claims.sub);
    if (!user) throw new AppError('UNAUTHENTICATED', 'session no longer maps to an account');
    return user;
  }
}

export function createAuthAdapter(cfg: AppConfig): AuthAdapter {
  switch (cfg.adapters.auth) {
    case 'cognito':
      return new CognitoAuthAdapter({
        region: cfg.COGNITO_REGION!,
        userPoolId: cfg.COGNITO_USER_POOL_ID!,
        appClientId: cfg.COGNITO_APP_CLIENT_ID!,
      });
    case 'google':
      return new GoogleSessionAdapter({ secret: googleSessionSecret(cfg) });
    default:
      return new DevAuthAdapter({ secret: cfg.DEV_AUTH_SECRET! });
  }
}

/**
 * Google sessions are signed with the same class of secret as dev sessions.
 * A deployment that has not set one refuses to boot rather than signing with
 * a default value.
 */
export function googleSessionSecret(cfg: AppConfig): string {
  const secret = cfg.GOOGLE_SESSION_SECRET ?? cfg.DEV_AUTH_SECRET;
  if (!secret) {
    throw new AppError(
      'SERVICE_DISABLED',
      'GOOGLE_SESSION_SECRET (or DEV_AUTH_SECRET outside production) is required for google auth',
    );
  }
  return secret;
}

export { GoogleAuthAdapter, isGoogleConfigured } from './google.js';
export { SessionTokenIssuer } from './tokens.js';
