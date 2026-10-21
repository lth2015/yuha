import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { LOCALES, formatMoney } from '../../lib/money';
import { ErrorNotice, Loading } from '../common';
import { BarChart, compact } from './BarChart';

/**
 * The numbers an operator checks first: visits, sign-ups, songs made, money
 * taken, credits moved — by day, week, month or year, in Japan time.
 *
 * Every figure comes from GET /v1/admin/stats, and what each one counts is
 * written once, in packages/db/src/admin-stats.ts. This screen adds nothing
 * to them but arithmetic for the comparison line.
 */
type Granularity = 'day' | 'week' | 'month' | 'year';

interface Bucket {
  key: string;
  pageViews: number;
  visitors: number;
  signups: number;
  generations: { submitted: number; delivered: number; failed: number };
  paidOrders: { count: number; card: number; jpyc: number; usdc: number; netx: number };
  revenueJpy: { total: number; card: number; jpyc: number; usdc: number; netx: number };
  refundsJpy: number;
  creditsGranted: { total: number; purchased: number; subscription: number; trial: number; gift: number; compensation: number; other: number };
  creditsConsumed: number;
}
type Totals = Omit<Bucket, 'key'>;
interface Report {
  granularity: Granularity;
  from: string;
  to: string;
  buckets: Bucket[];
  totals: Totals;
  previous: Totals;
}

/* Categorical slots 1–3 of the validated palette (blue, orange, aqua), in
   fixed order; "in progress" is the neutral "other". */
const C1 = '#2a78d6';
const C2 = '#eb6834';
const C3 = '#1baf7a';
// Categorical slot 4 (yellow). Validated adjacent to slot 3 in the stack (CVD ΔE 9.1); below 3:1 on the light surface, so the legend and table view carry it (relief rule).
const C4 = '#eda100';
const OTHER = '#a9aba4';

const GRANULARITIES: Granularity[] = ['day', 'week', 'month', 'year'];
/** Literal keys, so `check:i18n` sees each one in use. */
const G_LABEL: Record<Granularity, string> = {
  day: 'admin.dash.g.day',
  week: 'admin.dash.g.week',
  month: 'admin.dash.g.month',
  year: 'admin.dash.g.year',
};

function shortLabel(key: string, g: Granularity): string {
  if (g === 'day' || g === 'week') return key.slice(5); // MM-DD
  return key;
}

export function Dashboard() {
  const { t, lang } = useI18n();
  const locale = LOCALES[lang] ?? 'ja-JP';
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'charts' | 'table'>('charts');

  const load = useCallback(
    async (g: Granularity, f: string, tt: string) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ granularity: g });
        if (f) qs.set('from', f);
        if (tt) qs.set('to', tt);
        setReport(await apiFetch<Report>(`/v1/admin/stats?${qs.toString()}`));
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // A new granularity starts from its default range; dates are an override.
  useEffect(() => {
    setFrom('');
    setTo('');
    void load(granularity, '', '');
  }, [granularity, load]);

  const num = useCallback((n: number) => new Intl.NumberFormat(locale).format(n), [locale]);
  const yen = useCallback((n: number) => formatMoney(n, 'jpy', locale), [locale]);

  const labels = useMemo(() => report?.buckets.map((b) => shortLabel(b.key, report.granularity)) ?? [], [report]);
  const fullLabels = useMemo(() => report?.buckets.map((b) => b.key) ?? [], [report]);

  const exportCsv = () => {
    if (!report) return;
    const head = [
      'bucket', 'page_views', 'visitors', 'signups', 'generations_submitted', 'generations_delivered',
      'generations_failed', 'paid_orders', 'paid_orders_card', 'paid_orders_jpyc', 'paid_orders_usdc', 'paid_orders_netx',
      'revenue_jpy', 'revenue_card_jpy', 'revenue_jpyc_jpy', 'revenue_usdc_jpy', 'revenue_netx_jpy', 'refunds_jpy',
      'credits_granted', 'credits_consumed',
    ];
    const rows = report.buckets.map((b) => [
      b.key, b.pageViews, b.visitors, b.signups, b.generations.submitted, b.generations.delivered,
      b.generations.failed, b.paidOrders.count, b.paidOrders.card, b.paidOrders.jpyc, b.paidOrders.usdc, b.paidOrders.netx,
      b.revenueJpy.total, b.revenueJpy.card, b.revenueJpy.jpyc, b.revenueJpy.usdc, b.revenueJpy.netx, b.refundsJpy,
      b.creditsGranted.total, b.creditsConsumed,
    ]);
    const csv = [head, ...rows].map((r) => r.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `yuha-stats-${report.granularity}-${report.from}_${report.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const tiles = report
    ? [
        { label: t('admin.dash.pageViews'), now: report.totals.pageViews, prev: report.previous.pageViews, fmt: num },
        { label: t('admin.dash.visitors'), now: report.totals.visitors, prev: report.previous.visitors, fmt: num },
        { label: t('admin.dash.signups'), now: report.totals.signups, prev: report.previous.signups, fmt: num },
        {
          label: t('admin.dash.generations'),
          now: report.totals.generations.submitted,
          prev: report.previous.generations.submitted,
          fmt: num,
          sub:
            report.totals.generations.submitted > 0
              ? t('admin.dash.successRate', {
                  pct: String(Math.round((report.totals.generations.delivered / report.totals.generations.submitted) * 100)),
                })
              : null,
        },
        { label: t('admin.dash.paidOrders'), now: report.totals.paidOrders.count, prev: report.previous.paidOrders.count, fmt: num },
        { label: t('admin.dash.revenue'), now: report.totals.revenueJpy.total, prev: report.previous.revenueJpy.total, fmt: yen },
        { label: t('admin.dash.creditsGranted'), now: report.totals.creditsGranted.total, prev: report.previous.creditsGranted.total, fmt: num },
        { label: t('admin.dash.creditsConsumed'), now: report.totals.creditsConsumed, prev: report.previous.creditsConsumed, fmt: num },
      ]
    : [];

  const delta = (now: number, prev: number) => {
    if (prev === 0) return now === 0 ? t('admin.dash.noChange') : t('admin.dash.newVsPrev');
    const pct = Math.round(((now - prev) / prev) * 100);
    return t('admin.dash.vsPrev', { pct: `${pct > 0 ? '+' : ''}${pct}` });
  };

  return (
    <section className="stack dash">
      <div className="dash__controls">
        <div className="seg" role="group" aria-label={t('admin.dash.granularity')}>
          {GRANULARITIES.map((g) => (
            <button
              key={g}
              type="button"
              className={`seg__btn${granularity === g ? ' is-active' : ''}`}
              aria-pressed={granularity === g}
              onClick={() => setGranularity(g)}
            >
              {t(G_LABEL[g])}
            </button>
          ))}
        </div>
        <form
          className="dash__range"
          onSubmit={(e) => {
            e.preventDefault();
            void load(granularity, from, to);
          }}
        >
          <input type="date" value={from || report?.from || ''} onChange={(e) => setFrom(e.target.value)} aria-label={t('admin.dash.from')} />
          <span aria-hidden="true">–</span>
          <input type="date" value={to || report?.to || ''} onChange={(e) => setTo(e.target.value)} aria-label={t('admin.dash.to')} />
          <button type="submit" className="btn btn--ghost btn--sm" disabled={loading}>
            {t('admin.dash.apply')}
          </button>
        </form>
        <div className="dash__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setView(view === 'charts' ? 'table' : 'charts')}>
            {view === 'charts' ? t('admin.dash.showTable') : t('admin.dash.showCharts')}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={exportCsv} disabled={!report}>
            {t('admin.dash.csv')}
          </button>
        </div>
      </div>

      <ErrorNotice error={error} onRetry={() => void load(granularity, from, to)} />
      {loading && !report && <Loading />}

      {report && (
        <>
          <p className="small muted" style={{ margin: 0 }}>
            {t('admin.dash.range', { from: report.from, to: report.to })}
          </p>
          <div className="dash__tiles">
            {tiles.map((tile) => (
              <div key={tile.label} className="dash__tile">
                <span className="dash__tilelabel">{tile.label}</span>
                <span className="dash__tilevalue num">{tile.fmt(tile.now)}</span>
                <span className="dash__tiledelta small">{delta(tile.now, tile.prev)}</span>
                {'sub' in tile && tile.sub && <span className="small muted">{tile.sub}</span>}
              </div>
            ))}
          </div>

          {view === 'charts' ? (
            <div className="dash__charts">
              <BarChart
                title={t('admin.dash.chart.visits')}
                labels={labels}
                tooltipLabels={fullLabels}
                locale={locale}
                series={[
                  { key: 'views', label: t('admin.dash.pageViews'), color: C1, values: report.buckets.map((b) => b.pageViews) },
                  { key: 'visitors', label: t('admin.dash.visitors'), color: C2, values: report.buckets.map((b) => b.visitors) },
                ]}
              />
              <BarChart
                title={t('admin.dash.chart.generations')}
                labels={labels}
                tooltipLabels={fullLabels}
                locale={locale}
                stacked
                series={[
                  { key: 'delivered', label: t('admin.dash.delivered'), color: C1, values: report.buckets.map((b) => b.generations.delivered) },
                  { key: 'failed', label: t('admin.dash.failed'), color: C2, values: report.buckets.map((b) => b.generations.failed) },
                  {
                    key: 'open',
                    label: t('admin.dash.inProgress'),
                    color: OTHER,
                    values: report.buckets.map((b) => Math.max(0, b.generations.submitted - b.generations.delivered - b.generations.failed)),
                  },
                ]}
              />
              <BarChart
                title={t('admin.dash.chart.revenue')}
                labels={labels}
                tooltipLabels={fullLabels}
                locale={locale}
                stacked
                format={yen}
                series={[
                  { key: 'card', label: t('admin.dash.card'), color: C1, values: report.buckets.map((b) => b.revenueJpy.card) },
                  { key: 'jpyc', label: 'JPYC', color: C2, values: report.buckets.map((b) => b.revenueJpy.jpyc) },
                  { key: 'usdc', label: 'USDC', color: C3, values: report.buckets.map((b) => b.revenueJpy.usdc) },
                  { key: 'netx', label: 'NETX', color: C4, values: report.buckets.map((b) => b.revenueJpy.netx) },
                ]}
              />
              <BarChart
                title={t('admin.dash.chart.signups')}
                labels={labels}
                tooltipLabels={fullLabels}
                locale={locale}
                series={[{ key: 'signups', label: t('admin.dash.signups'), color: C1, values: report.buckets.map((b) => b.signups) }]}
              />
              <BarChart
                title={t('admin.dash.chart.credits')}
                labels={labels}
                tooltipLabels={fullLabels}
                locale={locale}
                series={[
                  { key: 'granted', label: t('admin.dash.creditsGranted'), color: C1, values: report.buckets.map((b) => b.creditsGranted.total) },
                  { key: 'consumed', label: t('admin.dash.creditsConsumed'), color: C2, values: report.buckets.map((b) => b.creditsConsumed) },
                ]}
              />
            </div>
          ) : (
            <div className="table-wrap">
              <table className="small">
                <thead>
                  <tr>
                    <th>{t('admin.dash.col.bucket')}</th>
                    <th>{t('admin.dash.pageViews')}</th>
                    <th>{t('admin.dash.visitors')}</th>
                    <th>{t('admin.dash.signups')}</th>
                    <th>{t('admin.dash.generations')}</th>
                    <th>{t('admin.dash.delivered')}</th>
                    <th>{t('admin.dash.failed')}</th>
                    <th>{t('admin.dash.paidOrders')}</th>
                    <th>{t('admin.dash.card')}</th>
                    <th>JPYC</th>
                    <th>USDC</th>
                    <th>NETX</th>
                    <th>{t('admin.dash.refunds')}</th>
                    <th>{t('admin.dash.creditsGranted')}</th>
                    <th>{t('admin.dash.creditsConsumed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.buckets.map((b) => (
                    <tr key={b.key}>
                      <td>{b.key}</td>
                      <td className="num">{num(b.pageViews)}</td>
                      <td className="num">{num(b.visitors)}</td>
                      <td className="num">{num(b.signups)}</td>
                      <td className="num">{num(b.generations.submitted)}</td>
                      <td className="num">{num(b.generations.delivered)}</td>
                      <td className="num">{num(b.generations.failed)}</td>
                      <td className="num">{num(b.paidOrders.count)}</td>
                      <td className="num">{yen(b.revenueJpy.card)}</td>
                      <td className="num">{yen(b.revenueJpy.jpyc)}</td>
                      <td className="num">{yen(b.revenueJpy.usdc)}</td>
                      <td className="num">{yen(b.revenueJpy.netx)}</td>
                      <td className="num">{yen(b.refundsJpy)}</td>
                      <td className="num">{num(b.creditsGranted.total)}</td>
                      <td className="num">{num(b.creditsConsumed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted" style={{ margin: 0 }}>
            {t('admin.dash.note', { refunds: compact(report.totals.refundsJpy, locale) })}
          </p>
        </>
      )}
    </section>
  );
}
