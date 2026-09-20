import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { MeView } from '@loopscene/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { ErrorNotice } from '../components/common';

interface AuthConfig {
  adapter: string;
  devLogin: boolean;
  google: { enabled: boolean; configured: boolean; clientId: string | null };
}

/**
 * Sign-in.
 *
 * "{t('auth.google')}" is the front door: it redirects through the API's
 * OAuth start endpoint and returns to /auth/google/callback, which exchanges
 * the one-time code for a session. The email form is the demo/integration
 * development login and only appears when the server says it exists.
 */
export default function Auth() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { runtime, signIn } = useSession();

  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState('');
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const next = params.get('next') ?? '/create';
  const googleError = params.get('google_error');
  const canSubmit = email.includes('@') && ageConfirmed && termsAccepted && !submitting;

  useEffect(() => {
    apiFetch<AuthConfig>('/v1/auth/config').then(setAuthConfig).catch(() => setAuthConfig(null));
  }, []);

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
            <div className="alert__title">Google sign-in did not complete</div>
            <div className="small">{googleError.replace(/_/g, ' ')} — please try again.</div>
          </div>
        )}

        {authConfig?.google.enabled ? (
          <a
            className="btn btn--google btn--block"
            href={`${import.meta.env['VITE_API_URL'] ?? 'http://localhost:4000'}/v1/auth/google/start`}
          >
            <span className="btn--google__g" aria-hidden="true">
              G
            </span>
            {t('auth.google')}
          </a>
        ) : (
          <div className="alert alert--info">
            <div className="alert__title">Google sign-in is not configured</div>
            <div className="small">
              Set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and{' '}
              <code>GOOGLE_REDIRECT_URI</code> in the API environment to enable it. The button will appear here
              automatically.
            </div>
          </div>
        )}

        {authConfig?.devLogin && (
          <>
            <div className="auth-divider">
              <span>{t('auth.or')}</span>
            </div>
            <form className="stack" onSubmit={submit} noValidate>
              <div>
                <label htmlFor="email">Email</label>
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
                <label htmlFor="age">I am 18 or older</label>
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
                  I agree to the{' '}
                  <Link to="/legal/terms" target="_blank">
                    Terms
                  </Link>{' '}
                  and{' '}
                  <Link to="/legal/privacy" target="_blank">
                    Privacy Policy
                  </Link>
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
                <label htmlFor="marketing">Send me product news (optional)</label>
              </div>

              <button type="submit" className="btn btn--block" disabled={!canSubmit}>
                {submitting ? 'Signing in…' : 'Continue with email'}
              </button>
            </form>

            {runtime?.demo && (
              <p className="small muted" style={{ margin: 0 }}>
                Demo accounts: <code>creator@example.jp</code> · <code>empty@example.jp</code> ·{' '}
                <code>admin@example.jp</code>
              </p>
            )}
          </>
        )}

        {authConfig?.adapter === 'cognito' && !authConfig.devLogin && (
          <div className="alert alert--info">
            <div className="alert__title">Email code sign-in</div>
            <div className="small">
              A verification code will be emailed to you; the challenge is hosted by Amazon Cognito.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
