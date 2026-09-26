import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatMoney, formatJst, useSession } from '../lib/session';
import { Badge, ErrorNotice, Loading } from '../components/common';

interface Measured {
  value: number | null;
  n: number;
  unavailableReason: string | null;
}

interface Overview {
  mode: string;
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
          <strong style={{ color: 'var(--text-muted)' }}>{t('admin.notComputable')}</strong>
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
export default function Admin() {
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
      <div className="row row--between">
        <h1 style={{ fontSize: 28, margin: 0 }}>{t('admin.h1')}</h1>
        <div className="row">
          <Badge>{overview.mode}</Badge>
          <Badge tone={isAdmin ? 'badge--accent' : ''}>{me?.role}</Badge>
        </div>
      </div>

      <div className="alert alert--info small">{overview.disclaimer}</div>
      <ErrorNotice error={error} onRetry={() => void load()} />

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
            <strong className="num" style={{ fontSize: 24, color: 'var(--text-muted)' }}>
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

      <section className="stack">
        <h2 style={{ fontSize: 18 }}>{t('admin.cases.h2')}</h2>
        {cases.length === 0 ? (
          <p className="muted">{t('admin.cases.none')}</p>
        ) : (
          <div className="table-wrap">
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
    </div>
  );
}
