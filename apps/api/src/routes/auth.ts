import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, type MeView } from '@loopscene/contracts';
import {
  confirmAgeAndTerms,
  consumeAuthCode,
  getBalance,
  getUser,
  issueAuthCode,
  setMarketingOptIn,
  trackEvent,
  upsertUser,
  type UserRow,
} from '@loopscene/db';
import type { AppContext } from '../context.js';
import {
  DevAuthAdapter,
  GoogleAuthAdapter,
  GoogleSessionAdapter,
  type AuthAdapter,
} from '../auth/index.js';
import { grantTrialIfEligible } from '../services/billing.js';

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
  if (adapter instanceof DevAuthAdapter) {
    const dev = adapter;
    app.post('/v1/auth/dev-login', async (req) => {
      if (ctx.config.mode === 'production') {
        throw new AppError('FORBIDDEN', 'development login does not exist in production');
      }
      const body = devLoginSchema.parse(req.body);
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
      const token = dev.issue({ externalId, email: body.email });
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

    app.get('/v1/auth/google/callback', async (req, reply) => {
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
      await confirmAgeAndTerms({ userId: user.id, marketingOptIn: false });
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

        const sessionAdapter = new GoogleSessionAdapter({ secret: stateSecret(ctx) });
        const token = sessionAdapter.sessionIssuer().issue({
          provider: 'google',
          externalId: user.external_id,
          email: user.email,
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

  /**
   * SEC-11: account deletion is distinct from cancelling a subscription and
   * from unsubscribing marketing, and the response states what is retained.
   */
  app.post('/v1/me/deletion-request', { preHandler: app.requireAuth }, async (req) => {
    const body = z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {});
    const ticket = randomUUID();
    await trackEvent({
      name: 'account_deletion_requested',
      userRef: req.user!.id,
      props: { ticket, has_reason: !!body.reason },
      runMode: ctx.config.mode,
      isInternal: ctx.config.isDemo,
    });
    return {
      ticket,
      status: 'received',
      // Retention scope and periods are configured and disclosed separately in
      // the privacy page; they are not decided here.
      retained: [
        'Orders, payments and refunds: statutory retention period',
        'Songs and evidence under an open rights case: until the investigation closes',
      ],
      removed: ['Account profile', 'Your songs and export files', 'Marketing subscription'],
      note: 'Cancellation, deletion and marketing opt-out are three different operations. Deletion runs after identity verification.',
    };
  });
}
