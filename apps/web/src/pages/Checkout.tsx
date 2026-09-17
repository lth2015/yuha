import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { OrderView, ProductView } from '@loopscene/contracts';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { formatMoney, formatJst, useSession } from '../lib/session';
import { Badge, ErrorNotice, Loading } from '../components/common';

interface Disclosure {
  configured: boolean;
  isPlaceholder: boolean;
  entityName: string;
  representative: string;
  address: string;
  contact: string;
  notice: string | null;
}

/**
 * UI-10: the final confirmation screen.
 *
 * 消費者庁's guidance on 最終確認画面 requires the price, quantity, timing,
 * renewal and cancellation terms to all be visible at the moment the payment
 * obligation is created — so they are on this page, not behind a link.
 */
export function CheckoutConfirm() {
  const [params] = useSearchParams();
  const priceKey = params.get('price') ?? 'drop_5';
  const { runtime } = useSession();

  const [product, setProduct] = useState<ProductView | null>(null);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey] = useState(() => newIdempotencyKey('checkout'));

  useEffect(() => {
    void (async () => {
      try {
        const [products, d] = await Promise.all([
          apiFetch<{ items: ProductView[] }>('/v1/products'),
          apiFetch<Disclosure>('/v1/legal/business-disclosure'),
        ]);
        setProduct(products.items.find((p) => p.priceKey === priceKey) ?? null);
        setDisclosure(d);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    })();
  }, [priceKey]);

  const proceed = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{ orderId: string; checkoutUrl: string; simulated: boolean }>(
        '/v1/checkout',
        { method: 'POST', body: { priceKey, idempotencyKey } },
      );
      // Card entry always happens on the payment provider's hosted page.
      window.location.href = res.checkoutUrl;
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  if (loading) return <Loading />;
  if (!product) return <ErrorNotice error={error} />;

  const nextChargeDate = new Date(Date.now() + 30 * 86400_000).toISOString();

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }} className="stack stack--loose">
      <h1 style={{ fontSize: 26 }}>ご購入内容の確認</h1>

      <ErrorNotice error={error} />

      <section className="panel stack">
        <div className="row row--between">
          <h2 style={{ fontSize: 20, margin: 0 }}>{product.displayName}</h2>
          {product.autoRenew ? <Badge tone="badge--warn">自動更新</Badge> : <Badge>買い切り</Badge>}
        </div>

        <div className="table-wrap">
          <table style={{ minWidth: 0 }}>
            <tbody>
              <tr>
                <th>お支払い金額</th>
                <td className="num">
                  <strong>{formatMoney(product.amountMinor)}</strong>（税込）
                </td>
              </tr>
              <tr>
                <th>内容</th>
                <td>
                  30秒インストBGMの生成 <span className="num">{product.units}</span> 回
                </td>
              </tr>
              <tr>
                <th>提供時期</th>
                <td>お支払い確認後ただちに回数が反映されます</td>
              </tr>
              <tr>
                <th>有効期限</th>
                <td>
                  {product.validityDays
                    ? `購入日から ${product.validityDays} 日間`
                    : '各請求期間内（未使用分の繰り越しはありません）'}
                </td>
              </tr>
              <tr>
                <th>更新</th>
                <td>
                  {product.autoRenew ? (
                    <>
                      毎月自動更新（次回請求予定：
                      <span className="num">{formatJst(nextChargeDate, false)}</span> 頃・
                      {formatMoney(product.amountMinor)}）
                    </>
                  ) : (
                    '自動更新はありません'
                  )}
                </td>
              </tr>
              <tr>
                <th>解除方法</th>
                <td>
                  {product.autoRenew
                    ? '「請求」ページからいつでもオンラインで停止できます。電話は不要です。停止後も当期の終了まで利用できます。'
                    : '買い切りのため解除手続きは不要です'}
                </td>
              </tr>
              <tr>
                <th>返金</th>
                <td className="small">
                  技術的な失敗による消費は返却されます。誤課金は原状回復します。
                  未使用かつ購入後7日以内のお申し出は個別にご案内します。
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* SEC-13: the operating entity is disclosed on the payment screen itself. */}
      {disclosure && (
        <section className="panel panel--tight stack stack--tight">
          <h2 style={{ fontSize: 16, margin: 0 }}>販売事業者</h2>
          <div className="small muted">
            <div>{disclosure.entityName}</div>
            <div>{disclosure.address}</div>
            <div>{disclosure.contact}</div>
          </div>
          {disclosure.isPlaceholder && (
            <div className="alert alert--warn small">{disclosure.notice}</div>
          )}
          <Link className="small" to="/legal/tokushoho">
            特定商取引法に基づく表記をすべて見る
          </Link>
        </section>
      )}

      <div className="checkbox-row">
        <input
          id="agree"
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
        />
        <label htmlFor="agree">
          上記の内容と <Link to="/legal/terms">利用規約</Link> を確認しました
        </label>
      </div>

      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={!agreed || submitting || !product.available}
        onClick={() => void proceed()}
      >
        {submitting ? '手続き中…' : `${formatMoney(product.amountMinor)} を支払う`}
      </button>

      <p className="small muted" style={{ margin: 0, textAlign: 'center' }}>
        カード情報は決済代行（Stripe）の画面で入力します。当社はカード番号・セキュリティコードを保持しません。
        {runtime?.demo && ' デモモードのため、実際の請求は発生しません。'}
      </p>
    </div>
  );
}

/**
 * PAY-02: the post-payment landing page.
 *
 * It draws nothing from the URL except an order id. Whether entitlements were
 * granted is read from the server, so a hand-crafted "?success=true" cannot
 * make the interface claim a payment happened.
 */
export function CheckoutComplete() {
  const [params] = useSearchParams();
  const orderId = params.get('order_id');
  const { refreshEntitlements } = useSession();

  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await apiFetch<OrderView>(`/v1/orders/${orderId}`);
        if (cancelled) return;
        setOrder(res);
        if (res.entitlementGranted) {
          await refreshEntitlements();
          return;
        }
      } catch (err) {
        setError(err);
      }
      // Bounded polling: the webhook may take a moment, but we never spin forever.
      setAttempts((a) => {
        if (a >= 12) return a;
        timer = setTimeout(() => void poll(), 2000);
        return a + 1;
      });
    };

    let timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [orderId, refreshEntitlements]);

  if (!orderId) return <ErrorNotice error={error} />;

  const granted = order?.entitlementGranted === true;
  const stillWaiting = !granted && attempts < 12;

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }} className="stack stack--loose">
      <h1 style={{ fontSize: 26 }}>{granted ? 'お支払いが完了しました' : 'お支払いを確認中です'}</h1>

      <ErrorNotice error={error} />

      <section className="panel stack">
        {granted ? (
          <>
            <Badge tone="badge--ok">回数を追加しました</Badge>
            <p style={{ margin: 0 }}>
              {order && (
                <>
                  {formatMoney(order.amountMinor)}（税込）のお支払いを確認しました。
                  <br />
                </>
              )}
              生成回数がアカウントに反映されています。
            </p>
            <Link className="btn btn--primary" to="/create">
              つくる
            </Link>
          </>
        ) : (
          <>
            <Badge tone="badge--warn">確認中</Badge>
            <p style={{ margin: 0 }}>
              決済事業者からの確認を待っています。
              {stillWaiting
                ? 'この画面は自動で更新されます。'
                : '確認に時間がかかっています。反映されしだいご利用いただけます。'}
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              この画面を閉じても処理は続きます。二重に請求されることはありません。
              しばらくしても反映されない場合は「請求」ページからご確認ください。
            </p>
            <Link className="btn btn--secondary" to="/settings/billing">
              請求ページを見る
            </Link>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Demo-only simulated checkout.
 *
 * Stands in for the payment provider's hosted page so the whole order →
 * webhook → entitlement path can be walked without a real card. It exists only
 * in demo mode and says so unmistakably.
 */
export function CheckoutSimulate() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { runtime } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const sessionId = params.get('session_id');
  const orderId = params.get('order_id');
  const amount = Number(params.get('amount') ?? '0');

  const settle = async (outcome: 'paid' | 'failed') => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/v1/dev/simulate-payment', {
        method: 'POST',
        body: { sessionId, outcome },
      });
      navigate(`/checkout/complete?order_id=${orderId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (!runtime?.demo) {
    return (
      <div className="alert alert--error">
        この画面はデモモード専用です。実際の決済は決済代行のページで行われます。
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }} className="stack stack--loose">
      <div className="alert alert--warn">
        <div className="alert__title">擬似決済画面（デモ）</div>
        <div className="small">
          実際のカード決済は行われません。本番では決済代行の画面に遷移し、
          カード情報は当社を経由しません。
        </div>
      </div>

      <ErrorNotice error={error} />

      <section className="panel stack">
        <div className="row row--between">
          <span className="muted">お支払い金額</span>
          <strong className="num">{formatMoney(amount)}</strong>
        </div>
        <hr className="divider" />
        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={busy}
          onClick={() => void settle('paid')}
        >
          支払い成功をシミュレート
        </button>
        <button
          type="button"
          className="btn btn--secondary btn--block"
          disabled={busy}
          onClick={() => void settle('failed')}
        >
          支払い失敗をシミュレート
        </button>
        <Link className="btn btn--ghost btn--block" to="/pricing">
          キャンセルして戻る
        </Link>
      </section>
    </div>
  );
}
