import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { OrderView, ProductView } from '@yuha/contracts';
import { ApiError, apiFetch, newIdempotencyKey } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatMoney, formatJst, useSession } from '../lib/session';
import { LOCALES } from '../lib/money';
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
  const navigate = useNavigate();
  const priceKey = params.get('price') ?? 'drop_5';
  const { runtime } = useSession();
  const { t, lang } = useI18n();

  const [product, setProduct] = useState<ProductView | null>(null);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey] = useState(() => newIdempotencyKey('checkout'));
  /*
   * Card unless the customer says otherwise.
   *
   * The choice is offered only when the runtime descriptor says the channel is
   * on AND this product can be paid for that way — DROP and Licence; the two
   * subscriptions stay on Stripe, so offering a wallet for them would be a
   * button that leads to a refusal.
   */
  const [method, setMethod] = useState<'card' | 'stablecoin'>('card');

  useEffect(() => {
    void (async () => {
      try {
        const [products, d] = await Promise.all([
          apiFetch<{ items: ProductView[] }>('/v1/products'),
          apiFetch<Disclosure>('/v1/legal/business-disclosure'),
        ]);
        /*
         * A price key that is not in the catalogue used to set `product` to
         * null and leave `error` null — and `ErrorNotice` renders nothing
         * when its error is falsy. So `if (!product) return <ErrorNotice />`
         * rendered a completely empty page, at the moment of payment, for a
         * stale tab or a renamed product. This file's own comment records
         * eight days lost to exactly that failure on /pricing.
         */
        const found = products.items.find((p) => p.priceKey === priceKey);
        if (!found) throw new ApiError('NOT_FOUND', t('pay.unknownProduct'), 404);
        setProduct(found);
        setDisclosure(d);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    })();
  }, [priceKey]);

  /*
   * Only for what the quote endpoint will actually accept. `QUOTABLE_PRODUCTS`
   * on the server is DROP and Licence; a wallet button on a subscription would
   * be an offer the next request refuses, which reads as a broken page rather
   * than an unavailable option.
   *
   * Computed here rather than beside the markup so that the ACTION and the
   * chooser are decided by the same expression. A guard that only the renderer
   * can see is how a page ends up doing something it does not offer.
   */
  const stablecoinOffered =
    !!runtime?.stablecoin.enabled &&
    runtime.stablecoin.tokens.length > 0 &&
    (priceKey === 'drop_5' || priceKey === 'market_license');

  const proceed = async () => {
    if (method === 'stablecoin' && stablecoinOffered) {
      /*
       * The obligation is created on the next page, by asking for a quote —
       * which is why the amount, the contents, the delivery timing and the
       * cancellation terms above are shown BEFORE that step and repeated
       * there. 消費者庁's 最終確認画面 guidance is about the moment the
       * obligation arises, and for this channel that moment is the quote.
       */
      const track = params.get('track');
      navigate(`/checkout/stablecoin?price=${encodeURIComponent(priceKey)}${track ? `&track=${encodeURIComponent(track)}` : ''}`);
      return;
    }
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
  if (!product) {
    return (
      <div className="stack">
        <ErrorNotice error={error} />
        <Link className="btn" to="/pricing">
          {t('pay.backToPricing')}
        </Link>
      </div>
    );
  }

  const nextChargeDate = new Date(Date.now() + 30 * 86400_000).toISOString();

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }} className="stack stack--loose">
      <h1 style={{ fontSize: 26 }}>{t('checkout.title')}</h1>

      <ErrorNotice error={error} />

      <section className="panel stack">
        <div className="row row--between">
          <h2 style={{ fontSize: 20, margin: 0 }}>{product.displayName}</h2>
          {product.autoRenew ? (
            <Badge tone="badge--warn">{t('checkout.badge.autoRenew')}</Badge>
          ) : (
            <Badge>{t('checkout.badge.oneTime')}</Badge>
          )}
        </div>

        <div className="table-wrap">
          <table style={{ minWidth: 0 }}>
            <tbody>
              <tr>
                <th>{t('checkout.label.amount')}</th>
                <td className="num">
                  {/*
                    The amount is interpolated into the sentence rather than
                    wrapped in markup with "（税込）" tacked on after it: the
                    tax note goes before the figure in some languages and after
                    it in others, and splitting around a tag forces every
                    language into Japanese word order.
                  */}
                  <strong>
                    {t('checkout.amountWithTax', {
                      amount: formatMoney(product.amountMinor, product.currency, LOCALES[lang]),
                    })}
                  </strong>
                </td>
              </tr>
              <tr>
                <th>{t('checkout.label.contents')}</th>
                <td>{t('checkout.contents', { units: String(product.units) })}</td>
              </tr>
              <tr>
                <th>{t('checkout.label.delivery')}</th>
                <td>{t('checkout.delivery')}</td>
              </tr>
              <tr>
                <th>{t('checkout.label.validity')}</th>
                <td>
                  {product.validityDays
                    ? t('checkout.validity.days', { days: String(product.validityDays) })
                    : t('checkout.validity.period')}
                </td>
              </tr>
              <tr>
                <th>{t('checkout.label.renewal')}</th>
                <td>
                  {product.autoRenew
                    ? t('checkout.renewal.auto', {
                        date: formatJst(nextChargeDate, false),
                        amount: formatMoney(product.amountMinor, product.currency, LOCALES[lang]),
                      })
                    : t('checkout.renewal.none')}
                </td>
              </tr>
              <tr>
                <th>{t('checkout.label.cancel')}</th>
                <td>
                  {product.autoRenew
                    ? t('checkout.cancel.sub')
                    : t('checkout.cancel.oneTime')}
                </td>
              </tr>
              <tr>
                <th>{t('checkout.label.refund')}</th>
                <td className="small">{t('checkout.refund')}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* SEC-13: the operating entity is disclosed on the payment screen itself. */}
      {disclosure && (
        <section className="panel panel--tight stack stack--tight">
          <h2 style={{ fontSize: 16, margin: 0 }}>{t('checkout.seller')}</h2>
          <div className="small muted">
            <div>{disclosure.entityName}</div>
            <div>{disclosure.address}</div>
            <div>{disclosure.contact}</div>
          </div>
          {disclosure.isPlaceholder && (
            <div className="alert alert--warn small">{disclosure.notice}</div>
          )}
          {/*
            The notice itself stays Japanese wherever it is read — it is the
            filed statutory document, and Tokushoho.tsx is exempt from the
            dictionary for that reason. This is the link to it, which is
            ordinary navigation and reads in the reader's language.
          */}
          <Link className="small" to="/legal/tokushoho">
            {t('checkout.tokushohoLink')}
          </Link>
        </section>
      )}

      {stablecoinOffered && (
        <section className="panel stack">
          <h2 style={{ fontSize: 20, margin: 0 }}>{t('checkout.method.title')}</h2>
          <div className="row">
            <button
              type="button"
              className={method === 'card' ? 'btn btn--primary' : 'btn'}
              aria-pressed={method === 'card'}
              onClick={() => setMethod('card')}
            >
              {t('checkout.method.card')}
            </button>
            <button
              type="button"
              className={method === 'stablecoin' ? 'btn btn--primary' : 'btn'}
              aria-pressed={method === 'stablecoin'}
              onClick={() => setMethod('stablecoin')}
            >
              {t('checkout.method.stablecoin')}
            </button>
          </div>
          <p className="small muted">
            {method === 'card' ? t('checkout.method.cardNote') : t('checkout.method.stablecoinNote')}
          </p>
        </section>
      )}

      <div className="checkbox-row">
        <input
          id="agree"
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
        />
        {/*
          Split on the placeholder rather than around the tag, so the link can
          sit wherever the sentence puts it: Chinese ends with it, Japanese has
          it in the middle, English ends with it too.
        */}
        <label htmlFor="agree">
          {(() => {
            const [before, after] = t('checkout.agree').split('{terms}');
            return (
              <>
                {before}
                <Link to="/legal/terms">{t('checkout.agree.terms')}</Link>
                {after}
              </>
            );
          })()}
        </label>
      </div>

      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={!agreed || submitting || !product.available}
        onClick={() => void proceed()}
      >
        {submitting
          ? t('checkout.submitting')
          : method === 'stablecoin'
            ? t('checkout.payStablecoin')
            : t('checkout.pay', { amount: formatMoney(product.amountMinor, product.currency, LOCALES[lang]) })}
      </button>

      <p className="small muted" style={{ margin: 0, textAlign: 'center' }}>
        {method === 'stablecoin' ? t('checkout.stablecoinFooter') : t('checkout.cardNote')}
        {runtime?.demo && method === 'card' && t('checkout.demoNote')}
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
/**
 * Where a buyer is sent back to after paying.
 *
 * Checkout can leave the site entirely (Stripe's hosted page), so the origin
 * is parked in localStorage rather than in router state or a query string.
 */
export const CHECKOUT_RETURN_KEY = 'yuha.checkout-return';

function readReturnPath(): string | null {
  try {
    const v = localStorage.getItem(CHECKOUT_RETURN_KEY);
    // Only ever an in-app path, never an absolute URL from somewhere else.
    return v && v.startsWith('/') && !v.startsWith('//') ? v : null;
  } catch {
    return null;
  }
}

/*
 * Waiting budget for the return from the payment page.
 *
 * Stripe usually delivers within seconds and the worker drains its queue on a
 * one-second tick, so the first minute is checked briskly; after that the
 * backoff stretches rather than hammering an endpoint that is clearly waiting
 * on something slow. 24 attempts spans about 85 seconds, and "check again"
 * re-arms the whole loop, so the page can always recover on its own.
 */
const MAX_POLLS = 24;

function pollDelay(attempt: number): number {
  if (attempt < 8) return 1500;
  if (attempt < 16) return 3000;
  return 6000;
}

export function CheckoutComplete() {
  const [params] = useSearchParams();
  const orderId = params.get('order_id');
  const { refreshEntitlements } = useSession();
  const { t, lang } = useI18n();
  const [returnTo] = useState(readReturnPath);

  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [waiting, setWaiting] = useState(true);
  // Bumped by "check again" to re-arm the loop below after it has given up.
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Effect-local, so StrictMode's second mount counts from zero in its own
    // closure instead of sharing a counter with the run it just tore down.
    let attempt = 0;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await apiFetch<OrderView>(`/v1/orders/${orderId}`);
        if (cancelled) return;
        setOrder(res);
        setError(null);
        if (res.entitlementGranted) {
          await refreshEntitlements();
          if (!cancelled) setWaiting(false);
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setError(err);
      }
      attempt += 1;
      if (attempt >= MAX_POLLS) {
        setWaiting(false);
        return;
      }
      /*
       * Scheduling lives here, not inside a `setState` updater.
       *
       * It used to be `setAttempts((a) => { ...; timer = setTimeout(...) })`.
       * React may call an updater more than once — StrictMode does so on every
       * render to surface exactly this kind of impurity — and each extra call
       * armed another timer while `timer` kept only the last one, so the rest
       * were never cleared. The loop doubled: measured on a real sandbox
       * payment it fired 25 requests in 8.1s and then stopped dead, because
       * the counter had also been incremented twice per round. The comment
       * above it said "bounded polling"; it was neither bounded the way it
       * claimed nor still running when the webhook landed 57s later.
       */
      timer = setTimeout(() => void poll(), pollDelay(attempt));
    };

    setWaiting(true);
    timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId, refreshEntitlements, round]);

  /*
   * No order id — say so.
   *
   * This used to `return <ErrorNotice error={error} />` with `error` still
   * null, and ErrorNotice renders nothing when there is no error: the page
   * came back completely blank. That is the failure that left /pricing white
   * for eight days, here on the return from payment, which is the worst
   * moment a product can show someone an empty screen. Reached by a redirect
   * that drops the parameter, a bookmark, or a reload of a stale tab.
   */
  if (!orderId) {
    return (
      <div className="stack stack--loose checkout-return">
        <h1>{t('pay.noOrder.title')}</h1>
        <ErrorNotice error={error} />
        <section className="panel stack">
          <p style={{ margin: 0 }}>{t('pay.noOrder.body')}</p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Link className="btn btn--primary" to="/settings/billing">
              {t('pay.noOrder.billing')}
            </Link>
            <Link className="btn" to={returnTo ?? '/create'}>
              {returnTo ? t('pay.backToWork') : t('pay.goCreate')}
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const granted = order?.entitlementGranted === true;
  const stillWaiting = !granted && waiting;

  return (
    <div className="stack stack--loose checkout-return">
      <h1>{granted ? t('pay.doneTitle') : t('pay.waitTitle')}</h1>

      <ErrorNotice error={error} />

      <section className="panel stack">
        {granted ? (
          <>
            <Badge tone="badge--ok">{t('pay.granted')}</Badge>
            <p style={{ margin: 0 }}>
              {order && (
                <>
                  {t('pay.paid', { amount: formatMoney(order.amountMinor, order.currency, LOCALES[lang]) })}
                  <br />
                </>
              )}
              {t('pay.credited')}
            </p>
            {/* Back to the surface they were writing on, where their draft is
                still waiting — not to a generic studio that reads a different
                draft key and looks empty. */}
            <Link className="btn btn--primary" to={returnTo ?? '/create'}>
              {returnTo ? t('pay.backToWork') : t('pay.goCreate')}
            </Link>
          </>
        ) : (
          <>
            <Badge tone="badge--warn">{t('pay.checking')}</Badge>
            <p style={{ margin: 0 }}>
              {t('pay.waiting')} {stillWaiting ? t('pay.autoRefresh') : t('pay.slow')}
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              {t('pay.safeToLeave')}
            </p>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {/* Any fixed budget can be outlived by a delayed delivery. Without
                  this the page promised "it will show up as soon as it lands"
                  and then stopped looking, so a grant that arrived a minute
                  later was never shown on the screen that promised it. */}
              {!stillWaiting && (
                <button type="button" className="btn btn--primary" onClick={() => setRound((r) => r + 1)}>
                  {t('pay.checkAgain')}
                </button>
              )}
              <Link className="btn btn--secondary" to="/settings/billing">
                {t('pay.seeBilling')}
              </Link>
            </div>
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
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const sessionId = params.get('session_id');
  const orderId = params.get('order_id');
  const amount = Number(params.get('amount') ?? '0');
  // Carried through the simulated checkout URL; the screen used to have no
  // currency at all and formatted yen as dollars.
  const currency = params.get('currency') ?? 'jpy';

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
        {t('checkout.sim.onlyDemo')}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }} className="stack stack--loose">
      <div className="alert alert--warn">
        <div className="alert__title">{t('checkout.sim.title')}</div>
        <div className="small">{t('checkout.sim.body')}</div>
      </div>

      <ErrorNotice error={error} />

      <section className="panel stack">
        <div className="row row--between">
          <span className="muted">{t('checkout.sim.amount')}</span>
          <strong className="num">{formatMoney(amount, currency, LOCALES[lang])}</strong>
        </div>
        <hr className="divider" />
        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={busy}
          onClick={() => void settle('paid')}
        >
          {t('checkout.sim.succeed')}
        </button>
        <button
          type="button"
          className="btn btn--secondary btn--block"
          disabled={busy}
          onClick={() => void settle('failed')}
        >
          {t('checkout.sim.fail')}
        </button>
        <Link className="btn btn--ghost btn--block" to="/pricing">
          {t('checkout.sim.back')}
        </Link>
      </section>
    </div>
  );
}
