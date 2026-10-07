import { useCallback, useEffect, useState } from 'react';
import { apiFetch, apiFetchText } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatJst, useSession } from '../lib/session';
import { amountGap, formatAtomic, jstMonthRange, mayDecidePayments } from '../lib/stablecoin';
import { Badge, ErrorNotice } from './common';

/**
 * What an operator can do about a stablecoin payment.
 *
 * Every action here already existed as an endpoint and none of them could be
 * reached: the review queue, the money with no order to attach it to, and the
 * refunds owed were all listed by the API and had no interface at all. The
 * repair path added for the orphaned-money defect was usable and not
 * clickable, which for a defect that strands a customer's payment is barely
 * better than not having it.
 *
 * Three properties this component is arranged around:
 *
 *   - **It loads its own data.** A failing stablecoin endpoint must not blank
 *     the rest of the operations console, which is how the console loses the
 *     job queue and the ledger discrepancies over a payment feature that is
 *     off on most deployments.
 *   - **The reason is in the form, not in a `window.prompt`.** A mandatory
 *     reason typed into a modal that cannot be reviewed or corrected is a
 *     reason people learn to type "ok" into. The audit row is the point.
 *   - **`support` sees everything and decides nothing**, and the same
 *     expression decides whether a button renders and whether the action runs.
 */

interface ReviewItem {
  intent_id: string;
  order_id: string;
  user_id: string;
  state: string;
  payer: string;
  chain_id: number;
  token_key: string;
  expected_atomic: string;
  price_jpy: number;
  quote_expires_at: string;
  received_atomic: string | null;
  tx_hash: string | null;
  log_index: number | null;
  order_status: string;
  created_at: string;
}

interface OrphanRow {
  id: string;
  txHash: string;
  logIndex: number;
  from: string;
  token: string;
  amountAtomic: string;
  blockNumber: string;
  reason: string;
}

interface RefundOwed {
  txHash: string;
  from: string;
  amountAtomic: string;
  owedSince: string;
  orderId: string | null;
}

interface Queue {
  payments: ReviewItem[];
  unattributed: OrphanRow[];
  refundsOwed: RefundOwed[];
}

export function StablecoinConsole() {
  const { t } = useI18n();
  const { me, runtime } = useSession();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [attachTo, setAttachTo] = useState<Record<string, string>>({});
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [exportNote, setExportNote] = useState<string | null>(null);

  const mayDecide = mayDecidePayments(me?.role);

  /*
   * Precision comes from the runtime descriptor, never from a constant in this
   * bundle. A currency's decimals decide the scale of every number on this
   * screen, and an operator deciding whether to accept a payment short by one
   * unit must not be reading a figure this file scaled by itself. When the
   * token is one we were not told about, the raw atomic figure is shown — a
   * long number is obviously raw, where a wrongly scaled one is not.
   */
  const tokens = runtime?.stablecoin.tokens ?? [];
  const decimalsForKey = (key: string): number | null =>
    tokens.find((x) => x.key === key)?.decimals ?? null;
  const decimalsForAddress = (address: string): number | null =>
    tokens.find((x) => x.address.toLowerCase() === address.toLowerCase())?.decimals ?? null;
  const amountText = (atomic: string, decimals: number | null): string =>
    decimals === null ? atomic : formatAtomic(atomic, decimals);

  const load = useCallback(async () => {
    setError(null);
    try {
      setQueue(await apiFetch<Queue>('/v1/admin/stablecoin-payments'));
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reasonFor = (key: string) => (reason[key] ?? '').trim();

  const decideReview = async (intentId: string, decision: 'accept_as_paid' | 'reject') => {
    if (!mayDecide) return;
    const why = reasonFor(intentId);
    if (why.length < 3) return;
    setBusy(intentId);
    setError(null);
    try {
      await apiFetch(`/v1/admin/stablecoin-payments/${intentId}/review`, {
        method: 'POST',
        body: { decision, reason: why },
      });
      setReason((r) => ({ ...r, [intentId]: '' }));
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const decideTransfer = async (id: string, decision: 'attach_to_order' | 'dismiss') => {
    if (!mayDecide) return;
    const why = reasonFor(id);
    if (why.length < 3) return;
    const orderId = (attachTo[id] ?? '').trim();
    if (decision === 'attach_to_order' && !orderId) return;
    setBusy(id);
    setError(null);
    try {
      await apiFetch(`/v1/admin/stablecoin-transfers/${id}/decide`, {
        method: 'POST',
        body: { decision, reason: why, ...(decision === 'attach_to_order' ? { orderId } : {}) },
      });
      setReason((r) => ({ ...r, [id]: '' }));
      setAttachTo((a) => ({ ...a, [id]: '' }));
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const downloadCsv = async () => {
    const range = jstMonthRange(month);
    if (!range) {
      setExportNote(t('admin.sc.export.badMonth'));
      return;
    }
    setBusy('export');
    setError(null);
    setExportNote(null);
    try {
      const csv = await apiFetchText(
        `/v1/admin/accounting/stablecoin-export?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      );
      /*
       * Through a fetch and a Blob rather than a link, because the endpoint
       * needs the bearer token: a plain `<a href>` would download an HTML
       * error page named `.csv`. The row count is reported back, so an empty
       * month is visibly empty rather than a file nobody opens.
       */
      const rows = csv.trim() === '' ? 0 : csv.trim().split('\n').length - 1;
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `stablecoin-${month}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setExportNote(t('admin.sc.export.done', { rows: String(rows), month }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  // Off on this deployment: say so once rather than rendering three empty
  // tables that read as "no problems".
  if (!runtime?.stablecoin.enabled) {
    return (
      <section className="stack">
        <h2 style={{ fontSize: 18 }}>{t('admin.sc.h2')}</h2>
        <p className="muted small">{t('admin.sc.channelOff')}</p>
      </section>
    );
  }

  const reasonField = (key: string) => (
    <input
      type="text"
      value={reason[key] ?? ''}
      onChange={(e) => setReason((r) => ({ ...r, [key]: e.target.value }))}
      placeholder={t('admin.sc.reason')}
      aria-label={t('admin.sc.reason')}
      disabled={!mayDecide}
    />
  );

  return (
    <section className="stack">
      <div className="row row--between">
        <h2 style={{ fontSize: 18, margin: 0 }}>{t('admin.sc.h2')}</h2>
        <button type="button" className="btn btn--ghost" onClick={() => void load()}>
          {t('admin.sc.refresh')}
        </button>
      </div>

      <ErrorNotice error={error} onRetry={() => void load()} />

      {!mayDecide && <p className="small muted">{t('admin.sc.readOnly')}</p>}

      {/* ---------------------------------------------- payments in review */}
      <h3 style={{ fontSize: 16, margin: 0 }}>{t('admin.sc.review.h3')}</h3>
      <p className="small muted" style={{ margin: 0 }}>
        {t('admin.sc.review.note')}
      </p>
      {!queue || queue.payments.length === 0 ? (
        <p className="muted small">{t('admin.sc.review.none')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('admin.sc.col.order')}</th>
                <th>{t('admin.sc.col.expected')}</th>
                <th>{t('admin.sc.col.received')}</th>
                <th>{t('admin.sc.col.gap')}</th>
                <th>{t('admin.sc.col.payer')}</th>
                <th>{t('admin.sc.col.when')}</th>
                <th>{t('admin.sc.col.reasonAndAction')}</th>
              </tr>
            </thead>
            <tbody>
              {queue.payments.map((p) => {
                const decimals = decimalsForKey(p.token_key);
                const gap = amountGap(p.expected_atomic, p.received_atomic);
                return (
                  <tr key={p.intent_id}>
                    <td className="small" style={{ fontFamily: 'var(--mono)' }}>
                      {p.order_id.slice(0, 8)}
                      <div className="small muted">{p.order_status}</div>
                    </td>
                    <td className="num small">
                      {amountText(p.expected_atomic, decimals)} {p.token_key.toUpperCase()}
                    </td>
                    <td className="num small">
                      {p.received_atomic ? amountText(p.received_atomic, decimals) : '—'}
                    </td>
                    <td className="small">
                      {gap === null ? (
                        <Badge tone="badge--warn">{t('admin.sc.gap.nothing')}</Badge>
                      ) : gap.direction === 'exact' ? (
                        <Badge>{t('admin.sc.gap.exact')}</Badge>
                      ) : (
                        <Badge tone="badge--warn">
                          {t(`admin.sc.gap.${gap.direction}`, {
                            amount: amountText(gap.magnitude, decimals),
                          })}
                        </Badge>
                      )}
                    </td>
                    <td className="small" style={{ fontFamily: 'var(--mono)' }}>
                      {p.payer.slice(0, 10)}…
                    </td>
                    <td className="small muted">{formatJst(p.created_at, false)}</td>
                    <td>
                      <div className="stack" style={{ gap: 'var(--s2)' }}>
                        {reasonField(p.intent_id)}
                        <div className="row">
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={!mayDecide || busy !== null || reasonFor(p.intent_id).length < 3}
                            onClick={() => void decideReview(p.intent_id, 'accept_as_paid')}
                          >
                            {t('admin.sc.review.accept')}
                          </button>
                          <button
                            type="button"
                            className="btn btn--danger"
                            disabled={!mayDecide || busy !== null || reasonFor(p.intent_id).length < 3}
                            onClick={() => void decideReview(p.intent_id, 'reject')}
                          >
                            {t('admin.sc.review.reject')}
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------------------- money with no order */}
      <h3 style={{ fontSize: 16, margin: 0 }}>{t('admin.sc.orphan.h3')}</h3>
      <p className="small muted" style={{ margin: 0 }}>
        {t('admin.sc.orphan.note')}
      </p>
      {!queue || queue.unattributed.length === 0 ? (
        <p className="muted small">{t('admin.sc.orphan.none')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('admin.sc.col.tx')}</th>
                <th>{t('admin.sc.col.amount')}</th>
                <th>{t('admin.sc.col.from')}</th>
                <th>{t('admin.sc.col.why')}</th>
                <th>{t('admin.sc.col.reasonAndAction')}</th>
              </tr>
            </thead>
            <tbody>
              {queue.unattributed.map((o) => (
                <tr key={o.id}>
                  <td className="small" style={{ fontFamily: 'var(--mono)' }}>
                    {o.txHash.slice(0, 10)}…
                    <div className="small muted">#{o.logIndex}</div>
                  </td>
                  <td className="num small">{amountText(o.amountAtomic, decimalsForAddress(o.token))}</td>
                  <td className="small" style={{ fontFamily: 'var(--mono)' }}>
                    {o.from.slice(0, 10)}…
                  </td>
                  <td className="small muted">{o.reason}</td>
                  <td>
                    <div className="stack" style={{ gap: 'var(--s2)' }}>
                      <input
                        type="text"
                        value={attachTo[o.id] ?? ''}
                        onChange={(e) => setAttachTo((a) => ({ ...a, [o.id]: e.target.value }))}
                        placeholder={t('admin.sc.orphan.orderId')}
                        aria-label={t('admin.sc.orphan.orderId')}
                        disabled={!mayDecide}
                        style={{ fontFamily: 'var(--mono)' }}
                      />
                      {reasonField(o.id)}
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn--ghost"
                          disabled={
                            !mayDecide ||
                            busy !== null ||
                            reasonFor(o.id).length < 3 ||
                            !(attachTo[o.id] ?? '').trim()
                          }
                          onClick={() => void decideTransfer(o.id, 'attach_to_order')}
                        >
                          {t('admin.sc.orphan.attach')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--danger"
                          disabled={!mayDecide || busy !== null || reasonFor(o.id).length < 3}
                          onClick={() => void decideTransfer(o.id, 'dismiss')}
                        >
                          {t('admin.sc.orphan.dismiss')}
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------------------------- refunds owed */}
      <h3 style={{ fontSize: 16, margin: 0 }}>{t('admin.sc.owed.h3')}</h3>
      <p className="small muted" style={{ margin: 0 }}>
        {t('admin.sc.owed.note')}
      </p>
      {!queue || queue.refundsOwed.length === 0 ? (
        <p className="muted small">{t('admin.sc.owed.none')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('admin.sc.col.tx')}</th>
                <th>{t('admin.sc.col.amountAtomic')}</th>
                <th>{t('admin.sc.col.from')}</th>
                <th>{t('admin.sc.col.order')}</th>
                <th>{t('admin.sc.col.since')}</th>
              </tr>
            </thead>
            <tbody>
              {queue.refundsOwed.map((r) => (
                <tr key={`${r.txHash}-${r.from}`}>
                  <td className="small" style={{ fontFamily: 'var(--mono)' }}>
                    {r.txHash.slice(0, 10)}…
                  </td>
                  <td className="num small">{r.amountAtomic}</td>
                  <td className="small" style={{ fontFamily: 'var(--mono)' }}>
                    {r.from.slice(0, 10)}…
                  </td>
                  <td className="small" style={{ fontFamily: 'var(--mono)' }}>
                    {r.orderId ? r.orderId.slice(0, 8) : '—'}
                  </td>
                  <td className="small muted">{formatJst(r.owedSince, false)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------------------------------------- monthly export */}
      <h3 style={{ fontSize: 16, margin: 0 }}>{t('admin.sc.export.h3')}</h3>
      <p className="small muted" style={{ margin: 0 }}>
        {t('admin.sc.export.note')}
      </p>
      <div className="row">
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          aria-label={t('admin.sc.export.month')}
        />
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void downloadCsv()}
        >
          {busy === 'export' ? t('admin.sc.export.working') : t('admin.sc.export.cta')}
        </button>
      </div>
      {exportNote && <p className="small muted">{exportNote}</p>}
    </section>
  );
}
