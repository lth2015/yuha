import { useCallback, useEffect, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatMoney, formatJst, useSession } from '../lib/session';
import { NetxSwitch } from '../components/admin/NetxSwitch';
import { CreditReset } from '../components/admin/CreditReset';
import { LyricRealign } from '../components/admin/LyricRealign';
import { IssueQueue } from '../components/admin/IssueQueue';
import { Badge, ErrorNotice, Loading } from '../components/common';
import { CustomerConsole } from '../components/CustomerConsole';
import { HeldOrderConsole } from '../components/HeldOrderConsole';
import { StablecoinConsole } from '../components/StablecoinConsole';
import { Dashboard } from '../components/admin/Dashboard';
import { OrdersPanel } from '../components/admin/OrdersPanel';
import { AuditPanel } from '../components/admin/AuditPanel';

interface Measured {
  value: number | null;
  n: number;
  unavailableReason: string | null;
}

interface Overview {
  mode: string;
  build?: { sha: string | null; startedAt: string };
  disclaimer: string;
  operations: {
    jobsByState: Record<string, number>;
    oldestPendingOutboxSeconds: number | null;
    webhookBacklog: number;
    staleUnknownJobs: number;
    deadLetteredMessages: number;
    ledgerDiscrepancies: number;
    technicalSuccessRate: Measured;
    budgetSpentTodayMinor: number;
    generationFailures: Array<{ code: string; state: string; count: number }>;
    /** The logic rules (docs/agents/CODEX_COLLABORATION.md). */
    invariants?: Array<{ name: string; rule: string; count: number; sample: string[] }>;
    /** docs/GENERATION_QUEUE_SPEC.md */
    queue?: {
      providerId: string;
      concurrency: number;
      queueDeadlineSeconds: number;
      running: number;
      waiting: number;
      oldestWaitSeconds: number | null;
      timeouts7d: number;
      generation: { samples: number; p50Seconds: number; p90Seconds: number };
      wait: { samples: number; p50Seconds: number; p90Seconds: number };
      byLength: Array<{ durationSeconds: number; samples: number; p50Seconds: number; p90Seconds: number }>;
    };
  };
  cost: {
    deliveredCount: number;
    currency: string;
    actualCostMinor: number;
    estimatedCostMinor: number;
    billableFailureCostMinor: number;
    costPerDelivery: Measured;
    costPerAdoptedResult: Measured;
    exportCount: number;
    adoptedCount: number;
  };
  revenue: {
    currency: string;
    grossMinor: number;
    refundedMinor: number;
    paymentFeeMinor: number;
    netMinor: number;
    paidOrderCount: number;
    refundCount: number;
    disputeCount: number;
    ungrantedPaidOrders: number;
  };
  funnel: {
    paidConversion14d: Measured;
    activationDay1: Measured;
    reuseDay7: Measured;
    firstRenewal: Measured;
  };
}

interface RightsCase {
  id: string;
  caseNumber: string;
  trackId: string | null;
  claimType: string;
  status: string;
  reporterEmail: string;
  createdAt: string;
}

/**
 * A metric that may legitimately have no value yet.
 *
 * §11 requires an immature or missing sample to be shown as "not computable"
 * with the reason, never as 0% — a zero would read as a real, bad result.
 */
function Metric({ label, m, percent = true }: { label: string; m: Measured; percent?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="card" style={{ gap: 4 }}>
      <span className="small muted">{label}</span>
      {m.value === null ? (
        <>
          <strong style={{ color: 'var(--muted)' }}>{t('admin.notComputable')}</strong>
          <span className="small muted">{m.unavailableReason}</span>
        </>
      ) : (
        <>
          <strong className="num" style={{ fontSize: 24 }}>
            {percent ? `${(m.value * 100).toFixed(1)}%` : m.value.toFixed(1)}
          </strong>
          <span className="small muted">
            {t('admin.sampleSize')}
            <span className="num">{m.n}</span>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * UI-15: the operations console.
 *
 * Support can inspect and compensate; only an admin can resolve rights cases or
 * change feature switches. Every mutation demands a reason, which is written to
 * the audit log with the before/after state.
 */
/**
 * The logic rules over this deployment's data: things that must never be true
 * at once (docs/agents/CODEX_COLLABORATION.md). All holding is one line; a
 * broken one names itself and the ids to look at.
 */
function InvariantsCard({ rules }: { rules: Array<{ name: string; rule: string; count: number; sample: string[] }> }) {
  const { t } = useI18n();
  const broken = rules.filter((r) => r.count > 0);
  return (
    <div className="card stack">
      <h3>{t('admin.invariants.h3')}</h3>
      {broken.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--ok)' }}>{t('admin.invariants.allHold', { n: rules.length })}</p>
      ) : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 'var(--s2)' }}>
          {broken.map((r) => (
            <li key={r.name}>
              <strong style={{ color: 'var(--danger)' }}>{r.rule}</strong>{' '}
              <span className="num">× {r.count >= 1000 ? '1000+' : r.count}</span>
              <br />
              <span className="small muted num" style={{ overflowWrap: 'anywhere' }}>
                {r.name} · {r.sample.join(', ')}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="small muted" style={{ margin: 0 }}>{t('admin.invariants.note')}</p>
    </div>
  );
}

/**
 * The generation queue as it stands and as it has run (docs/GENERATION_QUEUE_SPEC.md).
 * The concurrency shown is the one this API process was started with: the
 * production ConfigMap is not in the repository, so this is where it is read.
 */
function QueueCard({ q }: { q: NonNullable<Overview['operations']['queue']> }) {
  const { t } = useI18n();
  const dur = (n: number | null) =>
    n === null ? '—' : n < 120 ? t('admin.seconds', { n: Math.round(n) }) : t('admin.queue.minutes', { n: Math.round(n / 60) });
  const pair = (p: { samples: number; p50Seconds: number; p90Seconds: number }) =>
    p.samples ? `${dur(p.p50Seconds)} / ${dur(p.p90Seconds)}` : '—';
  return (
    <div className="card stack">
      <h3>{t('admin.queue.h3')}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 'var(--s3)' }}>
        <div><span className="small muted">{t('admin.queue.concurrency')}</span><br /><strong className="num">{q.concurrency}</strong></div>
        <div><span className="small muted">{t('admin.queue.running')}</span><br /><strong className="num">{q.running}</strong></div>
        <div><span className="small muted">{t('admin.queue.waiting')}</span><br /><strong className="num">{q.waiting}</strong></div>
        <div><span className="small muted">{t('admin.queue.oldest')}</span><br /><strong className="num">{dur(q.oldestWaitSeconds)}</strong></div>
        <div><span className="small muted">{t('admin.queue.gen')}</span><br /><strong className="num">{pair(q.generation)}</strong></div>
        <div><span className="small muted">{t('admin.queue.wait')}</span><br /><strong className="num">{pair(q.wait)}</strong></div>
        <div>
          <span className="small muted">{t('admin.queue.timeouts')}</span><br />
          <strong className="num" style={{ color: q.timeouts7d > 0 ? 'var(--warning)' : undefined }}>{q.timeouts7d}</strong>
        </div>
      </div>
      {q.byLength.length > 0 && (
        <div className="table-wrap table-wrap--stack">
          <table>
            <thead>
              <tr><th>{t('admin.queue.length')}</th><th>{t('admin.queue.samples')}</th><th>{t('admin.queue.gen')}</th></tr>
            </thead>
            <tbody>
              {[...q.byLength].sort((a, b) => a.durationSeconds - b.durationSeconds).map((r) => (
                <tr key={r.durationSeconds}>
                  <td className="num">{t('admin.seconds', { n: r.durationSeconds })}</td>
                  <td className="num">{r.samples}</td>
                  <td className="num">{pair(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        {t('admin.queue.note', { provider: q.providerId, deadline: Math.round(q.queueDeadlineSeconds / 60) })}
      </p>
    </div>
  );
}

function OverviewPanel({ part }: { part: 'ops' | 'review' }) {
  const { t } = useI18n();
  const { me } = useSession();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [cases, setCases] = useState<RightsCase[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [o, c] = await Promise.all([
        apiFetch<Overview>('/v1/admin/overview'),
        apiFetch<{ items: RightsCase[] }>('/v1/admin/rights-cases'),
      ]);
      setOverview(o);
      setCases(c.items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolveCase = async (id: string, status: string) => {
    // The reason is mandatory server-side; asking here keeps the UI honest too.
    const reason = window.prompt(
      `この判断の理由を記録します（5文字以上・監査ログに残ります）\n対象: ${status}`,
    );
    if (!reason || reason.trim().length < 5) return;
    setBusy(id);
    setError(null);
    try {
      await apiFetch(`/v1/admin/rights-cases/${id}/resolve`, {
        method: 'POST',
        body: { status, reason: reason.trim() },
      });
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Loading label={t('admin.loading')} />;
  if (!overview) return <ErrorNotice error={error} onRetry={() => void load()} />;

  const ops = overview.operations;
  const isAdmin = me?.role === 'admin';

  return (
    <div className="stack stack--loose">
      <ErrorNotice error={error} onRetry={() => void load()} />

      {part === 'ops' && (
      <>
      <div className="alert alert--info small">{overview.disclaimer}</div>
      <div className="row">
        <Badge>{overview.mode}</Badge>
        <Badge tone={isAdmin ? 'badge--accent' : ''}>{me?.role}</Badge>
        {overview.build && (
          <span className="small muted" style={{ fontFamily: 'var(--mono)' }}>
            build {overview.build.sha ? overview.build.sha.slice(0, 7) : '—'} · {formatJst(overview.build.startedAt, false)}
          </span>
        )}
      </div>
      <NetxSwitch isAdmin={isAdmin} />
      {isAdmin && <CreditReset />}
      {isAdmin && <LyricRealign />}
      <section className="stack">
        <h2 style={{ fontSize: 18 }}>{t('admin.ops.h2')}</h2>
        <div className="grid">
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.ops.outbox')}</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {ops.oldestPendingOutboxSeconds === null
                ? '—'
                : t('admin.seconds', { n: ops.oldestPendingOutboxSeconds })}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.ops.webhook')}</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {ops.webhookBacklog}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.ops.stale')}</span>
            <strong
              className="num"
              style={{ fontSize: 24, color: ops.staleUnknownJobs > 0 ? 'var(--warning)' : undefined }}
            >
              {ops.staleUnknownJobs}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.ops.dlq')}</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {ops.deadLetteredMessages}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.ops.ledger')}</span>
            <strong
              className="num"
              style={{
                fontSize: 24,
                color: ops.ledgerDiscrepancies > 0 ? 'var(--danger)' : 'var(--ok)',
              }}
            >
              {ops.ledgerDiscrepancies}
            </strong>
            <span className="small muted">
              {ops.ledgerDiscrepancies > 0 ? t('admin.ops.ledgerBad') : t('admin.ops.ledgerOk')}
            </span>
          </div>
          <Metric label={t('admin.ops.successRate')} m={ops.technicalSuccessRate} />
        </div>

        <p className="small muted">{t('admin.ops.rateBasis')}</p>
        {ops.invariants && <InvariantsCard rules={ops.invariants} />}
        {ops.queue && <QueueCard q={ops.queue} />}
        <div className="card stack">
          <h3>{t('admin.ops.failures')}</h3>
          {ops.generationFailures?.length ? <div className="table-wrap table-wrap--stack"><table>
            <thead><tr><th>{t('admin.ops.reason')}</th><th>{t('admin.jobs.state')}</th><th>{t('admin.jobs.count')}</th></tr></thead>
            <tbody>{ops.generationFailures.map((f) => <tr key={`${f.state}:${f.code}`}>
              <td className="num">{f.code}</td><td>{f.state}</td><td className="num">{f.count}</td>
            </tr>)}</tbody>
          </table></div> : <p className="muted small">{t('admin.ops.noFailures')}</p>}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('admin.jobs.state')}</th>
                <th>{t('admin.jobs.count')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(ops.jobsByState).map(([state, n]) => (
                <tr key={state}>
                  <td className="num">{state}</td>
                  <td className="num">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack">
        <h2 style={{ fontSize: 18 }}>{t('admin.cost.h2')}</h2>
        <div className="grid">
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.cost.actual')}</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {formatMoney(overview.cost.actualCostMinor, overview.cost.currency)}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.cost.modelled')}</span>
            <strong className="num" style={{ fontSize: 24, color: 'var(--muted)' }}>
              {formatMoney(overview.cost.estimatedCostMinor, overview.cost.currency)}
            </strong>
            {/* §11.2: modelled cost is never added to the invoiced figure. */}
            <span className="small muted">{t('admin.cost.notSummed')}</span>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.cost.failures')}</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {formatMoney(overview.cost.billableFailureCostMinor, overview.cost.currency)}
            </strong>
            <span className="small muted">{t('admin.cost.notBilled')}</span>
          </div>
          <Metric label={t('admin.cost.perDelivery')} m={overview.cost.costPerDelivery} percent={false} />
          <Metric label={t('admin.cost.perAdopted')} m={overview.cost.costPerAdoptedResult} percent={false} />
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.cost.exportsAdopted')}</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {overview.cost.exportCount} / {overview.cost.adoptedCount}
            </strong>
            <span className="small muted">{t('admin.cost.downloadNote')}</span>
          </div>
        </div>
      </section>

      <section className="stack">
        <h2 style={{ fontSize: 18 }}>{t('admin.rev.h2')}</h2>
        <div className="grid">
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.rev.grossLabel')}</span>
            <strong className="num" style={{ fontSize: 20 }}>
              {formatMoney(overview.revenue.grossMinor, overview.revenue.currency)}
            </strong>
            <span className="small muted num">
              {t('admin.rev.refundFee', {
                refund: formatMoney(overview.revenue.refundedMinor, overview.revenue.currency),
                fee: formatMoney(overview.revenue.paymentFeeMinor, overview.revenue.currency),
              })}
            </span>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.rev.paidOrders')}</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {overview.revenue.paidOrderCount}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.rev.ungranted')}</span>
            <strong
              className="num"
              style={{
                fontSize: 24,
                color: overview.revenue.ungrantedPaidOrders > 0 ? 'var(--danger)' : 'var(--ok)',
              }}
            >
              {overview.revenue.ungrantedPaidOrders}
            </strong>
            <span className="small muted">{t('admin.rev.autoRecover')}</span>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">{t('admin.rev.refundDispute')}</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {overview.revenue.refundCount} / {overview.revenue.disputeCount}
            </strong>
          </div>
        </div>
      </section>

      <section className="stack">
        <h2 style={{ fontSize: 18 }}>{t('admin.funnel.h2')}</h2>
        <div className="grid">
          <Metric label={t('admin.funnel.activation')} m={overview.funnel.activationDay1} />
          <Metric label={t('admin.funnel.conversion')} m={overview.funnel.paidConversion14d} />
          <Metric label={t('admin.funnel.reuse')} m={overview.funnel.reuseDay7} />
          <Metric label={t('admin.funnel.renewal')} m={overview.funnel.firstRenewal} />
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {t('admin.funnel.note')}
        </p>
      </section>

      </>
      )}

      {part === 'review' && (
      <>
      <IssueQueue />
      <section className="stack">
        <h2 style={{ fontSize: 18 }}>{t('admin.cases.h2')}</h2>
        {cases.length === 0 ? (
          <p className="muted">{t('admin.cases.none')}</p>
        ) : (
          <div className="table-wrap table-wrap--stack">
            <table>
              <thead>
                <tr>
                  <th>{t('rights.caseNumber')}</th>
                  <th>{t('admin.cases.type')}</th>
                  <th>{t('admin.cases.status')}</th>
                  <th>{t('admin.cases.reporter')}</th>
                  <th>{t('admin.cases.received')}</th>
                  <th>{t('export.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td className="num small">{c.caseNumber}</td>
                    <td className="small">{c.claimType}</td>
                    <td>
                      <Badge tone={c.status === 'received' ? 'badge--warn' : ''}>{c.status}</Badge>
                    </td>
                    <td className="small muted">{c.reporterEmail}</td>
                    <td className="small muted">{formatJst(c.createdAt, false)}</td>
                    <td>
                      {isAdmin ? (
                        <div className="row">
                          {/* A claim no longer pauses the song by itself; taking it up does. */}
                          {c.status === 'received' && c.trackId && (
                            <button
                              type="button"
                              className="btn"
                              disabled={busy === c.id}
                              onClick={() => void resolveCase(c.id, 'under_review')}
                            >
                              {t('admin.cases.pause')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={busy === c.id}
                            onClick={() => void resolveCase(c.id, 'dismissed')}
                          >
                            {t('admin.cases.dismiss')}
                          </button>
                          <button
                            type="button"
                            className="btn btn--danger"
                            disabled={busy === c.id}
                            onClick={() => void resolveCase(c.id, 'upheld')}
                          >
                            {t('admin.cases.uphold')}
                          </button>
                        </div>
                      ) : (
                        <span className="small muted">{t('admin.cases.adminOnly')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          {t('admin.cases.auditNote')}
        </p>
      </section>

      {/*
        All three load their own data, deliberately. A failing payment
        endpoint must not blank the job queue and the ledger discrepancies
        above it — and the stablecoin channel is switched off on most
        deployments. ("Both" when there were two of them.)
      */}
      <HeldOrderConsole />
      <StablecoinConsole />
      </>
      )}
    </div>
  );
}

/**
 * The console, in tabs. It was one long page — overview, costs, revenue,
 * funnel, rights cases, customers, held orders, stablecoin review — so the
 * thing an operator came for was always several screens down, and every
 * section's data loaded on every visit. Each tab now loads only its own.
 *
 * The tab is in the URL (/admin/users, /admin/orders …) so a link to "the
 * orders list" is a link, and Back works.
 */
const TABS = [
  { key: 'dashboard', path: '/admin', label: 'admin.tab.dashboard' },
  { key: 'users', path: '/admin/users', label: 'admin.tab.users' },
  { key: 'orders', path: '/admin/orders', label: 'admin.tab.orders' },
  { key: 'ops', path: '/admin/ops', label: 'admin.tab.ops' },
  { key: 'review', path: '/admin/review', label: 'admin.tab.review' },
  { key: 'audit', path: '/admin/audit', label: 'admin.tab.audit' },
] as const;

export default function Admin() {
  const { t } = useI18n();
  const { me } = useSession();
  const { tab = 'dashboard' } = useParams<{ tab?: string }>();
  const known = TABS.some((x) => x.key === tab);

  return (
    <div className="stack stack--loose admin">
      <div className="row row--between">
        <h1 style={{ fontSize: 28, margin: 0 }}>{t('admin.h1')}</h1>
        <Badge tone={me?.role === 'admin' ? 'badge--accent' : ''}>{me?.role}</Badge>
      </div>
      <nav className="admin-tabs" aria-label={t('admin.tabs.aria')}>
        {TABS.map((x) => (
          <NavLink
            key={x.key}
            to={x.path}
            end
            className={({ isActive }) => `admin-tabs__tab${isActive ? ' is-active' : ''}`}
          >
            {t(x.label)}
          </NavLink>
        ))}
      </nav>
      {(!known || tab === 'dashboard') && <Dashboard />}
      {tab === 'users' && <CustomerConsole />}
      {tab === 'orders' && <OrdersPanel />}
      {tab === 'ops' && <OverviewPanel part="ops" />}
      {tab === 'review' && <OverviewPanel part="review" />}
      {tab === 'audit' && <AuditPanel />}
    </div>
  );
}
