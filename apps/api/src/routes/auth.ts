import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, type MeView } from '@yuha/contracts';
import {
  confirmAgeAndTerms,
  consumeAuthCode,
  getBalance,
  getUser,
  issueAuthCode,
  openAccountDeletion,
  setMarketingOptIn,
  trackEvent,
  upsertUser,
  type UserRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';
import {
  DevAuthAdapter,
  GoogleAuthAdapter,
  GoogleSessionAdapter,
  type AuthAdapter,
} from '../auth/index.js';
import { GOOGLE_CALLBACK_PATH } from '../auth/google-paths.js';
import { grantTrialIfEligible } from '../services/billing.js';
import {
  confirmMfa,
  disableMfa,
  enrollMfa,
  issueMfaChallenge,
  sessionIssuerFor,
  verifyMfaChallenge,
} from '../services/mfa.js';
import { noticeAccountChange, noticeSignIn } from '../services/notices.js';
import { devLoginAllowed, parseDevLoginAllowlist } from '../auth/allowlist.js';

const devLoginSchema = z.object({
  email: z.string().email(),
  /** UI-02: 18+ confirmation is explicit and separate from the terms checkbox. */
  ageConfirmed: z.literal(true),
  termsAccepted: z.literal(true),
  /** Defaults to false; the UI must never pre-check it. */
  marketingOptIn: z.boolean().default(false),
});

async function toMeView(u: UserRow): Promise<MeView> {
  const balance = await getBalance(u.id);
  return {
    userId: u.id,
    email: u.email,
    displayName: u.display_name,
    avatarUrl: u.avatar_url,
    role: u.role,
    ageConfirmed: u.age_confirmed_at !== null,
    marketingOptIn: u.marketing_opt_in,
    creditsAvailable: balance.available,
    createdAt: u.created_at.toISOString(),
  };
}

/**
 * Signed, self-contained OAuth state carrying the PKCE verifier and nonce.
 *
 * Google echoes `state` back verbatim, so the CSRF nonce and the PKCE verifier
 * travel inside it, HMAC-signed with the session secret and expiring in ten
 * minutes. This keeps the flow stateless (no server-side session or cookie
 * dependency) while still binding the callback to the start request.
 */
const STATE_TTL_SECONDS = 600;

function stateSecret(ctx: AppContext): string {
  return ctx.config.GOOGLE_SESSION_SECRET ?? ctx.config.DEV_AUTH_SECRET ?? '';
}

function encodeState(ctx: AppContext, verifier: string): string {
  const body = Buffer.from(
    JSON.stringify({ v: verifier, n: randomBytes(8).toString('hex'), exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS }),
    'utf8',
  ).toString('base64url');
  const sig = createHmac('sha256', stateSecret(ctx)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function decodeState(ctx: AppContext, state: string): { verifier: string } | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', stateSecret(ctx)).update(body).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      v?: string;
      exp?: number;
    };
    if (!parsed.v || !parsed.exp || parsed.exp < Date.now() / 1000) return null;
    return { verifier: parsed.v };
  } catch {
    return null;
  }
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export default async function authRoutes(
  app: FastifyInstance,
  opts: { ctx: AppContext; adapter: AuthAdapter },
) {
  const { ctx, adapter } = opts;

  app.get('/v1/me', { preHandler: app.requireAuth }, async (req) => toMeView(req.user!));

  /** UI-02: age and terms confirmation, with marketing consent kept separate. */
  app.post('/v1/me/consent', { preHandler: app.requireAuth }, async (req) => {
    const body = z
      .object({
        ageConfirmed: z.literal(true),
        termsAccepted: z.literal(true),
        marketingOptIn: z.boolean().default(false),
      })
      .parse(req.body);
    const updated = await confirmAgeAndTerms({
      userId: req.user!.id,
      marketingOptIn: body.marketingOptIn,
    });
    if (!updated) throw new AppError('NOT_FOUND', 'user not found');
    await grantTrialIfEligible(ctx, updated.id);
    return toMeView(updated);
  });

  /** SEC-11: unsubscribing from marketing is its own action, unrelated to billing. */
  app.post('/v1/me/marketing', { preHandler: app.requireAuth }, async (req) => {
    const body = z.object({ optIn: z.boolean() }).parse(req.body);
    await setMarketingOptIn({ userId: req.user!.id, optIn: body.optIn });
    return { marketingOptIn: body.optIn };
  });

  /**
   * Development login. Registered only when the dev auth adapter is active,
   * which `loadConfig` forbids in production (SEC-03). It still issues a real
   * signed bearer token so the client-side auth path is genuinely exercised.
   */
  const allowlist = parseDevLoginAllowlist(ctx.config.DEV_LOGIN_ALLOWLIST);
  if (adapter instanceof DevAuthAdapter) {
    const dev = adapter;
    app.post('/v1/auth/dev-login', async (req) => {
      if (ctx.config.mode === 'production') {
        throw new AppError('FORBIDDEN', 'development login does not exist in production');
      }
      const body = devLoginSchema.parse(req.body);
      // Before anything is written: a refused address must not leave a user
      // row, a trial grant or a signup event behind.
      if (!devLoginAllowed(body.email, allowlist)) {
        throw new AppError('EMAIL_NOT_ALLOWED', 'this address may not use the development sign-in', {
          domains: allowlist.domains,
        });
      }
      const externalId = `dev-${Buffer.from(body.email.toLowerCase()).toString('hex').slice(0, 24)}`;
      const user = await upsertUser({
        authProvider: 'dev',
        externalId,
        email: body.email,
      });
      const confirmed = await confirmAgeAndTerms({
        userId: user.id,
        marketingOptIn: body.marketingOptIn,
      });
      await grantTrialIfEligible(ctx, user.id);
      await trackEvent({
        name: 'signup_completed',
        userRef: user.id,
        runMode: ctx.config.mode,
        isInternal: true,
      });
      // Second factor first: an enrolled account gets a challenge, not a session.
      const challenge = await issueMfaChallenge(ctx, user.id, body.email);
      if (challenge) {
        return { mfaRequired: true, challengeToken: challenge, demo: ctx.config.isDemo };
      }
      const token = dev.issue({ externalId, email: body.email });
      // Fire-and-forget: a notice must never delay or fail the sign-in it is
      // describing, and the send path already refuses to throw.
      void noticeSignIn(ctx, {
        userId: user.id,
        email: body.email,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        at: new Date(),
      });
      return {
        token: token.token,
        expiresAt: token.expiresAt.toISOString(),
        user: await toMeView(confirmed ?? user),
        // The web app keeps the demo banner up while this is true.
        demo: ctx.config.isDemo,
      };
    });
  }

  // ------------------------------------------------------------- google oauth

  /**
   * Google OAuth (auth/google.ts has the full flow). Registered whenever the
   * credentials exist, so "Sign in with Google" can coexist with the dev login
   * in integration mode.
   */
  const google =
    ctx.config.GOOGLE_CLIENT_ID && ctx.config.GOOGLE_CLIENT_SECRET && ctx.config.GOOGLE_REDIRECT_URI
      ? new GoogleAuthAdapter({
          clientId: ctx.config.GOOGLE_CLIENT_ID,
          clientSecret: ctx.config.GOOGLE_CLIENT_SECRET,
          redirectUri: ctx.config.GOOGLE_REDIRECT_URI,
          webOrigin: ctx.config.PUBLIC_WEB_URL,
        })
      : null;

  if (google) {
    app.get('/v1/auth/google/start', async (_req, reply) => {
      const verifier = randomBytes(32).toString('base64url');
      const state = encodeState(ctx, verifier);
      return reply
        .status(302)
        .redirect(google.authorizationUrl(state, pkceChallenge(verifier)));
    });

    app.get(GOOGLE_CALLBACK_PATH, async (req, reply) => {
      const query = z
        .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() })
        .parse(req.query);
      if (query.error) {
        return reply.redirect(
          `${ctx.config.PUBLIC_WEB_URL}/auth?google_error=${encodeURIComponent(query.error)}`,
        );
      }
      const state = query.state ? decodeState(ctx, query.state) : null;
      if (!query.code || !state) {
        throw new AppError('AUTH_EXCHANGE_FAILED', 'missing or expired google callback state');
      }

      const identity = await google.exchangeCode({ code: query.code, codeVerifier: state.verifier });
      const user = await google.toUser(identity);
      /*
       * This used to call `confirmAgeAndTerms` here, which asserted on the
       * user's behalf that they were 18 and had accepted the terms — without
       * ever asking. Dev login puts the two checkboxes on screen, but dev
       * login is forbidden in production (SEC-03), so in production Google is
       * the only door and nobody ever affirmed anything. `POST /v1/me/consent`
       * exists, documented "UI-02: age and terms confirmation", and had no
       * caller in the web app at all; `Account.tsx` rendered
       * `me.ageConfirmed ? ageYes : ageNo`, a question that could only ever
       * answer yes. Meanwhile the Terms and the Privacy Policy both say in
       * print that generation and purchase require being 18 or older.
       *
       * Nothing is written here now. `requireAgeConfirmed` already blocks
       * generation and purchase until the user answers, and the web app asks
       * on the first screen after sign-in.
       *
       * It was also silently revoking marketing consent on *every* sign-in:
       * `marketing_opt_in = ?` is unconditional in that UPDATE — only the two
       * timestamps are COALESCE-protected — and this passed `false` each
       * time, so a user who turned the toggle on in settings lost it the next
       * time they signed in with Google. Against the Privacy Policy's own
       * "which you may withdraw at any time", which cuts both ways.
       */
      await grantTrialIfEligible(ctx, user.id);
      await trackEvent({
        name: 'signup_completed',
        userRef: user.id,
        props: { provider: 'google' },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      });

      // The session token itself never enters a URL; the SPA exchanges this
      // one-time code for it over POST.
      const code = await issueAuthCode({ userId: user.id });
      return reply.redirect(google.callbackRedirect(code.code));
    });

    app.post(
      '/v1/auth/google/exchange',
      {
        config: {
          rateLimit: { max: 20, timeWindow: '1 minute' },
        },
      },
      async (req) => {
        const body = z.object({ code: z.string().min(16).max(256) }).parse(req.body);
        const consumed = await consumeAuthCode(body.code);
        if (!consumed) throw new AppError('AUTH_EXCHANGE_FAILED', 'code is invalid, expired or already used');

        const user = await getUser(consumed.userId);
        if (!user || user.deleted_at) throw new AppError('UNAUTHENTICATED', 'account no longer exists');

        // Second factor first: an enrolled account gets a challenge, not a session.
        const challenge = await issueMfaChallenge(ctx, user.id, user.email);
        if (challenge) {
          return { mfaRequired: true, challengeToken: challenge, demo: ctx.config.isDemo };
        }
        const sessionAdapter = new GoogleSessionAdapter({ secret: stateSecret(ctx) });
        const token = sessionAdapter.sessionIssuer().issue({
          provider: 'google',
          externalId: user.external_id,
          email: user.email,
        });
        void noticeSignIn(ctx, {
          userId: user.id,
          email: user.email,
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          at: new Date(),
        });
        return {
          token: token.token,
          expiresAt: token.expiresAt.toISOString(),
          user: await toMeView(user),
          demo: ctx.config.isDemo,
        };
      },
    );
  }

  /**
   * Login methods the web app should render. Google shows whenever its
   * credentials exist, so integration mode can run dev + google side by side.
   */
  app.get('/v1/auth/config', async () => {
    return {
      adapter: ctx.config.adapters.auth,
      devLogin: adapter instanceof DevAuthAdapter,
      // Domains only: listing the exact addresses would hand out the very
      // accounts the list is there to fence off.
      devLoginRestricted: allowlist.restricted,
      devLoginDomains: allowlist.domains,
      google: {
        enabled: !!google,
        // Present but unusable (e.g. missing client id) is surfaced so the UI
        // can explain instead of hiding a broken button.
        configured: !!google,
        clientId: ctx.config.GOOGLE_CLIENT_ID ?? null,
      },
      cognito:
        ctx.config.adapters.auth === 'cognito'
          ? {
              region: ctx.config.COGNITO_REGION,
              userPoolId: ctx.config.COGNITO_USER_POOL_ID,
              appClientId: ctx.config.COGNITO_APP_CLIENT_ID,
            }
          : null,
    };
  });

  // ------------------------------------------------------------- MFA (TOTP)

  /**
   * Enroll: returns the secret and the otpauth:// URI for the Google
   * Authenticator QR. The factor stays inactive until confirmed with a live
   * code, so a botched enrollment can never lock an account out.
   */
  app.post('/v1/auth/mfa/enroll', { preHandler: app.requireAuth }, async (req) => {
    return enrollMfa(ctx, req.user!.id);
  });

  app.post('/v1/auth/mfa/confirm', { preHandler: app.requireAuth }, async (req) => {
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const result = await confirmMfa(ctx, { userId: req.user!.id, code: body.code });
    void noticeAccountChange(ctx, { email: req.user!.email, change: 'mfa_enabled', at: new Date() });
    return result;
  });

  app.post('/v1/auth/mfa/disable', { preHandler: app.requireAuth }, async (req) => {
    const body = z.object({ code: z.string().min(6).max(16) }).parse(req.body);
    await disableMfa(ctx, { userId: req.user!.id, code: body.code });
    // The one an attacker performs. Turning a second factor off is the change
    // most worth telling somebody about.
    void noticeAccountChange(ctx, { email: req.user!.email, change: 'mfa_disabled', at: new Date() });
    return { disabled: true };
  });

  /** The session minting endpoint a challenge holder reaches after a valid code. */
  app.post(
    '/v1/auth/mfa/verify',
    {
      config: {
        rateLimit: { max: 12, timeWindow: '1 minute' },
      },
    },
    async (req) => {
      const body = z
        .object({ challengeToken: z.string().min(20), code: z.string().min(6).max(16) })
        .parse(req.body);
      const { userId, usedRecoveryCode } = await verifyMfaChallenge(ctx, body);

      const user = await getUser(userId);
      if (!user || user.deleted_at) throw new AppError('UNAUTHENTICATED', 'account no longer exists');
      const token = sessionIssuerFor(ctx).issue({
        provider: user.auth_provider === 'google' ? 'google' : 'dev',
        externalId: user.external_id,
        email: user.email,
      });
      // The third place a session is minted. Missing one of these would mean a
      // sign-in that is silently never noticed — which is the failure mode
      // this whole measure is about.
      void noticeSignIn(ctx, {
        userId: user.id,
        email: user.email,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        at: new Date(),
      });
      return {
        token: token.token,
        expiresAt: token.expiresAt.toISOString(),
        user: await toMeView(user),
        usedRecoveryCode,
        demo: ctx.config.isDemo,
      };
    },
  );

  /** Account settings reads whether MFA is on. */
  app.get('/v1/auth/mfa/status', { preHandler: app.requireAuth }, async (req) => {
    const { getEnabledMfaFactor } = await import('@yuha/db');
    const factor = await getEnabledMfaFactor(req.user!.id);
    return { enabled: !!factor, confirmedAt: factor?.confirmed_at?.toISOString() ?? null };
  });

  /**
   * SEC-11: account deletion is distinct from cancelling a subscription and
   * from unsubscribing marketing, and the response states what is retained.
   */
  app.post('/v1/me/deletion-request', { preHandler: app.requireAuth }, async (req) => {
    const body = z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {});

    /*
     * The ticket used to be a `randomUUID()` handed to the user and written
     * into one `analytics_events` row. That table is an append-only
     * measurement log: nothing could move the request through states, and an
     * operator could not list what was waiting. The promise was recorded and
     * the work was not. It is a row now.
     *
     * Asking twice returns the first ticket rather than opening a second
     * erasure of the same account — which is also what somebody who lost the
     * email wants.
     */
    const { row, created } = await openAccountDeletion({
      userId: req.user!.id,
      reason: body.reason ?? null,
    });

    if (created) {
      // Only on the first ticket: asking twice returns the first one, and a
      // second notice for the same request would read as a second deletion.
      void noticeAccountChange(ctx, { email: req.user!.email, change: 'deletion_requested', at: new Date() });
      await trackEvent({
        name: 'account_deletion_requested',
        userRef: req.user!.id,
        props: { ticket: row.ticket, has_reason: !!body.reason },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      });
    }

    return {
      ticket: row.ticket,
      status: 'received',
      // Retention scope and periods are configured and disclosed separately in
      // the privacy page; they are not decided here.
      retained: [
        'Orders, payments and refunds: statutory retention period',
        'Songs and evidence under an open rights case: until the investigation closes',
        // Added when the erasure was actually built. A buyer paid for the right
        // to download that song; removing it on the author's request takes away
        // something a third party owns. The code has always had to keep these —
        // this list simply did not say so, and a promise to remove "your songs"
        // that quietly keeps some of them is discovered by the person it
        // surprises.
        'Songs other people have licensed: kept so their purchase keeps working',
      ],
      removed: ['Account profile', 'Your songs and export files', 'Marketing subscription'],
      // Stored audio is removed on request; on S3 the bytes leave with the
      // bucket's 30-day noncurrent-version expiry rather than that same day.
      // Stated because `storage/s3.ts` makes it true and silence would read as
      // "immediately".
      audioErasureDays: 30,
      note: 'Cancellation, deletion and marketing opt-out are three different operations. Deletion runs after identity verification.',
      // Stable codes beside the prose, in the same order. The server decides
      // what the lists contain; the client words each item in the reader's
      // language. Additive: the English arrays above are unchanged for anything
      // already reading them.
      retainedCodes: ['orders_payments', 'rights_case_evidence', 'licensed_by_others'],
      removedCodes: ['profile', 'songs_exports', 'marketing'],
      noteCode: 'three_operations',
    };
  });
}
