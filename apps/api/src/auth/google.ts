import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError } from '@yuha/contracts';
import { findByExternalId, upsertUser, type UserRow } from '@yuha/db';
import type { AuthAdapter } from './index.js';
import { GOOGLE_WEB_RETURN_PATH } from './google-paths.js';

/**
 * "Sign in with Google" adapter (SEC-02 heritage).
 *
 * Flow (authorization code + PKCE):
 *   1. SPA → GET /v1/auth/google/start
 *        issues `state` and `code_verifier` into short-lived HttpOnly cookies,
 *        302s to Google's consent screen.
 *   2. Google → GET /v1/auth/google/callback?code&state
 *        compares state, exchanges the code at Google's token endpoint using
 *        the PKCE verifier, then verifies the returned id_token against
 *        Google's JWKS (issuer + audience + expiry; signature, not claim trust).
 *   3. The API upserts the local user (auth_provider='google', external_id=sub)
 *        and redirects the SPA to /auth/google/callback?code=<one-time code>.
 *   4. SPA → POST /v1/auth/google/exchange {code} → { token, user }.
 *
 * Privilege never comes from Google: the role lives in our users table, exactly
 * like the Cognito adapter.
 */
export interface GoogleAdapterOptions {
  clientId: string;
  clientSecret: string;
  /** Must be registered in the Google Cloud console, verbatim. */
  redirectUri: string;
  /** Public web origin the callback redirects back into. */
  webOrigin: string;
}

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export class GoogleAuthAdapter implements AuthAdapter {
  readonly kind = 'google';
  private readonly jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

  constructor(private readonly opts: GoogleAdapterOptions) {}

  async verify(token: string): Promise<UserRow> {
    // verify() is only reached with session tokens this API issued itself; the
    // Google ID token is verified inside the callback exchange instead.
    throw new AppError('UNAUTHENTICATED', 'google adapter does not verify bearer tokens directly');
  }

  authorizationUrl(state: string, codeChallenge: string): string {
    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set('client_id', this.opts.clientId);
    url.searchParams.set('redirect_uri', this.opts.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  callbackRedirect(oneTimeCode: string): string {
    // The SPA's path, not the one Google was given. See google-paths.ts.
    const url = new URL(GOOGLE_WEB_RETURN_PATH, this.opts.webOrigin);
    url.searchParams.set('code', oneTimeCode);
    return url.toString();
  }

  /**
   * Exchanges the authorization code and returns the verified identity.
   * A failed exchange is a hard error: no user row is created on the basis of
   * an unverified token.
   */
  async exchangeCode(params: { code: string; codeVerifier: string }): Promise<GoogleIdentity> {
    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      code: params.code,
      grant_type: 'authorization_code',
      redirect_uri: this.opts.redirectUri,
      code_verifier: params.codeVerifier,
    });
    let tokenJson: { id_token?: string; error?: string; error_description?: string };
    try {
      const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      tokenJson = (await res.json()) as typeof tokenJson;
      if (!res.ok) {
        throw new AppError(
          'AUTH_EXCHANGE_FAILED',
          tokenJson.error_description ?? tokenJson.error ?? `google token endpoint returned ${res.status}`,
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('AUTH_EXCHANGE_FAILED', `google token endpoint unreachable: ${(err as Error).message}`);
    }
    if (!tokenJson.id_token) throw new AppError('AUTH_EXCHANGE_FAILED', 'google returned no id_token');

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(tokenJson.id_token, this.jwks, {
        issuer: GOOGLE_ISSUERS,
        audience: this.opts.clientId,
        algorithms: ['RS256'],
        clockTolerance: 30,
      }));
    } catch (err) {
      throw new AppError('UNAUTHENTICATED', `google id_token verification failed: ${(err as Error).message}`);
    }

    const sub = payload['sub'];
    const email = payload['email'];
    if (typeof sub !== 'string' || typeof email !== 'string') {
      throw new AppError('UNAUTHENTICATED', 'google id_token is missing sub or email');
    }
    if (payload['email_verified'] !== true) {
      throw new AppError('UNAUTHENTICATED', 'google email address is not verified');
    }
    return {
      sub,
      email,
      emailVerified: true,
      // Blank is absent. A name of "" passed the typeof check, was stored as
      // "" (the upsert's COALESCE only skips NULL), and crashed the header of
      // every page for that account. The web side now tolerates it too; this
      // stops it entering the database at all.
      name: typeof payload['name'] === 'string' && payload['name'].trim() ? payload['name'].trim() : null,
      picture: typeof payload['picture'] === 'string' ? payload['picture'] : null,
    };
  }

  /** Local user for a verified identity, created on first sight. */
  async toUser(identity: GoogleIdentity): Promise<UserRow> {
    const existing = await findByExternalId('google', identity.sub);
    if (existing) return existing;
    return upsertUser({
      authProvider: 'google',
      externalId: identity.sub,
      email: identity.email,
      displayName: identity.name,
      avatarUrl: identity.picture,
    });
  }
}

export function isGoogleConfigured(cfg: {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
}): boolean {
  return !!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.GOOGLE_REDIRECT_URI);
}
