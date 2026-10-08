import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatJst, formatMoney, useSession } from '../lib/session';
import { LOCALES } from '../lib/money';
import { mayDecidePayments } from '../lib/stablecoin';
import { Badge, ErrorNotice } from './common';

/**
 * Card orders held before delivery, and the two things to do about one.
 *
 * ⑥ in `docs/FRAUD_PREVENTION.md` was real for the stablecoin channel and
 * absent for the card one. What is held is delivery and never the payment, so
 * every row here is money already taken from somebody — which is why the
 * default thresholds hold almost nothing, why the queue is ordered
 * oldest-first, and why the reason is a field in the row rather than a modal:
 * the person on the other side is waiting.
 *
 * `release` hands over what was bought, through the same path both channels
 * and the recovery sweep use. `refuse` delivers nothing and does NOT refund —
 * the refund happens in Stripe, by a person, and the copy says so rather than
 * letting a button imply it.
 */

interface HeldOrder {
  reviewId: string;
  orderId: string;
  userId: string;
  userEmail: string | null;
  priceKey: string;
  amountMinor: number;
  currency: string;
  reasons: string[];
  heldAt: string;
  paidAt: string | null;
}

export function HeldOrderConsole() {
  const { t, lang } = useI18n();
  const { me } = useSession();
  const [items, setItems] = useState<HeldOrder[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});

  const mayDecide = mayDecidePayments(me?.role);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch<{ items: HeldOrder[] }>('/v1/admin/order-reviews');
      setItems(res.items);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reasonFor = (id: string) => (reason[id] ?? '').trim();

  const decide = async (reviewId: string, decision: 'release' | 'refuse') => {
    if (!mayDecide) return;
    const why = reasonFor(reviewId);
    if (why.length < 3) return;
    setBusy(reviewId);
    setError(null);
    try {
      await apiFetch(`/v1/admin/order-reviews/${reviewId}/decide`, {
        method: 'POST',
        body: { decision, reason: why },
      });
      setReason((r) => ({ ...r, [reviewId]: '' }));
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="stack">
      <div className="row row--between">
        <h2 style={{ fontSize: 18, margin: 0 }}>{t('admin.held.h2')}</h2>
        <button type="button" className="btn btn--ghost" onClick={() => void load()}>
          {t('admin.sc.refresh')}
        </button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {t('admin.held.note')}
      </p>

      <ErrorNotice error={error} onRetry={() => void load()} />
      {!mayDecide && <p className="small muted">{t('admin.sc.readOnly')}</p>}

      {!items || items.length === 0 ? (
        <p className="muted small">{t('admin.held.none')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('admin.held.col.customer')}</th>
                <th>{t('admin.held.col.what')}</th>
                <th>{t('admin.sc.col.amount')}</th>
                <th>{t('admin.held.col.why')}</th>
                <th>{t('admin.held.col.since')}</th>
                <th>{t('admin.sc.col.reasonAndAction')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.reviewId}>
                  <td className="small">
                    {o.userEmail ?? '—'}
                    <div className="small muted" style={{ fontFamily: 'var(--mono)' }}>
                      {o.orderId.slice(0, 8)}
                    </div>
                  </td>
                  <td className="small">{o.priceKey}</td>
                  <td className="num small">{formatMoney(o.amountMinor, o.currency, LOCALES[lang])}</td>
                  <td className="small">
                    <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                      {o.reasons.map((r) => (
                        <Badge key={r} tone="badge--warn">
                          {t(`admin.held.reason.${r}`)}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="small muted">{formatJst(o.heldAt, false)}</td>
                  <td>
                    <div className="stack" style={{ gap: 'var(--s2)' }}>
                      <input
                        type="text"
                        value={reason[o.reviewId] ?? ''}
                        onChange={(e) => setReason((r) => ({ ...r, [o.reviewId]: e.target.value }))}
                        placeholder={t('admin.sc.reason')}
                        aria-label={t('admin.sc.reason')}
                        disabled={!mayDecide}
                      />
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn--ghost"
                          disabled={!mayDecide || busy !== null || reasonFor(o.reviewId).length < 3}
                          onClick={() => void decide(o.reviewId, 'release')}
                        >
                          {t('admin.held.release')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--danger"
                          disabled={!mayDecide || busy !== null || reasonFor(o.reviewId).length < 3}
                          onClick={() => void decide(o.reviewId, 'refuse')}
                        >
                          {t('admin.held.refuse')}
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
      <p className="small muted" style={{ margin: 0 }}>
        {t('admin.held.refundNote')}
      </p>
    </section>
  );
}
