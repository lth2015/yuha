import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatJst, useSession } from '../lib/session';
import { ErrorNotice } from '../components/common';

interface DeletionReceipt {
  ticket: string;
  retained: string[];
  removed: string[];
  note: string;
}

/**
 * Account settings — identity, two-factor authentication (Google
 * Authenticator), marketing consent, billing pointer and deletion.
 *
 * MFA lifecycle: enroll (QR + manual key) → confirm with a live code (which
 * reveals the recovery codes exactly once) → enabled. Disable requires a
 * valid code, so nobody can switch it off from a stolen unlocked tab alone.
 */
export default function Account() {
  const { t } = useI18n();
  const { me, refreshMe } = useSession();
  const [error, setError] = useState<unknown>(null);
  const [savingMarketing, setSavingMarketing] = useState(false);
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);

  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string; qr: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);

  const refreshMfa = useCallback(() => {
    apiFetch<{ enabled: boolean }>('/v1/auth/mfa/status')
      .then((s) => setMfaEnabled(s.enabled))
      .catch(() => setMfaEnabled(null));
  }, []);
  useEffect(refreshMfa, [refreshMfa]);

  const startEnrollment = async () => {
    setMfaBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ secret: string; otpauthUri: string }>('/v1/auth/mfa/enroll', { method: 'POST' });
      const qr = await QRCode.toDataURL(res.otpauthUri, {
        margin: 1,
        width: 220,
        color: { dark: '#101115', light: '#ffffff' },
      });
      setEnrollment({ ...res, qr });
      setRecoveryCodes(null);
      setMfaCode('');
    } catch (err) {
      setError(err);
    } finally {
      setMfaBusy(false);
    }
  };

  const confirmEnrollment = async () => {
    if (!/^\d{6}$/.test(mfaCode)) return;
    setMfaBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ recoveryCodes: string[] }>('/v1/auth/mfa/confirm', {
        method: 'POST',
        body: { code: mfaCode },
      });
      setRecoveryCodes(res.recoveryCodes);
      setEnrollment(null);
      setMfaCode('');
      setMfaEnabled(true);
      refreshMfa();
    } catch (err) {
      setError(err);
    } finally {
      setMfaBusy(false);
    }
  };

  const disableMfa = async () => {
    if (!mfaCode) return;
    setMfaBusy(true);
    setError(null);
    try {
      await apiFetch('/v1/auth/mfa/disable', { method: 'POST', body: { code: mfaCode } });
      setMfaEnabled(false);
      setMfaCode('');
    } catch (err) {
      setError(err);
    } finally {
      setMfaBusy(false);
    }
  };

  const toggleMarketing = async (optIn: boolean) => {
    setSavingMarketing(true);
    setError(null);
    try {
      await apiFetch('/v1/me/marketing', { method: 'POST', body: { optIn } });
      await refreshMe();
    } catch (err) {
      setError(err);
    } finally {
      setSavingMarketing(false);
    }
  };

  const requestDeletion = async () => {
    const ok = window.confirm(
      'This will request deletion of your account.\n\n' +
        'It is separate from cancelling a subscription or unsubscribing from email. ' +
        'It runs after identity verification and cannot be undone.\n\nContinue?',
    );
    if (!ok) return;
    setError(null);
    try {
      setReceipt(await apiFetch<DeletionReceipt>('/v1/me/deletion-request', { method: 'POST', body: {} }));
    } catch (err) {
      setError(err);
    }
  };

  if (!me) return null;

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }} className="stack stack--loose">
      <h1 style={{ fontSize: 26 }}>Account settings</h1>

      <ErrorNotice error={error} />

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>Profile</h2>
        <div className="row row--between">
          <span className="muted">Email</span>
          <span>{me.email}</span>
        </div>
        <div className="row row--between">
          <span className="muted">Age confirmation</span>
          <span>{me.ageConfirmed ? 'Confirmed (18+)' : 'Not confirmed'}</span>
        </div>
        <div className="row row--between">
          <span className="muted">Member since</span>
          <span className="small">{formatJst(me.createdAt, false)}</span>
        </div>
      </section>

      <section className="panel stack" aria-labelledby="mfa-heading">
        <h2 id="mfa-heading" style={{ fontSize: 18, margin: 0 }}>
          Two-factor authentication
        </h2>
        <p className="small muted" style={{ margin: 0 }}>
          Add a second factor with Google Authenticator (or any authenticator app). At sign-in you'll enter a
          6-digit code after your Google account — a stolen password alone is no longer enough.
        </p>

        {mfaEnabled === null && <p className="small muted">Loading…</p>}

        {mfaEnabled === false && !enrollment && (
          <button type="button" className="btn btn--primary" onClick={startEnrollment} disabled={mfaBusy}>
            {mfaBusy ? 'Preparing…' : 'Set up with Google Authenticator'}
          </button>
        )}

        {enrollment && (
          <div className="stack mfa-enroll">
            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--s3)' }}>
              <img
                src={enrollment.qr}
                alt="QR code for Google Authenticator"
                width={190}
                height={190}
                style={{ borderRadius: 14, flex: 'none' }}
              />
              <div className="stack stack--tight" style={{ minWidth: 220 }}>
                <strong>1. Scan in Google Authenticator</strong>
                <span className="small muted">
                  Open the app → add account → scan QR code. Or enter this key manually:
                </span>
                <code className="mfa-key">{enrollment.secret}</code>
                <strong>2. Enter the current 6-digit code</strong>
              </div>
            </div>
            <div className="row">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="123456"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                aria-label={t('a11y.totpCode')}
                style={{ maxWidth: 140, letterSpacing: '0.2em', fontSize: 18, textAlign: 'center' }}
              />
              <button type="button" className="btn btn--primary" onClick={confirmEnrollment} disabled={mfaBusy || mfaCode.length !== 6}>
                {mfaBusy ? 'Verifying…' : 'Confirm & enable'}
              </button>
            </div>
          </div>
        )}

        {recoveryCodes && (
          <div className="alert alert--info stack stack--tight">
            <div className="alert__title">Two-factor is on — save your recovery codes now</div>
            <p className="small" style={{ margin: 0 }}>
              These 8 codes are shown <strong>only once</strong>. Each works one time if you lose your phone.
            </p>
            <div className="mfa-recovery">
              {recoveryCodes.map((c) => (
                <code key={c}>{c}</code>
              ))}
            </div>
          </div>
        )}

        {mfaEnabled && (
          <div className="stack stack--tight">
            <span className="small" style={{ color: 'var(--ok)' }}>✓ Enabled — sign-ins ask for your authenticator code.</span>
            <div className="row">
              <input
                type="text"
                inputMode="numeric"
                maxLength={16}
                placeholder="code or recovery code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.trim())}
                aria-label="Code to disable two-factor"
                style={{ maxWidth: 220 }}
              />
              <button type="button" className="btn btn--danger-ghost" onClick={disableMfa} disabled={mfaBusy || !mfaCode}>
                Disable two-factor
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>Email notifications</h2>
        <div className="checkbox-row">
          <input
            id="marketing"
            type="checkbox"
            checked={me.marketingOptIn}
            disabled={savingMarketing}
            onChange={(e) => void toggleMarketing(e.target.checked)}
          />
          <label htmlFor="marketing">Send me product news and campaigns</label>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Unsubscribing never affects your account. Service and transaction email still arrives.
        </p>
      </section>

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>Billing</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Subscription cancellation lives on the Billing page — separate from deleting the account.
        </p>
        <Link className="btn" to="/settings/billing">
          Open billing
        </Link>
      </section>

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>Delete account</h2>

        {receipt ? (
          <div className="alert alert--info">
            <div className="alert__title">Deletion request received (ticket {receipt.ticket.slice(0, 8)})</div>
            <div className="small stack stack--tight" style={{ marginTop: 'var(--s1)' }}>
              <div>
                <strong>Removed</strong>
                <ul style={{ margin: '4px 0', paddingLeft: '1.2em' }}>
                  {receipt.removed.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Retained where required</strong>
                <ul style={{ margin: '4px 0', paddingLeft: '1.2em' }}>
                  {receipt.retained.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
              <p style={{ margin: 0 }}>{receipt.note}</p>
            </div>
          </div>
        ) : (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              Deletes your account, songs and exports. Statutory transaction records and open rights-case
              evidence are retained separately, as described in the{' '}
              <Link to="/legal/privacy">Privacy Policy</Link>.
            </p>
            <button type="button" className="btn btn--danger" onClick={() => void requestDeletion()}>
              Request account deletion
            </button>
          </>
        )}
      </section>
    </div>
  );
}
