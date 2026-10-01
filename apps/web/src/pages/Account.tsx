import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { rich, useI18n } from '../lib/i18n';
import { formatJst, useSession } from '../lib/session';
import { ErrorNotice } from '../components/common';

interface DeletionReceipt {
  ticket: string;
  retained: string[];
  removed: string[];
  note: string;
  /** In step with the prose arrays; absent from an older API. */
  retainedCodes?: string[];
  removedCodes?: string[];
  noteCode?: string;
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
  /*
   * A receipt line in the reader's language when its code is known, the
   * server's own English otherwise. The server decides what is retained and
   * what is removed; this only decides how the line is worded. A new code the
   * dictionary has not caught up with still shows, in English, rather than
   * vanishing from a statement of what happens to someone's data.
   */
  const receiptLine = (prefix: string, code: string | undefined, fallback: string) => {
    const key = `${prefix}.${code}`;
    const text = code ? t(key) : key;
    return text === key ? fallback : text;
  };
  const { me, refreshMe } = useSession();
  const [error, setError] = useState<unknown>(null);
  const [savingMarketing, setSavingMarketing] = useState(false);
  const [receipt, setReceipt] = useState<DeletionReceipt | null>(null);

  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string; qr: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);

  /*
   * Three states, not two. This collapsed "not answered yet" and "the request
   * failed" into the same `null`, and the panel renders `mfaEnabled === null`
   * as the word "Loading…" — so one failed status call left two-factor
   * security showing a loading line for ever: no Set-up button, no error, no
   * retry. The same three-state bug `Auth.tsx` documents at length having
   * already been fixed once.
   */
  const [mfaFailed, setMfaFailed] = useState(false);
  const refreshMfa = useCallback(() => {
    setMfaFailed(false);
    apiFetch<{ enabled: boolean }>('/v1/auth/mfa/status')
      .then((s) => setMfaEnabled(s.enabled))
      .catch(() => {
        setMfaEnabled(null);
        setMfaFailed(true);
      });
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
        color: { dark: '#20221f', light: '#ffffff' },
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

  /*
   * The button is the last control on a long page and the only error display
   * was at the very top, off screen. Confirm a deletion request with no
   * connection and nothing at all appeared — and the button was never
   * disabled, so it could be pressed again and again. `Create.tsx` solved
   * exactly this ("点击生成没有响应") by putting the message next to the
   * control; this does the same.
   */
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState(false);
  const requestDeletion = async () => {
    if (deleting) return;
    const ok = window.confirm(t('acct.deleteConfirm'));
    if (!ok) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      setReceipt(await apiFetch<DeletionReceipt>('/v1/me/deletion-request', { method: 'POST', body: {} }));
    } catch (err) {
      setDeleteError(err);
    } finally {
      setDeleting(false);
    }
  };

  if (!me) return null;

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }} className="stack stack--loose">
      <h1 style={{ fontSize: 26 }}>{t('account.settings')}</h1>

      <ErrorNotice error={error} />

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>{t('acct.profile')}</h2>
        <div className="row row--between">
          <span className="muted">{t('auth.email')}</span>
          <span>{me.email}</span>
        </div>
        <div className="row row--between">
          <span className="muted">{t('acct.age')}</span>
          <span>{me.ageConfirmed ? t('acct.ageYes') : t('acct.ageNo')}</span>
        </div>
        <div className="row row--between">
          <span className="muted">{t('acct.since')}</span>
          <span className="small">{formatJst(me.createdAt, false)}</span>
        </div>
      </section>

      <section className="panel stack" aria-labelledby="mfa-heading">
        <h2 id="mfa-heading" style={{ fontSize: 18, margin: 0 }}>
          {t('mfa.title')}
        </h2>
        <p className="small muted" style={{ margin: 0 }}>
          {t('acct.mfaBody')}
        </p>

        {mfaEnabled === null && !mfaFailed && <p className="small muted">{t('lib.loading')}</p>}
        {mfaFailed && (
          <div className="row">
            <button type="button" className="btn btn--sm" onClick={refreshMfa}>
              {t('common.retry')}
            </button>
          </div>
        )}

        {mfaEnabled === false && !enrollment && (
          <button type="button" className="btn btn--primary" onClick={startEnrollment} disabled={mfaBusy}>
            {mfaBusy ? t('acct.mfaPreparing') : t('acct.mfaSetup')}
          </button>
        )}

        {enrollment && (
          <div className="stack mfa-enroll">
            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--s3)' }}>
              <img
                src={enrollment.qr}
                alt={t('acct.qrAlt')}
                width={190}
                height={190}
                style={{ borderRadius: 14, flex: 'none' }}
              />
              <div className="stack stack--tight" style={{ minWidth: 220 }}>
                <strong>{t('acct.mfaStep1')}</strong>
                <span className="small muted">{t('acct.mfaStep1Body')}</span>
                <code className="mfa-key">{enrollment.secret}</code>
                <strong>{t('acct.mfaStep2')}</strong>
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
                {mfaBusy ? t('mfa.verifying') : t('acct.mfaConfirm')}
              </button>
            </div>
          </div>
        )}

        {recoveryCodes && (
          <div className="alert alert--info stack stack--tight">
            <div className="alert__title">{t('acct.recoveryTitle')}</div>
            <p className="small" style={{ margin: 0 }}>
              {/* The count is the real one: "8" was written into the sentence
                  while the list beside it came from the server. */}
              {rich(t('acct.recoveryBody', { n: recoveryCodes.length }), {
                once: <strong>{t('acct.recoveryOnce')}</strong>,
              })}
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
            <span className="small" style={{ color: 'var(--ok)' }}>{t('acct.mfaOn')}</span>
            <div className="row">
              <input
                type="text"
                inputMode="numeric"
                maxLength={16}
                placeholder={t('acct.disablePlaceholder')}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.trim())}
                aria-label={t('acct.disableAria')}
                style={{ maxWidth: 220 }}
              />
              <button type="button" className="btn btn--danger-ghost" onClick={disableMfa} disabled={mfaBusy || !mfaCode}>
                {t('acct.mfaDisable')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>{t('acct.emailTitle')}</h2>
        <div className="checkbox-row">
          <input
            id="marketing"
            type="checkbox"
            checked={me.marketingOptIn}
            disabled={savingMarketing}
            onChange={(e) => void toggleMarketing(e.target.checked)}
          />
          <label htmlFor="marketing">{t('acct.marketing')}</label>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {t('acct.marketingNote')}
        </p>
      </section>

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>{t('account.billing')}</h2>
        <p className="small muted" style={{ margin: 0 }}>
          {t('acct.billingNote')}
        </p>
        <Link className="btn" to="/settings/billing">
          {t('pay.seeBilling')}
        </Link>
      </section>

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>{t('acct.deleteTitle')}</h2>

        {receipt ? (
          <div className="alert alert--info">
            <div className="alert__title">{t('acct.deleteReceived', { ticket: receipt.ticket.slice(0, 8) })}</div>
            <div className="small stack stack--tight" style={{ marginTop: 'var(--s1)' }}>
              <div>
                <strong>{t('acct.removed')}</strong>
                <ul style={{ margin: '4px 0', paddingLeft: '1.2em' }}>
                  {receipt.removed.map((r, i) => (
                    <li key={r}>{receiptLine('acct.item', receipt.removedCodes?.[i], r)}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>{t('acct.retained')}</strong>
                <ul style={{ margin: '4px 0', paddingLeft: '1.2em' }}>
                  {receipt.retained.map((r, i) => (
                    <li key={r}>{receiptLine('acct.item', receipt.retainedCodes?.[i], r)}</li>
                  ))}
                </ul>
              </div>
              <p style={{ margin: 0 }}>{receiptLine('acct.note', receipt.noteCode, receipt.note)}</p>
            </div>
          </div>
        ) : (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              {rich(t('acct.deleteBody'), {
                privacy: <Link to="/legal/privacy">{t('auth.privacyLink')}</Link>,
              })}
            </p>
            <ErrorNotice error={deleteError} />
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void requestDeletion()}
              disabled={deleting}
            >
              {t('acct.deleteRequest')}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
