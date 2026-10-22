import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { formatJst } from '../../lib/session';
import { ErrorNotice } from '../common';

/**
 * Who did what to whom, and why. Every privileged action writes a row with a
 * stated reason (UI-15); this is where those rows are read. Opening a
 * customer's record is audited too, and hidden by default here because a
 * list of every look drowns the changes.
 */
interface Row {
  id: string;
  action: string;
  actorEmail: string | null;
  actorRole: string;
  subjectType: string;
  subjectId: string;
  subjectEmail: string | null;
  reason: string;
  createdAt: string;
}

export function AuditPanel() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [action, setAction] = useState('');
  const [showReads, setShowReads] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (append: boolean, before?: string) => {
      setBusy(true);
      setError(null);
      try {
        const qs = new URLSearchParams();
        if (email.trim()) qs.set('email', email.trim());
        if (action.trim()) qs.set('action', action.trim());
        if (before) qs.set('before', before);
        const res = await apiFetch<{ items: Row[]; more: boolean }>(`/v1/admin/audit?${qs.toString()}`);
        setRows((r) => (append ? [...r, ...res.items] : res.items));
        setMore(res.more);
      } catch (err) {
        setError(err);
      } finally {
        setBusy(false);
      }
    },
    [email, action],
  );

  useEffect(() => {
    void load(false);
  }, []);

  const visible = showReads ? rows : rows.filter((r) => r.action !== 'customer.opened');

  return (
    <section className="stack">
      <form
        className="row admin-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void load(false);
        }}
      >
        <input
          type="search"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('admin.audit.email')}
          aria-label={t('admin.audit.email')}
        />
        <input
          type="search"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder={t('admin.audit.action')}
          aria-label={t('admin.audit.action')}
        />
        <button type="submit" className="btn btn--ghost btn--sm" disabled={busy}>
          {t('admin.cust.search.go')}
        </button>
        <label className="small">
          <input type="checkbox" checked={showReads} onChange={(e) => setShowReads(e.target.checked)} />{' '}
          {t('admin.audit.showReads')}
        </label>
      </form>
      <ErrorNotice error={error} onRetry={() => void load(false)} />
      {visible.length === 0 && !busy ? (
        <p className="muted small">{t('admin.audit.none')}</p>
      ) : (
        <div className="table-wrap table-wrap--stack">
          <table className="small">
            <thead>
              <tr>
                <th>{t('admin.orders.col.when')}</th>
                <th>{t('admin.audit.col.actor')}</th>
                <th>{t('admin.audit.col.action')}</th>
                <th>{t('admin.audit.col.subject')}</th>
                <th>{t('admin.audit.col.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{formatJst(r.createdAt, true)}</td>
                  <td>
                    {r.actorEmail ?? '—'}
                    <div className="muted">{r.actorRole}</div>
                  </td>
                  <td>
                    <code>{r.action}</code>
                  </td>
                  <td>{r.subjectEmail ?? `${r.subjectType}:${r.subjectId.slice(0, 8)}`}</td>
                  <td>{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={busy}
          onClick={() => void load(true, rows[rows.length - 1]?.createdAt)}
        >
          {t('admin.more')}
        </button>
      )}
    </section>
  );
}
