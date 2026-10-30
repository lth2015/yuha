import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CreditHistoryItem } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatJst } from '../lib/session';

/** Which name a batch's source goes by, here and in the balance table above it. */
export function sourceKey(source: string): string {
  switch (source) {
    case 'one_time_order': return 'bill.src.one_time';
    case 'subscription_period': return 'bill.src.subscription';
    case 'compensation': return 'bill.src.compensation';
    case 'promo_trial': return 'bill.src.trial';
    case 'credit_reset': return 'bill.src.reset';
    case 'operator_gift': return 'bill.src.gift';
    default: return 'bill.src.adjust';
  }
}

/**
 * What happened to this account's credits, one line per event
 * (docs/FAILURE_COMPENSATION_SPEC.md). Every line is the ledger's answer as
 * the server assembled it; nothing here works out a credit's fate itself.
 */
export function CreditHistory() {
  const { t } = useI18n();
  const [items, setItems] = useState<CreditHistoryItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false;
    apiFetch<{ items: CreditHistoryItem[] }>('/v1/credits/history')
      .then((r) => { if (!gone) setItems(r.items); })
      .catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, []);

  const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');
  const label = (item: CreditHistoryItem) => {
    switch (item.kind) {
      case 'generation': return item.title || t('create.defaultTitle');
      case 'compensation': return t('credits.compensation');
      case 'revoke': return t('credits.revoke');
      default: return t(sourceKey(item.source));
    }
  };
  const detail = (item: CreditHistoryItem) => {
    switch (item.kind) {
      case 'generation': return t(`job.credit.short.${item.credit}`);
      case 'compensation':
        return [item.title, item.reportNumber].filter(Boolean).join(' · ') || null;
      default: return null;
    }
  };
  const href = (item: CreditHistoryItem) => {
    if (item.kind !== 'generation' && item.kind !== 'compensation') return null;
    if (item.trackId) return `/song/${item.trackId}`;
    return item.kind === 'generation' ? `/create?job=${encodeURIComponent(item.jobId)}` : null;
  };

  return (
    <section className="panel stack" aria-labelledby="credit-history-h">
      <h2 id="credit-history-h" className="section-title">{t('credits.h2')}</h2>
      {failed ? (
        <p className="small muted">{t('credits.failed')}</p>
      ) : items === null ? null : items.length === 0 ? (
        <p className="small muted">{t('credits.none')}</p>
      ) : (
        <ul className="credit-history">
          {items.map((item, i) => {
            const to = href(item);
            const sub = detail(item);
            return (
              <li key={`${item.kind}-${item.at}-${i}`} className="credit-history__row">
                <div className="credit-history__what">
                  {to ? <Link to={to}>{label(item)}</Link> : <span>{label(item)}</span>}
                  <span className="small muted">
                    {formatJst(item.at)}
                    {sub ? ` · ${sub}` : ''}
                  </span>
                </div>
                <span className="num credit-history__units" data-sign={Math.sign(item.units)}>
                  {signed(item.units)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="small muted" style={{ margin: 0 }}>{t('credits.note')}</p>
    </section>
  );
}
