import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { MeView } from '@loopscene/contracts';
import { apiFetch } from '../lib/api';
import { useSession } from '../lib/session';

/**
 * End of the Google OAuth redirect: exchange the one-time code for a session.
 *
 * The code is consumed on first use; a refresh here fails cleanly and sends the
 * visitor back to /auth rather than looping.
 */
export default function GoogleCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { signIn } = useSession();
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);

  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    const code = params.get('code');
    if (!code) {
      navigate('/auth', { replace: true });
      return;
    }
    apiFetch<{ token: string; user: MeView }>('/v1/auth/google/exchange', {
      method: 'POST',
      body: { code },
    })
      .then((res) => {
        signIn(res.token, res.user);
        navigate('/create', { replace: true });
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'exchange failed');
      });
  }, [params, navigate, signIn]);

  return (
    <div className="auth-page">
      <div className="auth-card panel">
        {error ? (
          <>
            <h1 className="auth-card__title">Sign-in failed</h1>
            <p className="small">{error}</p>
            <a className="btn btn--block" href="/auth">
              Back to sign in
            </a>
          </>
        ) : (
          <>
            <h1 className="auth-card__title">Finishing sign-in…</h1>
            <p className="small muted">Exchanging your Google session.</p>
            <div className="spinner" aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  );
}
