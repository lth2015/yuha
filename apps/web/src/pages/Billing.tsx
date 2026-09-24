import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EntitlementsView } from '@yuha/contracts';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { formatMoney, formatJst, useSession } from '../lib/session';
import { Badge, ErrorNotice, Loading } from '../components/common';

interface OrderRow {
  orderId: string;
  priceKey: string;
  kind: string;
  amountMinor: number;
  status: string;
  entitlementGranted: boolean;
  createdAt: string;
  createdAtJst: string;
  paidAt: string | null;
  receiptUrl: string | null;
}

const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: '確認中', tone: 'badge--warn' },
  paid: { label: '支払い済み', tone: 'badge--ok' },
  failed: { label: '失敗', tone: 'badge--danger' },
  refunded: { label: '返金済み', tone: '' },
  partially_refunded: { label: '一部返金', tone: '' },
  canceled: { label: 'キャンセル', tone: '' },
};

const SUBSCRIPTION_STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: '有効', tone: 'badge--ok' },
  trialing: { label: 'お試し中', tone: 'badge--ok' },
  past_due: { label: 'お支払い確認できず', tone: 'badge--warn' },
  canceled: { label: '停止済み', tone: '' },
  unpaid: { label: '未払い', tone: 'badge--danger' },
  incomplete: { label: '手続き中', tone: 'badge--warn' },
  paused: { label: '一時停止', tone: '' },
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
      '自動更新を停止します。\n\n' +
        `現在の期間（${subscription.endsAtJst ?? '—'}）の終了までは引き続きご利用いただけます。\n` +
        '次回以降の請求は発生しません。\n\n停止しますか？',
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

  if (loading) return <Loading label="請求情報を読み込み中" />;

  return (
    <div className="stack stack--loose">
      <h1 style={{ fontSize: 28 }}>請求・契約</h1>

      <ErrorNotice error={error} onRetry={() => void load()} />

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>残り回数</h2>
        <div className="row" style={{ gap: 'var(--s3)' }}>
          <div>
            <div style={{ fontSize: 30, fontWeight: 700 }} className="num">
              {ent?.availableUnits ?? 0}
            </div>
            <div className="small muted">利用できる回数</div>
          </div>
          <div>
            <div style={{ fontSize: 30, fontWeight: 700 }} className="num">
              {ent?.reservedUnits ?? 0}
            </div>
            <div className="small muted">処理中に確保</div>
          </div>
        </div>

        {ent && ent.batches.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>種別</th>
                  <th>付与</th>
                  <th>残り</th>
                  <th>有効期限</th>
                </tr>
              </thead>
              <tbody>
                {ent.batches.map((b) => (
                  <tr key={b.batchId}>
                    <td>
                      {b.source === 'one_time_order'
                        ? '単発パック'
                        : b.source === 'subscription_period'
                          ? '月額プラン'
                          : b.source === 'compensation'
                            ? '補償'
                            : b.source === 'promo_trial'
                              ? '試用'
                              : '調整'}
                    </td>
                    <td className="num">{b.grantedUnits}</td>
                    <td className="num">{b.availableUnits}</td>
                    <td className="small muted">
                      {b.expiresAt ? formatJst(b.expiresAt, false) : '期限なし'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          有効期限が近い回数から先に消費されます。
        </p>
      </section>

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>月額プラン</h2>

        {!subscription ? (
          <>
            <p className="muted" style={{ margin: 0 }}>
              現在ご契約中の月額プランはありません。
            </p>
            <Link className="btn btn--secondary" to="/pricing">
              料金を見る
            </Link>
          </>
        ) : (
          <>
            <div className="row row--between">
              <span className="muted">状態</span>
              <Badge tone={SUBSCRIPTION_STATUS[subscription.status]?.tone ?? ''}>
                {SUBSCRIPTION_STATUS[subscription.status]?.label ?? subscription.status}
              </Badge>
            </div>
            <div className="row row--between">
              <span className="muted">現在の期間</span>
              <span className="small">
                {formatJst(subscription.currentPeriodStart, false)} 〜{' '}
                {formatJst(subscription.currentPeriodEnd, false)}
              </span>
            </div>
            <div className="row row--between">
              <span className="muted">次回更新</span>
              <span className="small">
                {subscription.cancelAtPeriodEnd
                  ? '自動更新は停止済み'
                  : `${subscription.endsAtJst ?? '—'}（JST）`}
              </span>
            </div>

            {subscription.status === 'past_due' && (
              <div className="alert alert--warn">
                <div className="alert__title">お支払いを確認できませんでした</div>
                <div className="small">
                  新しい期間の回数はまだ付与されていません。現在お持ちの回数は引き続きご利用いただけます。
                  お支払い方法を更新すると、確認後に付与されます。
                </div>
              </div>
            )}

            {cancelResult ? (
              <div className="alert alert--info">
                <div className="alert__title">自動更新を停止しました</div>
                <div className="small">
                  {formatJst(cancelResult.effectiveAt)}（JST）まではこれまでどおりご利用いただけます。
                  次回以降の請求は発生しません。
                </div>
              </div>
            ) : subscription.cancelAtPeriodEnd ? (
              <div className="alert alert--info small">
                自動更新は停止済みです。{subscription.endsAtJst ?? '—'}（JST）まで利用できます。
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void cancelSubscription()}
                disabled={cancelling}
              >
                {cancelling ? '手続き中…' : '自動更新を停止する'}
              </button>
            )}

            <p className="small muted" style={{ margin: 0 }}>
              停止はオンラインで完結します。お電話での手続きは不要です。
              停止後も、すでに生成した楽曲は生成時点の条件に従ってご利用いただけます。
            </p>
          </>
        )}
      </section>

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>購入履歴</h2>
        {orders.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            購入履歴はまだありません。
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日時（JST）</th>
                  <th>内容</th>
                  <th>金額</th>
                  <th>状態</th>
                  <th>回数の付与</th>
                  <th>領収</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const s = ORDER_STATUS[o.status] ?? { label: o.status, tone: '' };
                  return (
                    <tr key={o.orderId}>
                      <td className="small">{o.createdAtJst}</td>
                      <td className="small">
                        {o.priceKey === 'drop_5' ? 'DROP（5回パック）' : 'CREATOR（月額20回）'}
                      </td>
                      <td className="num">{formatMoney(o.amountMinor)}</td>
                      <td>
                        <Badge tone={s.tone}>{s.label}</Badge>
                      </td>
                      <td className="small">
                        {o.entitlementGranted ? (
                          '付与済み'
                        ) : o.status === 'paid' ? (
                          <span style={{ color: 'var(--warning)' }}>処理中</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="small">
                        {o.receiptUrl ? (
                          <a href={o.receiptUrl} target="_blank" rel="noreferrer">
                            表示
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
        <h2 style={{ fontSize: 18, margin: 0 }}>アカウント</h2>
        <p className="small muted" style={{ margin: 0 }}>
          「自動更新の停止」「お知らせメールの配信停止」「アカウントの削除」はそれぞれ別の操作です。
        </p>
        <div className="row">
          <Link className="btn btn--ghost" to="/settings/account">
            アカウント設定
          </Link>
        </div>
      </section>
    </div>
  );
}
