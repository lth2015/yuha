import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { MeView } from '@loopscene/contracts';
import { apiFetch } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorNotice } from '../components/common';

/**
 * The MFA challenge screen: reached when a login's first factor (Google or
 * dev) succeeded but the account carries a TOTP factor. The challenge token
 * is single-purpose — it can only ever mint a session for its own user, and
 * only with a valid code.
 */
export default function MfaChallenge() {
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
      navigate(params.get('next') ?? '/library', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card panel">
        <h1 className="auth-card__title">两步验证</h1>
        <p className="auth-card__sub">
          输入 Google 身份验证器中的 6 位验证码（或一个恢复码），完成登录。
        </p>

        <ErrorNotice error={error} />

        <form className="stack" onSubmit={submit} noValidate>
          <div>
            <label htmlFor="mfa-code">验证码</label>
            <input
              id="mfa-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[\s-]/g, ''))}
              placeholder="123456"
              autoFocus
              style={{ fontSize: 24, letterSpacing: '0.35em', textAlign: 'center', maxWidth: 240, margin: '0 auto' }}
              aria-describedby="mfa-help"
            />
            <p id="mfa-help" className="small muted" style={{ textAlign: 'center', marginBottom: 0 }}>
              手机丢了？可以输入任意一个恢复码。
            </p>
          </div>
          <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={busy || code.length < 6}>
            {busy ? '正在验证…' : '验证并登录'}
          </button>
        </form>

        <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>
          <a href="/auth">重新开始</a>
        </p>
      </div>
    </div>
  );
}
