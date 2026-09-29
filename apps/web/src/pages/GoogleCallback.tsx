import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { MeView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { AUTH_NEXT_KEY, safeInternalPath } from '../lib/paths';
import { useSession } from '../lib/session';
import { ErrorNotice } from '../components/common';

/** The destination stored before leaving for Google, read once and cleared. */
function takeStoredNext(): string | null {
  try {
    const value = sessionStorage.getItem(AUTH_NEXT_KEY);
    sessionStorage.removeItem(AUTH_NEXT_KEY);
    return safeInternalPath(value);
  } catch {
    return null;
  }
}

/**
 * End of the Google OAuth redirect: exchange the one-time code for a session.
 *
 * The code is consumed on first use; a refresh here fails cleanly and sends the
 * visitor back to /auth rather than looping.
 *
 * On failure this used to print `err.message` — the API's own English, such as
 * "missing or expired google callback state" — under an English heading, on a
 * screen every production sign-in passes through. ErrorNotice turns the error
 * code into the reader's language, as it does on every other page.
 */
export default function GoogleCallback() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { signIn } = useSession();
  const [error, setError] = useState<unknown>(null);
  const tried = useRef(false);

  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    const code = params.get('code');
    if (!code) {
      navigate('/auth', { replace: true });
      return;
    }
    const next = takeStoredNext() ?? '/create';
    apiFetch<{ token: string; user: MeView } | { mfaRequired: true; challengeToken: string }>(
      '/v1/auth/google/exchange',
      {
        method: 'POST',
        body: { code },
      },
    )
      .then((res) => {
        if ('mfaRequired' in res) {
          navigate(
            `/auth/mfa?challenge=${encodeURIComponent(res.challengeToken)}&next=${encodeURIComponent(next)}`,
            { replace: true },
          );
          return;
        }
        signIn(res.token, res.user);
        navigate(next, { replace: true });
      })
      .catch(setError);
  }, [params, navigate, signIn]);

  return (
    <div className="auth-page">
      <div className="auth-card panel">
        {error ? (
          <>
            <h1 className="auth-card__title">{t('auth.cbFailed')}</h1>
            <ErrorNotice error={error} />
            <a className="btn btn--block" href="/auth">
              {t('auth.cbBack')}
            </a>
          </>
        ) : (
          <>
            <h1 className="auth-card__title">{t('auth.cbFinishing')}</h1>
            <p className="small muted">{t('auth.cbExchanging')}</p>
            <div className="spinner" aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  );
}
