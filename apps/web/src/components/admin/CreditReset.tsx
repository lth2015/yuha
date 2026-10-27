import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, newIdempotencyKey } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { formatJst } from '../../lib/session';
import { Badge, ErrorNotice } from '../common';

interface ResetView {
  id: string;
  idempotencyKey: string;
  status: 'running' | 'done';
  reason: string;
  floor: number;
  bonus: number;
  windowStart: string;
  usersSeen: number;
  usersTopped: number;
  unitsTopped: number;
  usersBonus: number;
  unitsBonus: number;
  createdAt: string;
  finishedAt: string | null;
  active: boolean;
}

interface Overview {
  preview: {
    accounts: number;
    toppedAccounts: number;
    toppedUnits: number;
    bonusAccounts: number;
    bonusUnits: number;
    floor: number;
    bonus: number;
    windowStart: string;
  };
  resets: ResetView[];
}

/**
 * Credit reset (docs/CREDIT_RESET.md), admin only.
 *
 * What a reset started now would give is shown before the button, in
 * accounts and credits, because every credit is a generation the platform
 * pays for. The run happens on the server; this card polls it, and offers to
 * continue one a stopped process left unfinished.
 */
export function CreditReset() {
  const { t } = useI18n();
  const [data, setData] = useState<Overview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await apiFetch<Overview>('/v1/admin/credit-resets');
      setData(next);
      const live = next.resets.find((r) => r.status === 'running' && r.active);
      if (poll.current) clearTimeout(poll.current);
      if (live) poll.current = setTimeout(() => void load(), 1500);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [load]);

  if (!data) return error ? <ErrorNotice error={error} onRetry={() => void load()} /> : null;

  const p = data.preview;
  const unfinished = data.resets.find((r) => r.status === 'running');

  const run = async (key: string, why: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/v1/admin/credit-resets', { method: 'POST', body: { reason: why, idempotencyKey: key } });
      setReason('');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    const total = String(p.toppedUnits + p.bonusUnits);
    if (!window.confirm(t('admin.reset.confirm', { accounts: String(p.accounts), total }))) return;
    void run(newIdempotencyKey('reset'), reason.trim());
  };

  return (
    <section className="card stack" style={{ gap: 'var(--s2)' }}>
      <div className="row row--between" style={{ alignItems: 'center' }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>{t('admin.reset.h2')}</h2>
        {unfinished && <Badge tone="badge--warn">{t('admin.reset.running')}</Badge>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {t('admin.reset.rule', { floor: String(p.floor), bonus: String(p.bonus) })}
      </p>
      <ErrorNotice error={error} />

      {unfinished ? (
        <div className="stack" style={{ gap: 'var(--s2)' }}>
          <p style={{ margin: 0 }}>
            {t('admin.reset.progress', {
              seen: String(unfinished.usersSeen),
              topped: String(unfinished.unitsTopped),
              bonus: String(unfinished.unitsBonus),
            })}
          </p>
          {!unfinished.active && (
            <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="small muted">{t('admin.reset.stopped')}</span>
              <button type="button" className="btn" disabled={busy} onClick={() => void run(unfinished.idempotencyKey, unfinished.reason)}>
                {t('admin.reset.continue')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            {t('admin.reset.preview', {
              accounts: String(p.accounts),
              toppedAccounts: String(p.toppedAccounts),
              toppedUnits: String(p.toppedUnits),
              bonusAccounts: String(p.bonusAccounts),
              bonusUnits: String(p.bonusUnits),
              since: formatJst(p.windowStart, false),
            })}
          </p>
          <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('admin.sc.reason')}
              aria-label={t('admin.sc.reason')}
              style={{ maxWidth: 420 }}
            />
            <button type="button" className="btn btn--primary" disabled={busy || reason.trim().length < 3} onClick={start}>
              {t('admin.reset.start')}
            </button>
          </div>
        </>
      )}

      {data.resets.length > 0 && (
        <div className="table-wrap table-wrap--stack">
          <table>
            <thead>
              <tr>
                <th>{t('admin.reset.when')}</th>
                <th>{t('admin.reset.reason')}</th>
                <th>{t('admin.reset.topped')}</th>
                <th>{t('admin.reset.bonusCol')}</th>
              </tr>
            </thead>
            <tbody>
              {data.resets.map((r) => (
                <tr key={r.id}>
                  <td className="small">{formatJst(r.createdAt, true)}</td>
                  <td className="small">{r.reason}</td>
                  <td className="num">{t('admin.reset.cell', { units: String(r.unitsTopped), accounts: String(r.usersTopped) })}</td>
                  <td className="num">{t('admin.reset.cell', { units: String(r.unitsBonus), accounts: String(r.usersBonus) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
