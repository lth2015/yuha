import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EntitlementsView, OrderView } from '@yuha/contracts';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { formatJst, useSession } from '../lib/session';
import { useI18n } from '../lib/i18n';
import { LOCALES, formatMoney } from '../lib/money';
import { Badge, ErrorNotice, Loading } from '../components/common';

/**
 * The contract type, not a hand-written copy. The local duplicate had drifted:
 * it lacked `currency`, so amounts were formatted as USD whatever the order
 * actually was, and lacked `displayName`, which is why the item column was
 * guessing at the product from its price key.
 */
type OrderRow = OrderView & { createdAtJst: string };

const ORDER_STATUS: Record<string, { key: string; tone: string }> = {
  pending: { key: 'bill.st.pending', tone: 'badge--warn' },
  paid: { key: 'bill.st.paid', tone: 'badge--ok' },
  failed: { key: 'bill.st.failed', tone: 'badge--danger' },
  refunded: { key: 'bill.st.refunded', tone: '' },
  partially_refunded: { key: 'bill.st.partially_refunded', tone: '' },
  canceled: { key: 'bill.st.canceled', tone: '' },
};

const SUBSCRIPTION_STATUS: Record<string, { key: string; tone: string }> = {
  active: { key: 'bill.sub.active', tone: 'badge--ok' },
  trialing: { key: 'bill.sub.trialing', tone: 'badge--ok' },
  past_due: { key: 'bill.sub.past_due', tone: 'badge--warn' },
  canceled: { key: 'bill.sub.canceled', tone: '' },
  unpaid: { key: 'bill.sub.unpaid', tone: 'badge--danger' },
  incomplete: { key: 'bill.sub.incomplete', tone: 'badge--warn' },
  paused: { key: 'bill.sub.paused', tone: '' },
};

/**
 * UI-11: billing and subscription management.
 *
 * The cancellation success state is rendered only after the server confirms it.
 * A failed call leaves the subscription shown as active and offers a retry —
 * the interface never optimistically claims a cancellation that did not happen.
 */
export default function Billing() {
  const { entitlements, refreshEntitlements } = useSession();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [ent, setEnt] = useState<EntitlementsView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const { t, lang } = useI18n();
  const [cancelling, setCancelling] = useState(false);
  const [cancelResult, setCancelResult] = useState<{ effectiveAt: string | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [o, e] = await Promise.all([
        apiFetch<{ items: OrderRow[] }>('/v1/orders'),
        apiFetch<EntitlementsView>('/v1/entitlements'),
      ]);
      setOrders(o.items);
      setEnt(e);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const subscription = ent?.subscription ?? entitlements?.subscription ?? null;

  const cancelSubscription = async () => {
    if (!subscription) return;
    const ok = window.confirm(
      t('bill.cancelConfirm', { date: subscription.endsAtJst ?? '—' }),
    );
    if (!ok) return;

    setCancelling(true);
    setError(null);
    try {
      const res = await apiFetch<{ cancelAtPeriodEnd: boolean; effectiveAt: string | null }>(
        '/v1/subscription/cancel',
        {
          method: 'POST',
          body: {
            subscriptionId: subscription.subscriptionId,
            idempotencyKey: newIdempotencyKey('cancel'),
          },
        },
      );
      // Success is displayed only because the server confirmed it. A failure
      // falls through to the catch and leaves the subscription shown as active.
      if (res.cancelAtPeriodEnd) setCancelResult({ effectiveAt: res.effectiveAt });
      await load();
      await refreshEntitlements();
    } catch (err) {
      setError(err);
    } finally {
      setCancelling(false);
    }
  };

  if (loading) return <Loading label={t('bill.loading')} />;

  return (
    <div className="stack stack--loose">
      <h1 className="page-title">{t('bill.h1')}</h1>

      <ErrorNotice error={error} onRetry={() => void load()} />

      <section className="panel stack">
        <h2 className="section-title">{t('bill.credits')}</h2>
        <div className="row" style={{ gap: 'var(--s3)' }}>
          {/*
            A dash, not a zero. `ent` is null both before the first load and
            after a failed one, so `?? 0` told a paying customer they had no
            credits, in large type, next to the banner saying the page had
            failed. Telling somebody nothing is better than telling them
            something false about their balance.
          */}
          <div>
            <div className="num credit-figure">{ent ? ent.availableUnits : '—'}</div>
            <div className="small muted">{t('bill.available')}</div>
          </div>
          <div>
            <div className="num credit-figure">{ent ? ent.reservedUnits : '—'}</div>
            <div className="small muted">{t('bill.reserved')}</div>
          </div>
        </div>

        {ent && ent.batches.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('bill.tbl.kind')}</th>
                  <th>{t('bill.tbl.granted')}</th>
                  <th>{t('bill.tbl.left')}</th>
                  <th>{t('bill.tbl.expires')}</th>
                </tr>
              </thead>
              <tbody>
                {ent.batches.map((b) => (
                  <tr key={b.batchId}>
                    <td>
                      {b.source === 'one_time_order'
                        ? t('bill.src.one_time')
                        : b.source === 'subscription_period'
                          ? t('bill.src.subscription')
                          : b.source === 'compensation'
                            ? t('bill.src.compensation')
                            : b.source === 'promo_trial'
                              ? t('bill.src.trial')
                              : t('bill.src.adjust')}
                    </td>
                    <td className="num">{b.grantedUnits}</td>
                    <td className="num">{b.availableUnits}</td>
                    <td className="small muted">
                      {b.expiresAt ? formatJst(b.expiresAt, false) : t('bill.noExpiry')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          {t('bill.spendOrder')}
        </p>
      </section>

      <section className="panel stack">
        <h2 className="section-title">{t('bill.plan')}</h2>

        {!subscription ? (
          <>
            <p className="muted" style={{ margin: 0 }}>
              {t('bill.noPlan')}
            </p>
            <Link className="btn btn--secondary" to="/pricing">
              {t('bill.seePricing')}
            </Link>
          </>
        ) : (
          <>
            <div className="row row--between">
              <span className="muted">{t('bill.status')}</span>
              <Badge tone={SUBSCRIPTION_STATUS[subscription.status]?.tone ?? ''}>
                {SUBSCRIPTION_STATUS[subscription.status]
                  ? t(SUBSCRIPTION_STATUS[subscription.status]!.key)
                  : subscription.status}
              </Badge>
            </div>
            <div className="row row--between">
              <span className="muted">{t('bill.period')}</span>
              <span className="small">
                {formatJst(subscription.currentPeriodStart, false)} 〜{' '}
                {formatJst(subscription.currentPeriodEnd, false)}
              </span>
            </div>
            <div className="row row--between">
              <span className="muted">{t('bill.renews')}</span>
              <span className="small">
                {subscription.cancelAtPeriodEnd
                  ? t('bill.autoRenewOff')
                  : `${subscription.endsAtJst ?? '—'}（JST）`}
              </span>
            </div>

            {subscription.status === 'past_due' && (
              <div className="alert alert--warn">
                <div className="alert__title">{t('bill.pastDueTitle')}</div>
                <div className="small">{t('bill.pastDue')}</div>
              </div>
            )}

            {cancelResult ? (
              <div className="alert alert--info">
                <div className="alert__title">{t('bill.cancelledTitle')}</div>
                <div className="small">
                  {t('bill.cancelledBody', { date: `${formatJst(cancelResult.effectiveAt)} (JST)` })}
                </div>
              </div>
            ) : subscription.cancelAtPeriodEnd ? (
              <div className="alert alert--info small">
                {t('bill.alreadyCancelled', { date: `${subscription.endsAtJst ?? '—'} (JST)` })}
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void cancelSubscription()}
                disabled={cancelling}
              >
                {cancelling ? t('bill.cancelling') : t('bill.cancel')}
              </button>
            )}

            <p className="small muted" style={{ margin: 0 }}>
              {t('bill.cancelNote')}
            </p>
          </>
        )}
      </section>

      <section className="panel stack">
        <h2 className="section-title">{t('bill.history')}</h2>
        {orders.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {t('bill.noHistory')}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('bill.tbl.when')} (JST)</th>
                  <th>{t('bill.tbl.item')}</th>
                  <th>{t('bill.tbl.amount')}</th>
                  <th>{t('bill.status')}</th>
                  <th>{t('bill.tbl.grantCol')}</th>
                  <th>{t('bill.tbl.receipt')}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const st = ORDER_STATUS[o.status];
                  return (
                    <tr key={o.orderId}>
                      <td className="small">{o.createdAtJst}</td>
                      <td className="small">
                        {/* The catalogue's name at purchase time. This used to be a
                            two-way guess that labelled every non-drop_5 order
                            "CREATOR（月額20回）" — a Premier buyer's receipt named a
                            plan they had not bought. */}
                        {o.displayName ?? o.priceKey}
                      </td>
                      <td className="num">{formatMoney(o.amountMinor, o.currency, LOCALES[lang])}</td>
                      <td>
                        <Badge tone={st?.tone ?? ''}>{st ? t(st.key) : o.status}</Badge>
                      </td>
                      <td className="small">
                        {o.entitlementGranted ? (
                          t('bill.granted')
                        ) : o.status === 'paid' ? (
                          <span className="is-warning">{t('bill.processing')}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="small">
                        {o.receiptUrl ? (
                          <a href={o.receiptUrl} target="_blank" rel="noreferrer">
                            {t('bill.view')}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel stack">
        <h2 className="section-title">{t('bill.account')}</h2>
        <div className="row">
          <Link className="btn btn--ghost" to="/settings/account">
            {t('bill.accountSettings')}
          </Link>
        </div>
      </section>
    </div>
  );
}
