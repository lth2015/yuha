import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-signed opaque session tokens, shared by every auth adapter that issues
 * local sessions (dev login and Google OAuth).
 *
 * Opaque rather than JWT on purpose: sessions are revocable-by-roll (the
 * signing secret is per-deployment), carry no claims a client could misread,
 * and verifying them never leaves the process.
 */
export interface SessionClaims {
  /** Which identity space the subject belongs to: 'dev' | 'google' | 'cognito'. */
  provider: string;
  sub: string;
  email: string;
  exp: number;
  nonce: string;
}

export class SessionTokenIssuer {
  constructor(private readonly secret: string, private readonly ttlSeconds = 7 * 24 * 3600) {}

  issue(params: { provider: string; externalId: string; email: string }): {
    token: string;
    expiresAt: Date;
  } {
    const exp = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const body = Buffer.from(
      JSON.stringify({
        provider: params.provider,
        sub: params.externalId,
        email: params.email,
        exp,
        nonce: randomBytes(8).toString('hex'),
      } satisfies SessionClaims),
      'utf8',
    ).toString('base64url');
    const sig = createHmac('sha256', this.secret).update(body).digest('base64url');
    return { token: `${body}.${sig}`, expiresAt: new Date(exp * 1000) };
  }

  /**
   * Verifies signature and expiry, returning the claims — or null for any
   * malformed, forged or expired input. `expectedProvider` rejects a token
   * minted by one identity space from being spent in another.
   */
  verify(token: string, expectedProvider?: string): SessionClaims | null {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = createHmac('sha256', this.secret).update(body).digest('base64url');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sig, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let claims: SessionClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaims;
    } catch {
      return null;
    }
    if (!claims.sub || !claims.email || !claims.exp) return null;
    if (claims.exp * 1000 < Date.now()) return null;
    if (expectedProvider && claims.provider !== expectedProvider) return null;
    return claims;
  }
}
