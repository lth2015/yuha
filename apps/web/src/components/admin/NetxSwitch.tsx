import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Badge, ErrorNotice } from '../common';
import { useSession } from '../../lib/session';

interface NetxStatus {
  configured: boolean;
  accepting: boolean;
  /** The fixed rate, from the server — never a literal in the copy. */
  yenPerToken: number | null;
}

/**
 * Pause or resume NETX (docs/NETX_PAYMENT.md §4).
 *
 * NETX is priced at a fixed ¥20 while its market moves; if the market falls
 * below that, NETX bought on the market buys credits below their yen price.
 * This is the control: one action, effective on the next request, no deploy.
 * Pausing stops NETX being offered and quoted; a buyer already quoted who has
 * paid is still credited, because the scanner keeps watching.
 *
 * Shown to support as a status; changed only by an administrator, with a
 * reason that goes to the audit log.
 */
export function NetxSwitch({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  const { refreshRuntime } = useSession();
  const [status, setStatus] = useState<NetxStatus | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<NetxStatus>('/v1/admin/netx-payments'));
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return error ? <ErrorNotice error={error} onRetry={() => void load()} /> : null;

  const flip = async () => {
    if (reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      // The state shown is the server's answer, never the button's intent.
      setStatus(
        await apiFetch<NetxStatus>('/v1/admin/netx-payments', {
          method: 'PUT',
          body: { accepting: !status.accepting, reason: reason.trim() },
        }),
      );
      setReason('');
      await refreshRuntime();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" style={{ gap: 'var(--s2)' }}>
      <div className="row row--between" style={{ alignItems: 'center' }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>{t('admin.netx.h2')}</h2>
        <Badge tone={!status.configured ? '' : status.accepting ? 'badge--ok' : 'badge--warn'}>
          {!status.configured ? t('admin.netx.off') : status.accepting ? t('admin.netx.accepting') : t('admin.netx.paused')}
        </Badge>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {status.configured ? t('admin.netx.note', { yen: String(status.yenPerToken ?? '') }) : t('admin.netx.notConfigured')}
      </p>
      <ErrorNotice error={error} />
      {status.configured && isAdmin && (
        <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('admin.sc.reason')}
            aria-label={t('admin.sc.reason')}
            style={{ maxWidth: 420 }}
          />
          <button
            type="button"
            className={status.accepting ? 'btn btn--danger' : 'btn'}
            disabled={busy || reason.trim().length < 5}
            onClick={() => void flip()}
          >
            {status.accepting ? t('admin.netx.pause') : t('admin.netx.resume')}
          </button>
        </div>
      )}
    </section>
  );
}
