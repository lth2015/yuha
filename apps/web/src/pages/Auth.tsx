import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { MeView } from '@yuha/contracts';
import { API_BASE, apiFetch } from '../lib/api';
import { rich, useI18n } from '../lib/i18n';
import { AUTH_NEXT_KEY, safeInternalPath } from '../lib/paths';
import { useSession } from '../lib/session';
import { ErrorNotice } from '../components/common';

interface AuthConfig {
  adapter: string;
  devLogin: boolean;
  google: { enabled: boolean; configured: boolean; clientId: string | null };
}

/**
 * Three states, not two.
 *
 * This used to be `AuthConfig | null`, set by
 * `.then(setAuthConfig).catch(() => setAuthConfig(null))`, and every branch
 * below read `authConfig?.…`. So "the API did not answer" and "the API answered,
 * and Google is off" collapsed into the same value, and the page reported both
 * as **"Google sign-in is not configured — set GOOGLE_CLIENT_ID, …"**. That
 * sends someone to edit an `.env` that was already correct, while the actual
 * fault is that nothing is listening on the API port. It cost exactly that
 * detour on 2026-09-28.
 *
 * `null` also meant "not fetched yet", so a correctly configured instance
 * showed the same "not configured" panel for the length of the request, on
 * every load.
 *
 * `api.ts` already draws the distinction — it throws `NetworkError` when the
 * browser cannot reach the API at all, separately from `ApiError` — and the
 * blanket catch was discarding it. `ErrorNotice` renders that error with the
 * right words and a retry, the same as everywhere else in the app.
 */
type ConfigState =
  | { status: 'loading' }
  | { status: 'ready'; config: AuthConfig }
  | { status: 'unreachable'; error: unknown };

/**
 * Sign-in.
 *
 * "{t('auth.google')}" is the front door: it redirects through the API's
 * OAuth start endpoint and returns to /auth/google/callback, which exchanges
 * the one-time code for a session. The email form is the demo/integration
 * development login and only appears when the server says it exists.
 */
function readStoredNext(): string | null {
  try {
    return sessionStorage.getItem(AUTH_NEXT_KEY);
  } catch {
    return null;
  }
}

export default function Auth() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { runtime, signIn } = useSession();

  const [configState, setConfigState] = useState<ConfigState>({ status: 'loading' });
  const [email, setEmail] = useState('');
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const googleError = params.get('google_error');
  // Returning from Google with an error drops `next` from the URL, so a retry
  // would overwrite the stored destination with /create. Only on that return
  // trip is the stored value trusted; a fresh visit decides for itself.
  const next =
    safeInternalPath(params.get('next')) ??
    (googleError ? safeInternalPath(readStoredNext()) : null) ??
    '/create';
  const canSubmit = email.includes('@') && ageConfirmed && termsAccepted && !submitting;

  // Retry starts a second request without cancelling the first. A slow first
  // attempt that fails after a fast retry succeeded would otherwise put the page
  // back into "unreachable" — reporting a failure that has already been
  // recovered from, which is the same class of wrong answer this whole change is
  // about. Only the newest attempt may write state; the cleanup makes every
  // in-flight attempt stale on unmount.
  const attempt = useRef(0);
  const loadConfig = useCallback(() => {
    const mine = (attempt.current += 1);
    setConfigState({ status: 'loading' });
    apiFetch<AuthConfig>('/v1/auth/config')
      .then((config) => {
        if (attempt.current === mine) setConfigState({ status: 'ready', config });
      })
      .catch((error: unknown) => {
        if (attempt.current === mine) setConfigState({ status: 'unreachable', error });
      });
  }, []);

  useEffect(() => {
    loadConfig();
    return () => {
      attempt.current += 1;
    };
  }, [loadConfig]);

  const config = configState.status === 'ready' ? configState.config : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<
        { token: string; user: MeView } | { mfaRequired: true; challengeToken: string }
      >('/v1/auth/dev-login', {
        method: 'POST',
        body: { email, ageConfirmed: true, termsAccepted: true, marketingOptIn },
      });
      if ('mfaRequired' in res) {
        navigate(`/auth/mfa?challenge=${encodeURIComponent(res.challengeToken)}&next=${encodeURIComponent(next)}`, {
          replace: true,
        });
        return;
      }
      signIn(res.token, res.user);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card panel">
        <h1 className="auth-card__title">{t('auth.welcome')}</h1>
        <p className="auth-card__sub">{t('auth.sub')}</p>

        <ErrorNotice error={error} />
        {googleError && (
          <div className="alert alert--error">
            <div className="alert__title">{t('auth.googleFailed')}</div>
            <div className="small">
              {/* access_denied is the person pressing Cancel on Google's screen,
                  not a fault; say so rather than print the error code at them. */}
              {googleError === 'access_denied' ? t('auth.googleCancelled') : t('auth.googleRetry')}
            </div>
            {googleError !== 'access_denied' && (
              <div className="small muted">
                <code>{googleError}</code>
              </div>
            )}
          </div>
        )}

        {configState.status === 'unreachable' && (
          // Whatever is wrong, it is not the operator's env file, and saying so
          // would send them to the wrong place. ErrorNotice reads NetworkError
          // and offers the retry.
          <ErrorNotice error={configState.error} onRetry={loadConfig} />
        )}

        {config?.google.enabled ? (
          <a
            className="btn btn--google btn--block"
            href={`${API_BASE}/v1/auth/google/start`}
            onClick={() => {
              try {
                sessionStorage.setItem(AUTH_NEXT_KEY, next);
              } catch {
                /* private mode: the callback falls back to /create */
              }
            }}
          >
            <span className="btn--google__g" aria-hidden="true">
              G
            </span>
            {t('auth.google')}
          </a>
        ) : configState.status === 'ready' ? (
          // Only once the server has actually said so. While the request is in
          // flight there is nothing to report, and claiming a misconfiguration
          // on every page load is how this message stopped being believed.
          <div className="alert alert--info">
            {/* These two strings were translated in 3e5ad3c and never used:
                this panel stayed in English beside them the whole time. */}
            <div className="alert__title">{t('auth.googleNotConfigured')}</div>
            <div className="small">{t('auth.googleHint')}</div>
          </div>
        ) : null}

        {config?.devLogin && (
          <>
            <div className="auth-divider">
              <span>{t('auth.or')}</span>
            </div>
            <form className="stack" onSubmit={submit} noValidate>
              <div>
                <label htmlFor="email">{t('auth.email')}</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </div>

              {/* Age and terms are separate confirmations, both required. */}
              <div className="checkbox-row">
                <input
                  id="age"
                  type="checkbox"
                  checked={ageConfirmed}
                  onChange={(e) => setAgeConfirmed(e.target.checked)}
                  required
                />
                <label htmlFor="age">{t('auth.age')}</label>
              </div>

              <div className="checkbox-row">
                <input
                  id="terms"
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  required
                />
                <label htmlFor="terms">
                  {rich(t('auth.terms'), {
                    terms: (
                      <Link to="/legal/terms" target="_blank">
                        {t('auth.termsLink')}
                      </Link>
                    ),
                    privacy: (
                      <Link to="/legal/privacy" target="_blank">
                        {t('auth.privacyLink')}
                      </Link>
                    ),
                  })}
                </label>
              </div>

              {/* Marketing consent is separate, unchecked, and never required. */}
              <div className="checkbox-row">
                <input
                  id="marketing"
                  type="checkbox"
                  checked={marketingOptIn}
                  onChange={(e) => setMarketingOptIn(e.target.checked)}
                />
                <label htmlFor="marketing">{t('auth.marketing')}</label>
              </div>

              <button type="submit" className="btn btn--block" disabled={!canSubmit}>
                {submitting ? t('auth.signingIn') : t('auth.continue')}
              </button>
            </form>

            {runtime?.demo && (
              <p className="small muted" style={{ margin: 0 }}>
                {t('auth.demoAccounts')} <code>creator@example.jp</code> · <code>empty@example.jp</code> ·{' '}
                <code>admin@example.jp</code>
              </p>
            )}
          </>
        )}

        {config?.adapter === 'cognito' && !config.devLogin && (
          <div className="alert alert--info">
            <div className="alert__title">{t('auth.cognitoTitle')}</div>
            <div className="small">{t('auth.cognitoBody')}</div>
          </div>
        )}
      </div>
    </div>
  );
}
