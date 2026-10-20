import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { MeView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { safeInternalPath } from '../lib/paths';
import { useSession } from '../lib/session';
import { ErrorNotice } from '../components/common';

/**
 * The MFA challenge screen: reached when a login's first factor (Google or
 * dev) succeeded but the account carries a TOTP factor. The challenge token
 * is single-purpose — it can only ever mint a session for its own user, and
 * only with a valid code.
 */
export default function MfaChallenge() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { signIn } = useSession();
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const challengeToken = params.get('challenge') ?? '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length < 6 || !challengeToken) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ token: string; user: MeView; usedRecoveryCode: boolean }>('/v1/auth/mfa/verify', {
        method: 'POST',
        body: { challengeToken, code },
      });
      signIn(res.token, res.user);
      // Through the same guard as every other `next` in the app. This one is
      // the most worth guarding: it runs immediately after a successful second
      // factor, which is the moment a user is most likely to follow wherever
      // they are sent.
      navigate(safeInternalPath(params.get('next')) ?? '/library', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card panel">
        <h1 className="auth-card__title">{t('mfa.title')}</h1>
        <p className="auth-card__sub">
          {t('mfa.sub')}
        </p>

        <ErrorNotice error={error} />

        {/*
          Without `?challenge=` there is nothing to verify against, and the
          form used to render anyway: the button enabled at six digits and
          pressing it returned silently. A bookmark, a reload of a stale tab
          or a shared URL all land here. The link to start again already
          existed at the bottom of the page; nothing pointed anyone at it.
        */}
        {!challengeToken ? (
          <div className="alert alert--warn">
            <div className="alert__title">{t('mfa.noChallenge')}</div>
            <div className="small">
              <a href="/auth">{t('mfa.restart')}</a>
            </div>
          </div>
        ) : (
        <form className="stack" onSubmit={submit} noValidate>
          <div className="mfa-code">
            <label htmlFor="mfa-code">{t('mfa.code')}</label>
            {/* Text, not numeric: the same box takes a recovery code, which
                is hex (`a1b2-c3d4`), and a numeric keypad on a phone has no
                a–f. The server accepts it with or without the hyphen. */}
            <input
              id="mfa-code"
              type="text"
              inputMode="text"
              autoComplete="one-time-code"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={12}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[\s-]/g, ''))}
              placeholder="123456"
              autoFocus
              aria-describedby="mfa-help"
            />
            <p id="mfa-help" className="small muted">
              {t('mfa.lost')}
            </p>
          </div>
          <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={busy || code.length < 6}>
            {busy ? t('mfa.verifying') : t('mfa.verify')}
          </button>
        </form>
        )}

        <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>
          <a href="/auth">{t('mfa.restart')}</a>
        </p>
      </div>
    </div>
  );
}
