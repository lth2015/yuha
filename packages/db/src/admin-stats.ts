import { query } from './pool.js';

/**
 * Time-bucketed numbers for the operator dashboard.
 *
 * Every bucket is a calendar unit in Japan time. JST has no daylight saving,
 * so "in Japan time" is exactly `+ 9 hours`, done in SQL with DATE_ADD rather
 * than CONVERT_TZ — which needs the server's time-zone tables, and returns
 * NULL without a word on a server that has not loaded them.
 *
 *   day    2026-10-20
 *   week   the Monday it starts on (ISO weeks), 2026-10-19
 *   month  2026-10
 *   year   2026
 *
 * Buckets with nothing in them are returned as zeros, not omitted: a chart
 * that silently skips a day with no sales draws a line through it.
 *
 * What each number counts, so nobody has to guess from the label:
 *
 *   pageViews / visitors  `page_view` rows (anonymous visitor id, no IP),
 *                         internal/demo traffic excluded. Distinct visitors
 *                         are distinct within the bucket; the range total is
 *                         distinct across the whole range, not a sum.
 *   signups               accounts created.
 *   generations           jobs created, then split by where they ended:
 *                         delivered, failed (FAILED/REJECTED), or still open.
 *   paidOrders/revenue    orders paid in the bucket (by `paid_at`), counted
 *                         even if later refunded — refunds are their own line.
 *                         Split by how they were paid: card, JPYC, USDC.
 *   refunds               card refunds recorded in the bucket (by when they
 *                         happened). Stablecoin refunds are drafted and signed
 *                         by hand and are not in this line.
 *   creditsGranted        units put into accounts, by the source of the batch
 *                         (`grant` entries only: a compensation writes a
 *                         `grant` AND a `compensate` annotation for the same
 *                         units, and counting both would double it).
 *   creditsConsumed       units spent on delivered songs.
 */
export type Granularity = 'day' | 'week' | 'month' | 'year';

const JST_OFFSET_MS = 9 * 3600_000;

/** A column, in Japan time, as the bucket key string for `granularity`. */
function bucketSql(column: string, granularity: Granularity): string {
  const jst = `DATE_ADD(${column}, INTERVAL 9 HOUR)`;
  switch (granularity) {
    case 'day':
      return `DATE_FORMAT(${jst}, '%Y-%m-%d')`;
    case 'week':
      return `DATE_FORMAT(DATE_SUB(DATE(${jst}), INTERVAL WEEKDAY(${jst}) DAY), '%Y-%m-%d')`;
    case 'month':
      return `DATE_FORMAT(${jst}, '%Y-%m')`;
    case 'year':
      return `DATE_FORMAT(${jst}, '%Y')`;
  }
}

/** A JST calendar date as `YYYY-MM-DD`, from a UTC instant. */
function jstDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The bucket key a JST date falls in. */
function bucketKeyFor(jstYmd: string, granularity: Granularity): string {
  switch (granularity) {
    case 'day':
      return jstYmd;
    case 'month':
      return jstYmd.slice(0, 7);
    case 'year':
      return jstYmd.slice(0, 4);
    case 'week': {
      const d = new Date(`${jstYmd}T00:00:00Z`);
      const weekday = (d.getUTCDay() + 6) % 7; // Monday = 0, as MySQL's WEEKDAY()
      return new Date(d.getTime() - weekday * 86_400_000).toISOString().slice(0, 10);
    }
  }
}

/**
 * Every bucket key from `fromYmd` to `toYmd` (JST dates, inclusive), in order.
 * Walks day by day, which is at most a few thousand steps for any range the
 * route allows, and cannot get a month or ISO-week boundary wrong.
 */
export function bucketKeys(fromYmd: string, toYmd: string, granularity: Granularity): string[] {
  const keys: string[] = [];
  let t = Date.parse(`${fromYmd}T00:00:00Z`);
  const end = Date.parse(`${toYmd}T00:00:00Z`);
  while (t <= end) {
    const key = bucketKeyFor(new Date(t).toISOString().slice(0, 10), granularity);
    if (keys[keys.length - 1] !== key) keys.push(key);
    t += 86_400_000;
  }
  return keys;
}

/** The UTC instant a JST calendar date starts at. */
export function jstDayStartUtc(ymd: string): Date {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - JST_OFFSET_MS);
}

export interface StatsBucket {
  key: string;
  pageViews: number;
  visitors: number;
  signups: number;
  generations: { submitted: number; delivered: number; failed: number };
  paidOrders: { count: number; card: number; jpyc: number; usdc: number };
  revenueJpy: { total: number; card: number; jpyc: number; usdc: number };
  refundsJpy: number;
  creditsGranted: { total: number; purchased: number; subscription: number; trial: number; gift: number; compensation: number; other: number };
  creditsConsumed: number;
}

export type StatsTotals = Omit<StatsBucket, 'key'>;

function emptyBucket(key: string): StatsBucket {
  return {
    key,
    pageViews: 0,
    visitors: 0,
    signups: 0,
    generations: { submitted: 0, delivered: 0, failed: 0 },
    paidOrders: { count: 0, card: 0, jpyc: 0, usdc: 0 },
    revenueJpy: { total: 0, card: 0, jpyc: 0, usdc: 0 },
    refundsJpy: 0,
    creditsGranted: { total: 0, purchased: 0, subscription: 0, trial: 0, gift: 0, compensation: 0, other: 0 },
    creditsConsumed: 0,
  };
}

/*
 * How an order was paid: card, unless it went through the stablecoin channel.
 * For a stablecoin order, the token of the intent that confirmed it; failing
 * that (a payment settled through manual review has no confirmed intent), the
 * token of its latest quote, which is what the buyer was asked to send.
 */
const ORDER_METHOD_SQL = `
  CASE WHEN o.payment_method = 'stablecoin' THEN COALESCE(
    (SELECT q.token_key FROM stablecoin_intents i JOIN stablecoin_quotes q ON q.id = i.quote_id
      WHERE i.order_id = o.id AND i.state = 'confirmed' ORDER BY i.created_at DESC LIMIT 1),
    (SELECT q2.token_key FROM stablecoin_quotes q2 WHERE q2.order_id = o.id ORDER BY q2.created_at DESC LIMIT 1),
    'jpyc')
  ELSE 'card' END`;

const n = (v: unknown): number => Number(v ?? 0);

type Keyed = { k: string | null };

/**
 * One pass per source table, each grouped by the bucket key — or, with
 * `granularity` null, one row for the whole range (the totals).
 */
async function collect(fromUtc: Date, toUtc: Date, granularity: Granularity | null): Promise<Map<string, StatsBucket>> {
  const key = (col: string) => (granularity ? bucketSql(col, granularity) : `'all'`);
  const range = [fromUtc, toUtc];
  const out = new Map<string, StatsBucket>();
  const at = (k: string | null) => {
    const kk = k ?? 'all';
    let b = out.get(kk);
    if (!b) out.set(kk, (b = emptyBucket(kk)));
    return b;
  };

  const [visits, signups, jobs, orders, refunds, grants, consumed] = await Promise.all([
    query<Keyed & { views: number; visitors: number }>(
      `SELECT ${key('occurred_at')} AS k, COUNT(*) AS views, COUNT(DISTINCT user_ref) AS visitors
         FROM analytics_events
        WHERE name = 'page_view' AND is_internal = 0 AND occurred_at >= ? AND occurred_at < ?
        GROUP BY k`,
      range,
    ),
    query<Keyed & { c: number }>(
      `SELECT ${key('created_at')} AS k, COUNT(*) AS c FROM users
        WHERE created_at >= ? AND created_at < ? GROUP BY k`,
      range,
    ),
    query<Keyed & { submitted: number; delivered: number; failed: number }>(
      `SELECT ${key('created_at')} AS k, COUNT(*) AS submitted,
              SUM(state = 'DELIVERED') AS delivered,
              SUM(state IN ('FAILED','REJECTED')) AS failed
         FROM generation_jobs WHERE created_at >= ? AND created_at < ? GROUP BY k`,
      range,
    ),
    query<Keyed & { method: string; c: number; amount: number }>(
      `SELECT ${key('o.paid_at')} AS k, ${ORDER_METHOD_SQL} AS method, COUNT(*) AS c, SUM(o.amount_minor) AS amount
         FROM orders o
        WHERE o.paid_at >= ? AND o.paid_at < ? AND o.status IN ('paid','refunded','partially_refunded')
        GROUP BY k, method`,
      range,
    ),
    query<Keyed & { amount: number }>(
      `SELECT ${key('occurred_at')} AS k, SUM(amount_minor) AS amount FROM payments
        WHERE kind = 'refund' AND occurred_at >= ? AND occurred_at < ? GROUP BY k`,
      range,
    ),
    query<Keyed & { source: string; units: number }>(
      `SELECT ${key('le.created_at')} AS k, eb.source AS source, SUM(le.units) AS units
         FROM ledger_entries le JOIN entitlement_batches eb ON eb.id = le.batch_id
        WHERE le.entry_type = 'grant' AND le.created_at >= ? AND le.created_at < ?
        GROUP BY k, source`,
      range,
    ),
    query<Keyed & { units: number }>(
      `SELECT ${key('created_at')} AS k, SUM(units) AS units FROM ledger_entries
        WHERE entry_type = 'consume' AND created_at >= ? AND created_at < ? GROUP BY k`,
      range,
    ),
  ]);

  for (const r of visits) Object.assign(at(r.k), { pageViews: n(r.views), visitors: n(r.visitors) });
  for (const r of signups) at(r.k).signups = n(r.c);
  for (const r of jobs) at(r.k).generations = { submitted: n(r.submitted), delivered: n(r.delivered), failed: n(r.failed) };
  for (const r of orders) {
    const b = at(r.k);
    const m = r.method === 'usdc' ? 'usdc' : r.method === 'jpyc' ? 'jpyc' : 'card';
    b.paidOrders[m] += n(r.c);
    b.paidOrders.count += n(r.c);
    b.revenueJpy[m] += n(r.amount);
    b.revenueJpy.total += n(r.amount);
  }
  for (const r of refunds) at(r.k).refundsJpy = n(r.amount);
  for (const r of grants) {
    const b = at(r.k);
    const units = Math.abs(n(r.units));
    const slot =
      r.source === 'one_time_order'
        ? 'purchased'
        : r.source === 'subscription_period'
          ? 'subscription'
          : r.source === 'promo_trial'
            ? 'trial'
            : r.source === 'operator_gift'
              ? 'gift'
              : r.source === 'compensation'
                ? 'compensation'
                : 'other';
    b.creditsGranted[slot] += units;
    b.creditsGranted.total += units;
  }
  for (const r of consumed) at(r.k).creditsConsumed = Math.abs(n(r.units));
  return out;
}

export interface StatsReport {
  granularity: Granularity;
  from: string;
  to: string;
  buckets: StatsBucket[];
  totals: StatsTotals;
  /** The same span immediately before `from`, for the "vs previous period" figures. */
  previous: StatsTotals;
}

/**
 * The dashboard for JST dates `from`..`to` inclusive.
 *
 * The previous period is the same number of days ending the day before
 * `from`, so a week compares with the week before and a month-to-date with
 * the same number of days before it.
 */
export async function statsReport(params: { granularity: Granularity; from: string; to: string }): Promise<StatsReport> {
  const fromUtc = jstDayStartUtc(params.from);
  const toUtc = new Date(jstDayStartUtc(params.to).getTime() + 86_400_000);
  const spanMs = toUtc.getTime() - fromUtc.getTime();
  const prevFromUtc = new Date(fromUtc.getTime() - spanMs);

  const [series, totals, previous] = await Promise.all([
    collect(fromUtc, toUtc, params.granularity),
    collect(fromUtc, toUtc, null),
    collect(prevFromUtc, fromUtc, null),
  ]);
  const strip = (b: StatsBucket | undefined): StatsTotals => {
    const { key: _key, ...rest } = b ?? emptyBucket('all');
    return rest;
  };
  return {
    granularity: params.granularity,
    from: params.from,
    to: params.to,
    buckets: bucketKeys(params.from, params.to, params.granularity).map((k) => series.get(k) ?? emptyBucket(k)),
    totals: strip(totals.get('all')),
    previous: strip(previous.get('all')),
  };
}

/** Today in Japan, as `YYYY-MM-DD`. */
export function jstToday(nowMs: number = Date.now()): string {
  return jstDate(nowMs);
}
