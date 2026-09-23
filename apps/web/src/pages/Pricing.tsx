import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ProductView } from '@loopscene/contracts';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorNotice } from '../components/common';

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: amountMinor % 100 === 0 && currency.toLowerCase() !== 'jpy' ? 0 : 2,
  }).format(currency.toLowerCase() === 'jpy' ? amountMinor : amountMinor / 100);
}

const PLAN_COPY: Record<string, { tagline: string; bullets: string[]; highlight?: boolean }> = {
  drop_5: {
    tagline: 'One-time pack — no subscription',
    bullets: ['5 song credits', '90-day validity', 'All features, MP3 downloads'],
  },
  pro_monthly: {
    tagline: 'For regular creators',
    highlight: true,
    bullets: ['100 songs per month', 'Unused credits stay for the billing period', 'Cancel anytime, keep access to period end'],
  },
  premier_monthly: {
    tagline: 'For studios and heavy users',
    bullets: ['400 songs per month', 'Priority queue during peak hours', 'Cancel anytime, keep access to period end'],
  },
};

/**
 * Plans. Amounts come from the server catalogue (PAY-01): the checkout request
 * sends only the product key; the price can never be edited client-side.
 */
export default function Pricing() {
  const navigate = useNavigate();
  const { me, runtime } = useSession();
  const [products, setProducts] = useState<ProductView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ProductView[]>('/v1/products')
      .then(setProducts)
      .catch(setError);
  }, []);

  const buy = async (priceKey: string) => {
    if (!me) {
      navigate(`/auth?next=/pricing`);
      return;
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

  return (
    <div className="stack stack--loose pricing">
      <div className="pricing__head">
        <h1>Simple pricing</h1>
        <p>
          One credit generates one finished song — vocals or instrumental. Failed generations never cost a
          credit.
          {freeTrial ? ' New accounts start with 2 free credits.' : ''}
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
              <h2>Free</h2>
              <p className="plan__price">$0</p>
              <p className="plan__tagline">Start here</p>
              <ul className="plan__bullets">
                <li>2 welcome credits</li>
                <li>Full studio, all lengths</li>
              </ul>
              {me ? (
                <span className="plan__current">Included with your account</span>
              ) : (
                <Link to="/auth?next=/create" className="btn btn--block">
                  Sign in with Google
                </Link>
              )}
            </article>
          )}

          {products
            .slice()
            .sort((a, b) => a.amountMinor - b.amountMinor)
            .map((p) => {
              const copy = PLAN_COPY[p.priceKey] ?? {
                tagline: p.displayName,
                bullets: [`${p.units} song credits`],
              };
              return (
                <article key={p.priceKey} className={`plan${copy.highlight ? ' plan--highlight' : ''}`}>
                  {copy.highlight && <span className="plan__badge">Most popular</span>}
                  <h2>{p.displayName.split('—')[0]!.trim()}</h2>
                  <p className="plan__price">
                    {formatMoney(p.amountMinor, p.currency)}
                    {p.kind === 'subscription' && <span className="plan__per">/month</span>}
                  </p>
                  <p className="plan__tagline">{copy.tagline}</p>
                  <ul className="plan__bullets">
                    {copy.bullets.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                  {p.available ? (
                    <button
                      type="button"
                      className={`btn btn--block${copy.highlight ? ' btn--primary' : ''}`}
                      onClick={() => buy(p.priceKey)}
                      disabled={busyKey === p.priceKey}
                    >
                      {busyKey === p.priceKey
                        ? 'Opening checkout…'
                        : p.kind === 'subscription'
                          ? 'Subscribe'
                          : 'Buy credits'}
                    </button>
                  ) : (
                    <span className="plan__current">Coming soon</span>
                  )}
                </article>
              );
            })}
        </div>
      )}

      <div className="pricing__notes panel">
        <h2>The fine print, up front</h2>
        <ul className="small">
          <li>Prices are tax-inclusive. Payment is handled by Stripe; card details never touch our servers.</li>
          <li>Subscriptions renew monthly and can be cancelled online at any time — access continues to the end of the paid period.</li>
          <li>Credits from the Starter Pack are valid for 90 days. Subscription credits reset each billing period and are not carried over.</li>
          <li>You own the songs you generate, under the usage terms shown on each song's usage record.</li>
        </ul>
      </div>
    </div>
  );
}
