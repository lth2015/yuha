import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { LOCALES, formatMoney } from '../../lib/money';
import { formatJst, useSession } from '../../lib/session';
import { Badge, ErrorNotice } from '../common';

/**
 * Every order across accounts, newest first, with how it was paid.
 *
 * Refunds happen in Stripe, by a person (docs/OPERATIONS.md §5), so a card
 * order links straight to its payment in the Stripe dashboard — the test-mode
 * dashboard when this deployment's publishable key is a test key, so an
 * operator is never sent to look for a sandbox payment in the live account.
 */
interface Row {
  orderId: string;
  userId: string;
  email: string;
  priceKey: string;
  kind: string;
  method: 'card' | 'jpyc' | 'usdc' | 'netx';
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  status: string;
  heldForReview: boolean;
  entitlementGranted: boolean;
  stripePaymentIntent: string | null;
  createdAt: string;
  paidAt: string | null;
}

const STATUSES = ['', 'pending', 'paid', 'refunded', 'partially_refunded', 'failed', 'canceled'] as const;
const METHODS = ['', 'card', 'jpyc', 'usdc', 'netx'] as const;

export function OrdersPanel() {
  const { t, lang } = useI18n();
  const { runtime } = useSession();
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [email, setEmail] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const stripeBase = runtime?.stripePublishableKey?.startsWith('pk_test_')
    ? 'https://dashboard.stripe.com/test/payments/'
    : 'https://dashboard.stripe.com/payments/';

  const load = useCallback(
    async (append: boolean, before?: string) => {
      setBusy(true);
      setError(null);
      try {
        const qs = new URLSearchParams();
        if (status) qs.set('status', status);
        if (method) qs.set('method', method);
        if (email.trim()) qs.set('email', email.trim());
        if (before) qs.set('before', before);
        const res = await apiFetch<{ items: Row[]; more: boolean }>(`/v1/admin/orders?${qs.toString()}`);
        setRows((r) => (append ? [...r, ...res.items] : res.items));
        setMore(res.more);
      } catch (err) {
        setError(err);
      } finally {
        setBusy(false);
      }
    },
    [status, method, email],
  );

  useEffect(() => {
    void load(false);
    // Filters apply on change for the two selects; email applies on submit.
  }, [status, method]);

  return (
    <section className="stack">
      <form
        className="row admin-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void load(false);
        }}
      >
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('admin.orders.status')}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s || t('admin.orders.allStatuses')}
            </option>
          ))}
        </select>
        <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label={t('admin.orders.method')}>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m === '' ? t('admin.orders.allMethods') : m === 'card' ? t('admin.dash.card') : m.toUpperCase()}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('admin.orders.email')}
          aria-label={t('admin.orders.email')}
        />
        <button type="submit" className="btn btn--ghost btn--sm" disabled={busy}>
          {t('admin.cust.search.go')}
        </button>
      </form>

      <ErrorNotice error={error} onRetry={() => void load(false)} />

      {rows.length === 0 && !busy ? (
        <p className="muted small">{t('admin.orders.none')}</p>
      ) : (
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>{t('admin.orders.col.when')}</th>
                <th>{t('admin.cust.col.email')}</th>
                <th>{t('admin.cust.orders.col.what')}</th>
                <th>{t('admin.orders.method')}</th>
                <th>{t('admin.sc.col.amount')}</th>
                <th>{t('admin.orders.status')}</th>
                <th>{t('admin.orders.col.delivered')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.orderId}>
                  <td className="muted">{formatJst(o.createdAt, true)}</td>
                  <td>{o.email}</td>
                  <td>{o.priceKey}</td>
                  <td>{o.method === 'card' ? t('admin.dash.card') : o.method.toUpperCase()}</td>
                  <td className="num">
                    {formatMoney(o.amountMinor, o.currency, LOCALES[lang])}
                    {o.refundedMinor > 0 && (
                      <div className="muted">
                        {t('admin.orders.refunded')} {formatMoney(o.refundedMinor, o.currency, LOCALES[lang])}
                      </div>
                    )}
                  </td>
                  <td>
                    {o.status}
                    {o.heldForReview && (
                      <>
                        {' '}
                        <Badge tone="badge--warn">{t('admin.orders.held')}</Badge>
                      </>
                    )}
                  </td>
                  <td>{o.entitlementGranted ? '✓' : '—'}</td>
                  <td>
                    {o.stripePaymentIntent && (
                      <a href={`${stripeBase}${o.stripePaymentIntent}`} target="_blank" rel="noreferrer">
                        Stripe ↗
                      </a>
                    )}
                  </td>
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
