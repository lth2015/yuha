import { query } from './pool.js';

/**
 * Things that must never be true at the same time
 * (docs/agents/CODEX_COLLABORATION.md, 「逻辑规则」).
 *
 * Each rule is a query that returns every row breaking it; none is the only
 * passing answer. They are read-only and cheap enough to run against
 * production, which is the point: a test proves the code we exercised keeps
 * the rule, this proves the data the code actually wrote keeps it.
 *
 * Every rule has a test that writes a row breaking it and expects it to be
 * found (tests/invariants.test.ts). A check that has never caught anything
 * may be checking nothing — the list of needles that came back empty, the
 * green tick over the wrong object, both in CLAUDE.md.
 *
 * Two rules from the collaboration guide are not here because the database
 * already refuses to store a breach: a batch never overdrawn
 * (`reserved_units + consumed_units <= granted_units`, a CHECK) and a job
 * reserving, consuming or releasing at most once (the unique
 * `job_entry_uk`). A rule the schema enforces needs no query.
 *
 * `id` in each row is what to look at — a job, batch, order, track or
 * report id, never a person's name or address, so a run's output can be
 * pasted into a PR.
 */
export interface Invariant {
  name: string;
  /** The rule, in the words of the collaboration guide. */
  rule: string;
  /** Returns `{ id }` rows, one per breach. */
  sql: string;
}

const TERMINAL = `('DELIVERED','FAILED','REJECTED','CANCELLED')`;
const ENDED_WITHOUT_SONG = `('FAILED','REJECTED','CANCELLED')`;
const has = (type: string) =>
  `EXISTS (SELECT 1 FROM ledger_entries l WHERE l.job_id = j.id AND l.entry_type = '${type}')`;

export const INVARIANTS: readonly Invariant[] = [
  {
    name: 'delivered-job-has-a-song',
    rule: '交付了的任务一定有作品',
    sql: `SELECT j.id FROM generation_jobs j LEFT JOIN tracks t ON t.id = j.track_id AND t.job_id = j.id
           WHERE j.state = 'DELIVERED' AND t.id IS NULL`,
  },
  {
    name: 'delivered-job-spent-its-credit',
    rule: '交付了的任务一定已结算额度',
    sql: `SELECT j.id FROM generation_jobs j
           WHERE j.state = 'DELIVERED' AND ${has('reserve')} AND NOT ${has('consume')}`,
  },
  {
    name: 'failed-job-never-charged',
    rule: '失败、被拒、取消的任务从不扣额度',
    sql: `SELECT j.id FROM generation_jobs j WHERE j.state IN ${ENDED_WITHOUT_SONG} AND ${has('consume')}`,
  },
  {
    name: 'ended-job-holds-no-credit',
    rule: '结束了的任务不再暂扣额度',
    sql: `SELECT j.id FROM generation_jobs j
           WHERE j.state IN ${TERMINAL} AND ${has('reserve')} AND NOT ${has('consume')} AND NOT ${has('release')}`,
  },
  {
    name: 'credit-not-both-spent-and-returned',
    rule: '一个任务不能既「已使用」又「已退回」',
    sql: `SELECT j.id FROM generation_jobs j WHERE ${has('consume')} AND ${has('release')}`,
  },
  {
    name: 'open-job-not-settled',
    rule: '进行中的任务还没有结算',
    sql: `SELECT j.id FROM generation_jobs j
           WHERE j.state NOT IN ${TERMINAL} AND (${has('consume')} OR ${has('release')})`,
  },
  {
    name: 'finished-at-iff-ended',
    rule: '有结束时间，当且仅当任务已经结束',
    sql: `SELECT j.id FROM generation_jobs j
           WHERE (j.state IN ${TERMINAL}) <> (j.finished_at IS NOT NULL)`,
  },
  {
    name: 'batch-counters-match-ledger',
    rule: '批次的计数和账本一致',
    sql: `SELECT b.id FROM entitlement_batches b
            JOIN (SELECT batch_id,
                         SUM(CASE WHEN entry_type = 'grant'   THEN units ELSE 0 END)
                       - SUM(CASE WHEN entry_type = 'revoke'  THEN units ELSE 0 END) AS granted,
                         SUM(CASE WHEN entry_type = 'reserve' THEN units ELSE 0 END)
                       - SUM(CASE WHEN entry_type = 'consume' THEN units ELSE 0 END)
                       - SUM(CASE WHEN entry_type = 'release' THEN units ELSE 0 END) AS reserved,
                         SUM(CASE WHEN entry_type = 'consume' THEN units ELSE 0 END) AS consumed
                    FROM ledger_entries WHERE batch_id IS NOT NULL GROUP BY batch_id) a ON a.batch_id = b.id
           WHERE b.granted_units <> a.granted OR b.reserved_units <> a.reserved OR b.consumed_units <> a.consumed`,
  },
  {
    // A song licence is a one-time order too, and grants a licence rather
    // than credits — the first run of this rule flagged all nine in
    // tests/market.test.ts until it said so. The licence has its own rule below.
    name: 'paid-order-granted',
    rule: '付了钱、标了已发放的额度订单，确实有它的额度批次',
    sql: `SELECT o.id FROM orders o
            LEFT JOIN entitlement_batches b ON b.user_id = o.user_id AND b.source = 'one_time_order' AND b.source_ref = o.id
           WHERE o.kind = 'one_time' AND o.price_key <> 'market_license'
             AND o.entitlement_granted_at IS NOT NULL AND b.id IS NULL`,
  },
  {
    name: 'paid-licence-order-has-its-licence',
    rule: '付了钱、标了已发放的授权订单，确实有它的授权记录',
    sql: `SELECT o.id FROM orders o LEFT JOIN track_licenses tl ON tl.order_id = o.id
           WHERE o.price_key = 'market_license' AND o.entitlement_granted_at IS NOT NULL AND tl.id IS NULL`,
  },
  {
    name: 'unpaid-order-grants-nothing',
    rule: '没付钱的订单什么都没发',
    sql: `SELECT o.id FROM orders o
            JOIN entitlement_batches b ON b.user_id = o.user_id AND b.source = 'one_time_order' AND b.source_ref = o.id
           WHERE o.status IN ('pending','failed','canceled')`,
  },
  {
    name: 'refunded-order-left-nothing-spendable',
    rule: '全额退款的订单没有留下还能用的额度',
    sql: `SELECT o.id FROM orders o
            JOIN entitlement_batches b ON b.user_id = o.user_id AND b.source = 'one_time_order' AND b.source_ref = o.id
           WHERE o.status = 'refunded' AND b.status = 'active'
             AND b.granted_units - b.reserved_units - b.consumed_units > 0`,
  },
  {
    name: 'song-belongs-to-its-maker',
    rule: '歌的主人就是生成它的人',
    sql: `SELECT t.id FROM tracks t JOIN generation_jobs j ON j.id = t.job_id WHERE t.owner_id <> j.user_id`,
  },
  {
    name: 'report-status-matches-its-fields',
    rule: '已处理的报告有处理时间和说明；未处理的报告没有补偿',
    sql: `SELECT r.id FROM issue_reports r
           WHERE (r.status = 'resolved' AND (r.resolved_at IS NULL OR r.resolution IS NULL))
              OR (r.status = 'open' AND (r.resolved_at IS NOT NULL OR r.compensation_batch_id IS NOT NULL))`,
  },
  {
    name: 'report-compensation-goes-to-its-owner',
    rule: '报告上的补偿批次属于报告的主人，来源是「补偿」',
    sql: `SELECT r.id FROM issue_reports r LEFT JOIN entitlement_batches b ON b.id = r.compensation_batch_id
           WHERE r.compensation_batch_id IS NOT NULL
             AND (b.id IS NULL OR b.user_id <> r.user_id OR b.source <> 'compensation')`,
  },
  {
    name: 'job-compensation-points-at-its-job',
    rule: '绑在任务上的补偿，批次也指向同一个任务',
    sql: `SELECT l.id FROM ledger_entries l LEFT JOIN entitlement_batches b ON b.id = l.batch_id
           WHERE l.entry_type = 'compensate' AND l.job_id IS NOT NULL
             AND (b.id IS NULL OR b.source <> 'compensation' OR b.source_ref <> CONCAT('job:', l.job_id))`,
  },
];

export interface InvariantResult {
  name: string;
  rule: string;
  count: number;
  /** Up to five ids to look at. */
  sample: string[];
}

/** Runs every rule (or the named ones). Read-only. */
export async function checkInvariants(only?: readonly string[]): Promise<InvariantResult[]> {
  const rules = only ? INVARIANTS.filter((i) => only.includes(i.name)) : INVARIANTS;
  if (only && rules.length !== only.length) {
    const unknown = only.filter((n) => !INVARIANTS.some((i) => i.name === n));
    throw new Error(`unknown invariant(s): ${unknown.join(', ')}`);
  }
  const results: InvariantResult[] = [];
  for (const inv of rules) {
    const rows = await query<{ id: string }>(`SELECT v.id FROM (${inv.sql}) v ORDER BY v.id LIMIT 1000`);
    results.push({ name: inv.name, rule: inv.rule, count: rows.length, sample: rows.slice(0, 5).map((r) => r.id) });
  }
  return results;
}
