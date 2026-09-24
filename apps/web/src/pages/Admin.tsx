import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
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
    actualCostMinor: number;
    estimatedCostMinor: number;
    billableFailureCostMinor: number;
    costPerDelivery: Measured;
    costPerAdoptedResult: Measured;
    exportCount: number;
    adoptedCount: number;
  };
  revenue: {
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
  return (
    <div className="card" style={{ gap: 4 }}>
      <span className="small muted">{label}</span>
      {m.value === null ? (
        <>
          <strong style={{ color: 'var(--text-muted)' }}>算出できません</strong>
          <span className="small muted">{m.unavailableReason}</span>
        </>
      ) : (
        <>
          <strong className="num" style={{ fontSize: 24 }}>
            {percent ? `${(m.value * 100).toFixed(1)}%` : m.value.toFixed(1)}
          </strong>
          <span className="small muted">
            母数 n=<span className="num">{m.n}</span>
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

  if (loading) return <Loading label="管理データを読み込み中" />;
  if (!overview) return <ErrorNotice error={error} onRetry={() => void load()} />;

  const ops = overview.operations;
  const isAdmin = me?.role === 'admin';

  return (
    <div className="stack stack--loose">
      <div className="row row--between">
        <h1 style={{ fontSize: 28, margin: 0 }}>運営ダッシュボード</h1>
        <div className="row">
          <Badge>{overview.mode}</Badge>
          <Badge tone={isAdmin ? 'badge--accent' : ''}>{me?.role}</Badge>
        </div>
      </div>

      <div className="alert alert--info small">{overview.disclaimer}</div>
      <ErrorNotice error={error} onRetry={() => void load()} />

      <section className="stack">
        <h2 style={{ fontSize: 18 }}>稼働状況</h2>
        <div className="grid">
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">Outbox 最古の未送信</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {ops.oldestPendingOutboxSeconds === null ? '—' : `${ops.oldestPendingOutboxSeconds}秒`}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">Webhook 未処理</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {ops.webhookBacklog}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">確認中で滞留（15分超）</span>
            <strong
              className="num"
              style={{ fontSize: 24, color: ops.staleUnknownJobs > 0 ? 'var(--warning)' : undefined }}
            >
              {ops.staleUnknownJobs}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">DLQ 滞留</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {ops.deadLetteredMessages}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">台帳の不一致</span>
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
              {ops.ledgerDiscrepancies > 0 ? '自動修正しません。原因を調査してください' : '整合しています'}
            </span>
          </div>
          <Metric label="技術的成功率（7日）" m={ops.technicalSuccessRate} />
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>状態</th>
                <th>件数</th>
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
        <h2 style={{ fontSize: 18 }}>コスト（直近30日）</h2>
        <div className="grid">
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">実請求ベースの上流費用</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {formatMoney(overview.cost.actualCostMinor)}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">試算値（予算前提）</span>
            <strong className="num" style={{ fontSize: 24, color: 'var(--text-muted)' }}>
              {formatMoney(overview.cost.estimatedCostMinor)}
            </strong>
            {/* §11.2: modelled cost is never added to the invoiced figure. */}
            <span className="small muted">請求実績とは合算していません</span>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">課金対象の失敗分</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {formatMoney(overview.cost.billableFailureCostMinor)}
            </strong>
            <span className="small muted">利用者には請求していません</span>
          </div>
          <Metric label="1納品あたりコスト" m={overview.cost.costPerDelivery} percent={false} />
          <Metric label="採用1件あたりコスト" m={overview.cost.costPerAdoptedResult} percent={false} />
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">書き出し / 採用報告</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {overview.cost.exportCount} / {overview.cost.adoptedCount}
            </strong>
            <span className="small muted">ダウンロードは採用と同一ではありません</span>
          </div>
        </div>
      </section>

      <section className="stack">
        <h2 style={{ fontSize: 18 }}>売上（直近30日）</h2>
        <div className="grid">
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">総額 / 返金 / 手数料</span>
            <strong className="num" style={{ fontSize: 20 }}>
              {formatMoney(overview.revenue.grossMinor)}
            </strong>
            <span className="small muted num">
              返金 {formatMoney(overview.revenue.refundedMinor)} / 手数料{' '}
              {formatMoney(overview.revenue.paymentFeeMinor)}
            </span>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">支払い済み注文</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {overview.revenue.paidOrderCount}
            </strong>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">課金済みで未付与</span>
            <strong
              className="num"
              style={{
                fontSize: 24,
                color: overview.revenue.ungrantedPaidOrders > 0 ? 'var(--danger)' : 'var(--ok)',
              }}
            >
              {overview.revenue.ungrantedPaidOrders}
            </strong>
            <span className="small muted">自動復旧の対象です</span>
          </div>
          <div className="card" style={{ gap: 4 }}>
            <span className="small muted">返金 / チャージバック</span>
            <strong className="num" style={{ fontSize: 24 }}>
              {overview.revenue.refundCount} / {overview.revenue.disputeCount}
            </strong>
          </div>
        </div>
      </section>

      <section className="stack">
        <h2 style={{ fontSize: 18 }}>ファネル（成熟コホートのみ）</h2>
        <div className="grid">
          <Metric label="初日アクティベーション" m={overview.funnel.activationDay1} />
          <Metric label="14日以内の有料転換" m={overview.funnel.paidConversion14d} />
          <Metric label="7日目の再利用" m={overview.funnel.reuseDay7} />
          <Metric label="初回更新率" m={overview.funnel.firstRenewal} />
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          観察期間が終了していないユーザーは母数から除外しています。
          未成熟なコホートは、成功にも失敗にも数えません。
        </p>
      </section>

      <section className="stack">
        <h2 style={{ fontSize: 18 }}>権利申立</h2>
        {cases.length === 0 ? (
          <p className="muted">現在お申し立てはありません。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>受付番号</th>
                  <th>種類</th>
                  <th>状態</th>
                  <th>申立者</th>
                  <th>受付</th>
                  <th>操作</th>
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
                            却下・復旧
                          </button>
                          <button
                            type="button"
                            className="btn btn--danger"
                            disabled={busy === c.id}
                            onClick={() => void resolveCase(c.id, 'upheld')}
                          >
                            認容・停止
                          </button>
                        </div>
                      ) : (
                        <span className="small muted">管理者のみ操作できます</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          判断には必ず理由を記録します。操作者・日時・変更前後の状態は監査ログに保存されます。
          停止しても、すでに外部に保存されたファイルを技術的に回収することはできません。
        </p>
      </section>
    </div>
  );
}
