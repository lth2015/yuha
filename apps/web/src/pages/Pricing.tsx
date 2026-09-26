import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ProductView } from '@yuha/contracts';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { fetchProducts } from '../lib/catalog';
import { useI18n } from '../lib/i18n';
import { LOCALES, formatMoney, formatPerUnit } from '../lib/money';
import { useSession } from '../lib/session';
import { ErrorNotice } from '../components/common';
import { CHECKOUT_RETURN_KEY } from './Checkout';

/** Copy keys per catalogue entry; the amounts always come from the server. */
const PLAN_COPY: Record<string, { tag: string; bullets: string[]; highlight?: boolean }> = {
  drop_5: { tag: 'price.drop.tag', bullets: ['price.drop.b1', 'price.drop.b2', 'price.drop.b3'] },
  pro_monthly: {
    tag: 'price.pro.tag',
    highlight: true,
    bullets: ['price.pro.b1', 'price.pro.b2', 'price.pro.b3'],
  },
  premier_monthly: {
    tag: 'price.premier.tag',
    bullets: ['price.premier.b1', 'price.premier.b2', 'price.premier.b3'],
  },
};

/**
 * Plans. Amounts come from the server catalogue (PAY-01): the checkout request
 * sends only the product key; the price can never be edited client-side.
 */
export default function Pricing() {
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const locale = LOCALES[lang] ?? 'en-US';
  const { me, runtime } = useSession();
  const [products, setProducts] = useState<ProductView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    fetchProducts().then(setProducts).catch(setError);
  }, []);

  const buy = async (priceKey: string) => {
    if (!me) {
      navigate(`/auth?next=/pricing`);
      return;
    }
    // Park where they came from before leaving for the payment provider, so
    // the confirmation screen can send them back to the draft they left.
    try {
      const from = new URLSearchParams(window.location.search).get('from');
      if (from && from.startsWith('/') && !from.startsWith('//')) {
        localStorage.setItem(CHECKOUT_RETURN_KEY, from);
      } else {
        localStorage.removeItem(CHECKOUT_RETURN_KEY);
      }
    } catch {
      /* private browsing — the return path is a nicety, not a requirement */
    }
    setBusyKey(priceKey);
    setError(null);
    try {
      const res = await apiFetch<{ orderId: string; checkoutUrl: string; simulated: boolean }>('/v1/checkout', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('checkout'),
        body: { priceKey },
      });
      if (res.simulated) {
        navigate(`/checkout/confirm?order_id=${res.orderId}&simulated=1`);
      } else {
        window.location.href = res.checkoutUrl;
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusyKey(null);
    }
  };

  const freeTrial = runtime?.features.freeTrialEnabled;
  /** Whatever the catalogue is priced in; the free tier must match it. */
  const catalogueCurrency = products?.[0]?.currency ?? 'jpy';
  const qrWallets = runtime?.features.qrWalletsEnabled === true;

  return (
    <div className="stack stack--loose pricing">
      <div className="pricing__head">
        <h1>{t('price.h1')}</h1>
        <p>
          {t('price.sub')}
          {freeTrial ? ` ${t('price.trialNote', { n: runtime?.features.freeTrialUnits ?? 2 })}` : ''}
        </p>
      </div>

      <ErrorNotice error={error} />

      {products === null ? (
        <div className="grid grid--plans" aria-hidden="true">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton skeleton--plan" />
          ))}
        </div>
      ) : (
        <div className="grid grid--plans">
          {freeTrial && (
            <article className="plan plan--free">
              <h2>{t('price.free')}</h2>
              {/* The catalogue's currency, not a literal: "US$0" sitting beside
                  JP¥980 was the first thing visible once this page rendered
                  again. Free is free in whatever the plans beside it cost. */}
              <p className="plan__price">{formatMoney(0, catalogueCurrency, locale)}</p>
              <p className="plan__tagline">{t('price.freeTag')}</p>
              <ul className="plan__bullets">
                <li>{t('price.free.b1', { n: runtime?.features.freeTrialUnits ?? 2 })}</li>
                <li>{t('price.free.b2')}</li>
              </ul>
              {me ? (
                <span className="plan__current">{t('price.freeIncluded')}</span>
              ) : (
                <Link to="/auth?next=/create" className="btn btn--block">
                  {t('price.signin')}
                </Link>
              )}
            </article>
          )}

          {products
            /*
             * Only what PLAN_COPY describes.
             *
             * The catalogue also carries `market_license`, a per-song usage
             * licence, and it rendered here as a plan: its raw displayName
             * ("Licence — one song") as the tagline and "buy credits" as the
             * button, for something that is not credits. You licence a
             * particular song, so that purchase belongs on that song's page
             * (`SongDetail`), which is where it has always actually worked.
             *
             * Filtering on the copy rather than on the one price key is the
             * point: a product added to the catalogue without copy now stays
             * off this page instead of appearing as a broken card.
             */
            .filter((p) => PLAN_COPY[p.priceKey])
            .sort((a, b) => a.amountMinor - b.amountMinor)
            .map((p) => {
              const copy = PLAN_COPY[p.priceKey]!;
              return (
                <article key={p.priceKey} className={`plan${copy.highlight ? ' plan--highlight' : ''}`}>
                  {copy.highlight && <span className="plan__badge">{t('price.popular')}</span>}
                  <h2>{p.displayName.split('—')[0]!.trim()}</h2>
                  <p className="plan__price">
                    {formatMoney(p.amountMinor, p.currency, locale)}
                    {p.kind === 'subscription' && <span className="plan__per">{t('price.month')}</span>}
                  </p>
                  <p className="plan__unit">{t('price.perSong', { amount: formatPerUnit(p.amountMinor, p.units, p.currency, locale) })}</p>
                  <p className="plan__tagline">{t(copy.tag)}</p>
                  {/* Said here rather than discovered on Stripe's page. */}
                  {qrWallets && (
                    <p className="plan__pay">
                      {p.kind === 'subscription' ? t('price.pay.sub') : t('price.pay.oneTime')}
                    </p>
                  )}
                  <ul className="plan__bullets">
                    {copy.bullets.map((b) => (
                      <li key={b}>{t(b)}</li>
                    ))}
                  </ul>
                  {p.available ? (
                    <button
                      type="button"
                      className={`btn btn--block${copy?.highlight ? ' btn--primary' : ''}`}
                      onClick={() => buy(p.priceKey)}
                      disabled={busyKey === p.priceKey}
                    >
                      {busyKey === p.priceKey
                        ? t('price.opening')
                        : p.kind === 'subscription'
                          ? t('price.subscribe')
                          : t('price.buy')}
                    </button>
                  ) : (
                    // Say *why* it is unavailable. "Coming soon" with no reason
                    // reads as a stalled product rather than a decision.
                    <span className="plan__current">
                      {t('price.soon')}
                      <span className="plan__soonwhy">{t('price.soonWhy')}</span>
                    </span>
                  )}
                </article>
              );
            })}
        </div>
      )}

      <div className="pricing__notes panel">
        <h2>{t('price.notes')}</h2>
        <ul className="small">
          <li>{t('price.note1')}</li>
          <li>{t('price.note2')}</li>
          <li>{t('price.note3')}</li>
          <li>{t('price.note4')}</li>
        </ul>
      </div>
    </div>
  );
}
