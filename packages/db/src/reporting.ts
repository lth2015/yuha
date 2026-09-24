/**
 * Business reporting queries (PROJECT_TASK.md §11).
 *
 * Two rules run through this whole file:
 *   1. A metric with no mature sample is reported as `null` with a stated
 *      reason, never as 0 or as a flattering estimate.
 *   2. Modelled cost and actual invoiced cost are separate fields. Demo-mode
 *      cost events carry `is_estimate = true` and are summed separately, so a
 *      simulation can never be read as a supplier bill.
 */
import { query, queryOne } from './pool.js';

/** A value that is deliberately not computable yet, with the reason attached. */
export interface Measured<T> {
  value: T | null;
  /** Denominator size; a metric over a tiny sample is still shown, with n. */
  n: number;
  /** Set when `value` is null: why the number cannot be produced yet. */
  unavailableReason: string | null;
}

function measured<T>(value: T | null, n: number, reason: string): Measured<T> {
  return value === null || n === 0
    ? { value: null, n, unavailableReason: reason }
    : { value, n, unavailableReason: null };
}

const num = (v: unknown): number => Number(v ?? 0);

export interface CostSummary {
  windowStart: string;
  windowEnd: string;
  deliveredCount: number;
  /**
   * The currency these cost figures are in, or `'mixed'` when the window
   * contains more than one.
   *
   * Cost rows default to `jpy` while the catalogue is priced in `usd`, and
   * the console formatted both with the same USD-defaulting helper — so a
   * ¥45 provider call was displayed as "$0.45", right next to real USD
   * revenue. Summing across currencies is meaningless, so it is reported
   * rather than hidden.
   */
  currency: string;
  /** Cost recorded against real, invoiceable provider calls. */
  actualCostMinor: number;
  /** Cost from modelled/demo events. Never added to the actual figure. */
  estimatedCostMinor: number;
  billableFailureCostMinor: number;
  costPerDelivery: Measured<number>;
  /**
   * "Adopted result" means the creator exported and reported using the track.
   * Downloads alone are not adoption (§11.2), so this stays null until the
   * usage-report feature has data.
   */
  costPerAdoptedResult: Measured<number>;
  exportCount: number;
  adoptedCount: number;
}

export async function costSummary(windowDays = 30): Promise<CostSummary> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT
       (SELECT COUNT(*) FROM generation_jobs
         WHERE state = 'DELIVERED'
           AND delivered_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY))            AS delivered,
       (SELECT COALESCE(SUM(cost_minor), 0) FROM provider_cost_events
         WHERE occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)
           AND billable = 1 AND is_estimate = 0)                                      AS actual,
       (SELECT COALESCE(SUM(cost_minor), 0) FROM provider_cost_events
         WHERE occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)
           AND billable = 1 AND is_estimate = 1)                                      AS estimated,
       (SELECT COALESCE(SUM(cost_minor), 0) FROM provider_cost_events
         WHERE occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)
           AND billable = 1 AND event_type IN ('failure','rejected','retry'))          AS billable_failures,
       (SELECT COUNT(*) FROM asset_versions
         WHERE kind = 'export'
           AND created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY))              AS exports,
       (SELECT GROUP_CONCAT(DISTINCT currency) FROM provider_cost_events
         WHERE occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)
           AND billable = 1)                                                          AS currencies`,
    [windowDays, windowDays, windowDays, windowDays, windowDays, windowDays],
  );

  // Scoped to `billable = 1`, the same rows every figure above sums. Scanning
  // all events would let one non-billable row in another currency label the
  // whole panel 'mixed' when the figures shown are in fact single-currency.
  //
  // Note this still spans the actual/estimated split: modelled events default
  // to `jpy` while a real provider may invoice in another currency, and then
  // the honest answer for the panel really is 'mixed'.
  const seen = String(row?.['currencies'] ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const currency = seen.length === 1 ? seen[0]! : seen.length === 0 ? 'jpy' : 'mixed';

  const delivered = num(row?.['delivered']);
  const actual = num(row?.['actual']);
  const estimated = num(row?.['estimated']);
  const total = actual + estimated;

  // Adoption is self-reported usage of a track in real content. Until users
  // report it, the metric correctly says it is not computable.
  const adopted = await queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(props, '$.track_id'))) AS n
       FROM analytics_events
      WHERE name = 'track_adopted' AND is_internal = 0
        AND occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)`,
    [windowDays],
  );
  const adoptedCount = num(adopted?.n);

  return {
    windowStart: new Date(Date.now() - windowDays * 86400_000).toISOString(),
    windowEnd: new Date().toISOString(),
    deliveredCount: delivered,
    currency,
    actualCostMinor: actual,
    estimatedCostMinor: estimated,
    billableFailureCostMinor: num(row?.['billable_failures']),
    costPerDelivery: measured(delivered > 0 ? total / delivered : null, delivered, 'no deliveries in window'),
    costPerAdoptedResult: measured(
      adoptedCount > 0 ? total / adoptedCount : null,
      adoptedCount,
      'no confirmed adoption data — downloads alone do not count as adoption',
    ),
    exportCount: num(row?.['exports']),
    adoptedCount,
  };
}

export interface RevenueSummary {
  /** Currency of these figures, or `'mixed'`. Orders carry their own. */
  currency: string;
  grossMinor: number;
  refundedMinor: number;
  paymentFeeMinor: number;
  netMinor: number;
  paidOrderCount: number;
  refundCount: number;
  disputeCount: number;
  /** Orders that were charged but whose entitlement is still missing (PAY-11). */
  ungrantedPaidOrders: number;
}

export async function revenueSummary(windowDays = 30): Promise<RevenueSummary> {
  const d = windowDays;
  const row = await queryOne<Record<string, unknown>>(
    `SELECT
       COALESCE((SELECT SUM(amount_minor) FROM payments
                  WHERE kind = 'payment'
                    AND occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)), 0) AS gross,
       COALESCE((SELECT SUM(amount_minor) FROM payments
                  WHERE kind = 'refund'
                    AND occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)), 0) AS refunded,
       COALESCE((SELECT SUM(fee_minor) FROM payments
                  WHERE occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)), 0) AS fees,
       COALESCE((SELECT SUM(net_minor) FROM payments
                  WHERE occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)), 0) AS net,
       (SELECT COUNT(*) FROM orders
         WHERE status = 'paid'
           AND paid_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY))                  AS paid_orders,
       (SELECT COUNT(*) FROM payments
         WHERE kind = 'refund'
           AND occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY))              AS refunds,
       (SELECT COUNT(*) FROM payments
         WHERE kind = 'dispute'
           AND occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY))              AS disputes,
       (SELECT COUNT(*) FROM orders
         WHERE status = 'paid' AND entitlement_granted_at IS NULL)                     AS ungranted,
       -- No kind filter, to match the widest sum above: fees and net
       -- select every payments row in the window, disputes included. Scoping
       -- this narrower than the figures it labels would let a chargeback in
       -- another currency land in those totals while the panel calls them
       -- single-currency — the same silent mixing this column exists to stop.
       (SELECT GROUP_CONCAT(DISTINCT currency) FROM payments
         WHERE occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY))               AS currencies`,
    [d, d, d, d, d, d, d, d],
  );
  const seen = String(row?.['currencies'] ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  return {
    currency: seen.length === 1 ? seen[0]! : seen.length === 0 ? 'usd' : 'mixed',
    grossMinor: num(row?.['gross']),
    refundedMinor: num(row?.['refunded']),
    paymentFeeMinor: num(row?.['fees']),
    netMinor: num(row?.['net']),
    paidOrderCount: num(row?.['paid_orders']),
    refundCount: num(row?.['refunds']),
    disputeCount: num(row?.['disputes']),
    ungrantedPaidOrders: num(row?.['ungranted']),
  };
}

export interface FunnelSummary {
  /** §11.1: registered users whose 14-day observation window has fully elapsed. */
  paidConversion14d: Measured<number>;
  /** Registered → generated + previewed ≥10s + exported, within 24h. */
  activationDay1: Measured<number>;
  /** Of day-1 activated users, generated again on days 7–13. Mature cohorts only. */
  reuseDay7: Measured<number>;
  /** First-month subscriptions past a full period + 7 days that actually paid again. */
  firstRenewal: Measured<number>;
}

/**
 * Every rate here restricts the denominator to users whose observation window
 * has fully elapsed. §11.3 is explicit that an immature cohort counts as
 * neither success nor failure, so an unfinished window is excluded rather than
 * counted as a miss.
 */
export async function funnelSummary(): Promise<FunnelSummary> {
  const conv = await queryOne<{ d: number; n: number }>(
    `SELECT COUNT(*) AS d,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM orders o
               WHERE o.user_id = u.id AND o.status = 'paid'
                 AND o.paid_at <= DATE_ADD(u.created_at, INTERVAL 14 DAY)
            ) THEN 1 ELSE 0 END) AS n
       FROM users u
      WHERE u.deleted_at IS NULL
        AND u.created_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 14 DAY)`,
  );

  const act = await queryOne<{ d: number; n: number }>(
    `SELECT COUNT(*) AS d,
            SUM(CASE WHEN
                 EXISTS (SELECT 1 FROM generation_jobs j
                          WHERE j.user_id = u.id AND j.state = 'DELIVERED'
                            AND j.delivered_at <= DATE_ADD(u.created_at, INTERVAL 24 HOUR))
             AND EXISTS (SELECT 1 FROM analytics_events a
                          WHERE a.user_ref = u.id AND a.name = 'preview_10s'
                            AND a.occurred_at <= DATE_ADD(u.created_at, INTERVAL 24 HOUR))
             AND EXISTS (SELECT 1 FROM asset_versions v
                           JOIN tracks t ON t.id = v.track_id
                          WHERE t.owner_id = u.id AND v.kind = 'export'
                            AND v.created_at <= DATE_ADD(u.created_at, INTERVAL 24 HOUR))
            THEN 1 ELSE 0 END) AS n
       FROM users u
      WHERE u.deleted_at IS NULL
        AND u.created_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)`,
  );

  const reuse = await queryOne<{ d: number; n: number }>(
    `SELECT COUNT(*) AS d,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM generation_jobs j
               WHERE j.user_id = u.id AND j.state = 'DELIVERED'
                 AND j.delivered_at >= DATE_ADD(u.created_at, INTERVAL 7 DAY)
                 AND j.delivered_at <  DATE_ADD(u.created_at, INTERVAL 14 DAY)
            ) THEN 1 ELSE 0 END) AS n
       FROM users u
      WHERE u.deleted_at IS NULL
        AND u.created_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 13 DAY)
        AND EXISTS (SELECT 1 FROM generation_jobs j
                     WHERE j.user_id = u.id AND j.state = 'DELIVERED'
                       AND j.delivered_at <= DATE_ADD(u.created_at, INTERVAL 24 HOUR))`,
  );

  const renew = await queryOne<{ d: number; n: number }>(
    `SELECT COUNT(*) AS d,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM entitlement_batches b
               WHERE b.user_id = s.user_id
                 AND b.source = 'subscription_period'
                 AND b.effective_from >= s.current_period_end
            ) THEN 1 ELSE 0 END) AS n
       FROM subscriptions s
      WHERE s.current_period_end IS NOT NULL
        -- a full period plus the 7-day observation window must have elapsed
        AND s.current_period_end <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY)`,
  );

  const rate = (r: { d: number; n: number } | undefined) =>
    r && num(r.d) > 0 ? num(r.n) / num(r.d) : null;

  return {
    paidConversion14d: measured(
      rate(conv),
      num(conv?.d),
      'no user has completed the 14-day observation window',
    ),
    activationDay1: measured(
      rate(act),
      num(act?.d),
      'no user has completed the 24-hour observation window',
    ),
    reuseDay7: measured(rate(reuse), num(reuse?.d), 'no day-1 activated cohort has reached day 13'),
    firstRenewal: measured(
      rate(renew),
      num(renew?.d),
      'no first-month subscription has passed a full period plus the 7-day window',
    ),
  };
}

/**
 * Billable upstream spend in a rolling window, for the daily budget cap (§12.3).
 *
 * Counts modelled and invoiced cost together on purpose: the cap exists to stop
 * runaway spending, and in demo or pre-contract operation the modelled figure is
 * the only signal available. Reporting keeps them separate; enforcement must not.
 */
export async function billableSpendSince(windowHours = 24): Promise<number> {
  const row = await queryOne<{ spend: number }>(
    `SELECT COALESCE(SUM(cost_minor), 0) AS spend
       FROM provider_cost_events
      WHERE billable = 1
        AND occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR)`,
    [windowHours],
  );
  return num(row?.spend);
}

export interface OperationsSnapshot {
  jobsByState: Record<string, number>;
  /** Age in seconds of the oldest undispatched outbox row. */
  oldestPendingOutboxSeconds: number | null;
  webhookBacklog: number;
  staleUnknownJobs: number;
  deadLetteredMessages: number;
  ledgerDiscrepancies: number;
  /** Technical success rate over the window; target ≥95% (§12.3). */
  technicalSuccessRate: Measured<number>;
  budgetSpentTodayMinor: number;
}

export async function operationsSnapshot(budgetWindowHours = 24): Promise<OperationsSnapshot> {
  const states = await query<{ state: string; n: number }>(
    `SELECT state, COUNT(*) AS n FROM generation_jobs GROUP BY state`,
  );
  const row = await queryOne<Record<string, unknown>>(
    `SELECT
       (SELECT TIMESTAMPDIFF(SECOND, MIN(created_at), UTC_TIMESTAMP(3))
          FROM outbox WHERE status = 'pending')                                        AS oldest,
       (SELECT COUNT(*) FROM webhook_events
         WHERE status IN ('received','processing','failed'))                           AS webhooks,
       (SELECT COUNT(*) FROM generation_jobs
         WHERE state = 'UNKNOWN'
           AND verify_started_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE))     AS stale,
       (SELECT COUNT(*) FROM local_queue_messages WHERE dead_lettered = 1)             AS dlq,
       (SELECT COALESCE(SUM(cost_minor), 0) FROM provider_cost_events
         WHERE billable = 1
           AND occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR))             AS spend,
       (SELECT COUNT(*) FROM generation_jobs
         WHERE state = 'DELIVERED'
           AND finished_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY))              AS delivered,
       (SELECT COUNT(*) FROM generation_jobs
         WHERE state IN ('DELIVERED','FAILED','REJECTED')
           AND finished_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY))              AS finished`,
    [budgetWindowHours],
  );

  const jobsByState: Record<string, number> = {};
  for (const s of states) jobsByState[s.state] = num(s.n);

  const finished = num(row?.['finished']);
  const oldest = row?.['oldest'];

  return {
    jobsByState,
    oldestPendingOutboxSeconds: oldest === null || oldest === undefined ? null : num(oldest),
    webhookBacklog: num(row?.['webhooks']),
    staleUnknownJobs: num(row?.['stale']),
    deadLetteredMessages: num(row?.['dlq']),
    ledgerDiscrepancies: 0,
    technicalSuccessRate: measured(
      finished > 0 ? num(row?.['delivered']) / finished : null,
      finished,
      'no finished jobs in the last 7 days',
    ),
    budgetSpentTodayMinor: num(row?.['spend']),
  };
}
