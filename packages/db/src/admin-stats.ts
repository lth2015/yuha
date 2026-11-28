import { query, queryOne } from './pool.js';

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
 *                         internal/demo traffic excluded — internal includes
 *                         every view from a browser that has ever signed in
 *                         as staff (staff_visitors) — and crawlers excluded.
 *                         Distinct visitors are distinct within the bucket;
 *                         the range total is distinct across the whole range,
 *                         not a sum.
 *   crawlerViews          page views from agents that announce themselves as
 *                         crawlers or headless browsers, counted apart.
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
  crawlerViews: number;
  signups: number;
  generations: { submitted: number; delivered: number; failed: number };
  paidOrders: { count: number; card: number; jpyc: number; usdc: number; netx: number };
  revenueJpy: { total: number; card: number; jpyc: number; usdc: number; netx: number };
  refundsJpy: number;
  creditsGranted: { total: number; purchased: number; subscription: number; trial: number; gift: number; compensation: number; other: number };
  creditsConsumed: number;
}

export type StatsTotals = Omit<StatsBucket, 'key'>;

function emptyBucket(key: string): StatsBucket {
  return {
    key,
    pageViews: 0,
    crawlerViews: 0,
    visitors: 0,
    signups: 0,
    generations: { submitted: 0, delivered: 0, failed: 0 },
    paidOrders: { count: 0, card: 0, jpyc: 0, usdc: 0, netx: 0 },
    revenueJpy: { total: 0, card: 0, jpyc: 0, usdc: 0, netx: 0 },
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
/**
 * The method a row's SQL answer stands for. Every currency by name: this was a
 * two-way test with `card` as the else, so the first token added after it —
 * NETX — would have been counted, silently, as card revenue.
 */
export type ConsolePaymentMethod = 'card' | 'jpyc' | 'usdc' | 'netx';
const CONSOLE_METHODS: readonly ConsolePaymentMethod[] = ['card', 'jpyc', 'usdc', 'netx'];
export function paymentMethodOf(raw: string): ConsolePaymentMethod {
  if ((CONSOLE_METHODS as readonly string[]).includes(raw)) return raw as ConsolePaymentMethod;
  // A token key this list does not know yet is still not a card payment.
  throw new Error(`unknown payment method "${raw}" — add it to CONSOLE_METHODS`);
}

const ORDER_METHOD_SQL = `
  CASE WHEN o.payment_method = 'stablecoin' THEN COALESCE(
    (SELECT q.token_key FROM stablecoin_intents i JOIN stablecoin_quotes q ON q.id = i.quote_id
      WHERE i.order_id = o.id AND i.state = 'confirmed' ORDER BY i.created_at DESC LIMIT 1),
    (SELECT q2.token_key FROM stablecoin_quotes q2 WHERE q2.order_id = o.id ORDER BY q2.created_at DESC LIMIT 1),
    'jpyc')
  ELSE 'card' END`;

const n = (v: unknown): number => Number(v ?? 0);

/** A page view by a person: the route marks crawlers with `crawler: true` and nothing else. */
const PEOPLE = `JSON_EXTRACT(props, '$.crawler') IS NULL`;

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

  const [visits, crawlers, signups, jobs, orders, refunds, grants, consumed] = await Promise.all([
    query<Keyed & { views: number; visitors: number }>(
      `SELECT ${key('occurred_at')} AS k, COUNT(*) AS views, COUNT(DISTINCT user_ref) AS visitors
         FROM analytics_events
        WHERE name = 'page_view' AND is_internal = 0 AND ${PEOPLE} AND occurred_at >= ? AND occurred_at < ?
        GROUP BY k`,
      range,
    ),
    query<Keyed & { views: number }>(
      `SELECT ${key('occurred_at')} AS k, COUNT(*) AS views
         FROM analytics_events
        WHERE name = 'page_view' AND is_internal = 0 AND NOT ${PEOPLE} AND occurred_at >= ? AND occurred_at < ?
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
  for (const r of crawlers) at(r.k).crawlerViews = n(r.views);
  for (const r of signups) at(r.k).signups = n(r.c);
  for (const r of jobs) at(r.k).generations = { submitted: n(r.submitted), delivered: n(r.delivered), failed: n(r.failed) };
  for (const r of orders) {
    const b = at(r.k);
    const m = paymentMethodOf(r.method);
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
  sources: VisitSources;
  /** Songs without an account in the range (docs/GROWTH_SPEC.md, part three). */
  trials: TrialStats;
  /** Videos made in the range (song page, 「做一段视频」): from the cover, or with photos. */
  videos: { cover: number; photo: number };
  /** The three numbers watched this phase (product owner, 2026-11-28). */
  phase: PhaseStats;
}

/**
 * Staff are not the audience: their songs are tests, their timelines are
 * corrected on purpose. Guests (trials) are, so they count.
 */
const NOT_STAFF = `u.role NOT IN ('admin','support')`;

export interface PhaseStats {
  /**
   * People whose first song attempt falls in the range. `completed`: a song
   * was delivered within 24 hours of that first attempt, a retry included.
   * `pending`: not yet, and the 24 hours are not up — neither a success nor
   * a failure, so a rate leaves them out.
   */
  firstSong: { started: number; completed: number; pending: number };
  /**
   * Sung songs delivered in the range, by the timeline they carry now:
   * `automatic` is used as the aligner made it; `corrected` needed a person;
   * `unsynced` has no aligned timeline at all (estimated, failed, or none).
   */
  lyrics: { sung: number; automatic: number; corrected: number; unsynced: number };
  /**
   * Video exports, cover and photo apart. A `busy` refusal asked the person
   * to try again in a moment; it is not a failed video, nor a made one.
   */
  videos: {
    made: { cover: number; photo: number }; failed: { cover: number; photo: number }; busy: number;
    /**
     * A finished video taken away: downloaded, the share sheet opened with it,
     * the share sheet completed. Not "posted": a browser is not told that.
     */
    taken: { download: number; shareOpened: number; shared: number };
  };
}

async function phaseStats(fromUtc: Date, toUtc: Date): Promise<PhaseStats> {
  const [first, lyrics, videos] = await Promise.all([
    queryOne<{ started: number; completed: number; pending: number }>(
      `SELECT COUNT(*) AS started,
              COALESCE(SUM(f.done), 0) AS completed,
              COALESCE(SUM(NOT f.done AND f.first_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)), 0) AS pending
         FROM (SELECT g.user_id, g.first_at,
                      EXISTS (SELECT 1 FROM generation_jobs d
                               WHERE d.user_id = g.user_id AND d.state = 'DELIVERED'
                                 AND d.delivered_at <= DATE_ADD(g.first_at, INTERVAL 24 HOUR)) AS done
                 FROM (SELECT j.user_id, MIN(j.created_at) AS first_at
                         FROM generation_jobs j JOIN users u ON u.id = j.user_id
                        WHERE ${NOT_STAFF}
                        GROUP BY j.user_id) g
                WHERE g.first_at >= ? AND g.first_at < ?) f`,
      [fromUtc, toUtc],
    ),
    queryOne<{ sung: number; automatic: number; corrected: number }>(
      `SELECT COUNT(*) AS sung,
              COALESCE(SUM(x.src = 'aligned'), 0) AS automatic,
              COALESCE(SUM(x.src = 'corrected'), 0) AS corrected
         FROM (SELECT JSON_UNQUOTE(JSON_EXTRACT(t.lyric_timings, '$.source')) AS src
                 FROM tracks t JOIN users u ON u.id = t.owner_id
                WHERE t.created_at >= ? AND t.created_at < ? AND t.deleted_at IS NULL
                  AND t.lyrics IS NOT NULL AND TRIM(t.lyrics) <> '' AND ${NOT_STAFF}) x`,
      [fromUtc, toUtc],
    ),
    query<{ name: string; kind: string | null; reason: string | null; how: string | null; n: number }>(
      `SELECT e.name, JSON_UNQUOTE(JSON_EXTRACT(e.props, '$.kind')) AS kind,
              JSON_UNQUOTE(JSON_EXTRACT(e.props, '$.reason')) AS reason,
              JSON_UNQUOTE(JSON_EXTRACT(e.props, '$.how')) AS how, COUNT(*) AS n
         FROM analytics_events e JOIN users u ON u.id = e.user_ref
        WHERE e.name IN ('video_made', 'video_failed', 'video_taken') AND e.occurred_at >= ? AND e.occurred_at < ? AND ${NOT_STAFF}
        GROUP BY e.name, kind, reason, how`,
      [fromUtc, toUtc],
    ),
  ]);
  const n = (v: unknown) => Number(v ?? 0);
  const count = (name: string, kind: string, busy: boolean) =>
    videos.filter((r) => r.name === name && r.kind === kind && (r.reason === 'busy') === busy).reduce((s, r) => s + n(r.n), 0);
  const took = (how: string) => videos.filter((r) => r.name === 'video_taken' && r.how === how).reduce((s, r) => s + n(r.n), 0);
  const sung = n(lyrics?.sung);
  const automatic = n(lyrics?.automatic);
  const corrected = n(lyrics?.corrected);
  return {
    firstSong: { started: n(first?.started), completed: n(first?.completed), pending: n(first?.pending) },
    lyrics: { sung, automatic, corrected, unsynced: sung - automatic - corrected },
    videos: {
      made: { cover: count('video_made', 'cover', false), photo: count('video_made', 'photo', false) },
      failed: { cover: count('video_failed', 'cover', false), photo: count('video_failed', 'photo', false) },
      busy: videos.filter((r) => r.name === 'video_failed' && r.reason === 'busy').reduce((s, r) => s + n(r.n), 0),
      taken: {
        download: took('download'),
        shareOpened: took('share_opened'),
        shared: took('shared'),
      },
    },
  };
}

export interface TrialStats {
  /** Trials opened: the door let somebody in. */
  opened: number;
  /** Of those, how many made their song. */
  made: number;
  /** Of those, how many signed up and kept it. */
  claimed: number;
}

async function trialStats(fromUtc: Date, toUtc: Date): Promise<TrialStats> {
  const row = await queryOne<{ opened: number; made: number; claimed: number }>(
    `SELECT COUNT(*) AS opened,
            COALESCE(SUM(EXISTS (SELECT 1 FROM entitlement_batches b WHERE b.user_id = g.user_id AND b.consumed_units > 0)), 0) AS made,
            COALESCE(SUM(g.claimed_by IS NOT NULL), 0) AS claimed
       FROM guest_trials g
      WHERE g.created_at >= ? AND g.created_at < ?`,
    [fromUtc, toUtc],
  );
  return { opened: Number(row?.opened ?? 0), made: Number(row?.made ?? 0), claimed: Number(row?.claimed ?? 0) };
}

async function videoStats(fromUtc: Date, toUtc: Date): Promise<{ cover: number; photo: number }> {
  const rows = await query<{ kind: string | null; n: number }>(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(props, '$.kind')) AS kind, COUNT(*) AS n
       FROM analytics_events
      WHERE name = 'video_made' AND occurred_at >= ? AND occurred_at < ?
      GROUP BY kind`,
    [fromUtc, toUtc],
  );
  const of = (k: string) => Number(rows.find((r) => r.kind === k)?.n ?? 0);
  return { cover: of('cover'), photo: of('photo') };
}

/**
 * Where the outside visits in a range came from and what they opened —
 * people only, staff and crawlers excluded, the same rows as pageViews.
 */
export interface VisitSources {
  /** Distinct visitors, and how many of them arrived from another site. */
  arrivals: { visitors: number; fromOtherSites: number };
  /**
   * Visitors by the first other site they came from in the range; `host: null`
   * is no other site (typed in, a bookmark, an app that sends no referrer).
   * A visitor counts once: the pages they open next carry no referrer and do
   * not make them direct.
   */
  referrers: { host: string | null; visitors: number }[];
  /** Pages, ids folded into `:id` as the route stores them, most viewed first. */
  paths: { path: string; views: number; visitors: number }[];
  /**
   * Each campaign tag (`?src=`, docs/ATTRIBUTION_SPEC.md) followed through:
   * people who visited with it in the range; accounts made in the range that
   * arrived with it; and of those accounts, how many have a delivered song,
   * how many have paid, and what they paid (to date, refunds not deducted —
   * the same rule as revenue above). Trials started with it in the range
   * (docs/ITERATION_EN_JA_MV.md) are counted apart from sign-ups, and so are
   * the accounts that made a video.
   */
  campaigns: {
    source: string;
    visitors: number;
    trials: number;
    signups: number;
    madeASong: number;
    madeAVideo: number;
    paid: number;
    revenueJpy: number;
  }[];
}

const SOURCE_ROWS = 15;
/** Orders that took money, refunded later or not: the dashboard's revenue rule. */
const PAID_STATUSES = `('paid','refunded','partially_refunded')`;

async function visitSources(fromUtc: Date, toUtc: Date): Promise<VisitSources> {
  const where = `name = 'page_view' AND is_internal = 0 AND ${PEOPLE} AND occurred_at >= ? AND occurred_at < ?`;
  const [referrers, paths, campaignVisits, campaignSignups, campaignTrials] = await Promise.all([
    query<{ host: string | null; visitors: number }>(
      `SELECT host, COUNT(*) AS visitors FROM (
         SELECT user_ref,
                (SELECT JSON_UNQUOTE(JSON_EXTRACT(e2.props, '$.ref_host'))
                   FROM analytics_events e2
                  WHERE e2.user_ref = e.user_ref AND e2.name = 'page_view' AND e2.occurred_at >= ? AND e2.occurred_at < ?
                    AND JSON_EXTRACT(e2.props, '$.ref_host') IS NOT NULL
                  ORDER BY e2.occurred_at ASC LIMIT 1) AS host
           FROM analytics_events e
          WHERE ${where}
          GROUP BY user_ref
       ) v
       GROUP BY host
       ORDER BY visitors DESC, host IS NOT NULL, host ASC`,
      [fromUtc, toUtc, fromUtc, toUtc],
    ),
    query<{ path: string; views: number; visitors: number }>(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(props, '$.path')) AS path, COUNT(*) AS views, COUNT(DISTINCT user_ref) AS visitors
         FROM analytics_events
        WHERE ${where}
        GROUP BY path
        ORDER BY views DESC, path ASC
        LIMIT ${SOURCE_ROWS}`,
      [fromUtc, toUtc],
    ),
    query<{ source: string; visitors: number }>(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(props, '$.source')) AS source, COUNT(DISTINCT user_ref) AS visitors
         FROM analytics_events
        WHERE ${where} AND JSON_EXTRACT(props, '$.source') IS NOT NULL
        GROUP BY source`,
      [fromUtc, toUtc],
    ),
    query<{ source: string; signups: number; made: number; video: number; paid: number; revenue: number }>(
      `SELECT u.acquisition_source AS source, COUNT(*) AS signups,
              SUM(EXISTS (SELECT 1 FROM generation_jobs j WHERE j.user_id = u.id AND j.state = 'DELIVERED')) AS made,
              SUM(EXISTS (SELECT 1 FROM analytics_events e WHERE e.name = 'video_made' AND e.user_ref = u.id)) AS video,
              SUM(EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status IN ${PAID_STATUSES})) AS paid,
              COALESCE(SUM((SELECT SUM(o.amount_minor) FROM orders o WHERE o.user_id = u.id AND o.status IN ${PAID_STATUSES})), 0) AS revenue
         FROM users u
        WHERE u.acquisition_source IS NOT NULL AND u.role <> 'guest' AND u.created_at >= ? AND u.created_at < ?
        GROUP BY u.acquisition_source`,
      [fromUtc, toUtc],
    ),
    // A trial is a guest row; its source is the one the visitor arrived with.
    query<{ source: string; trials: number }>(
      `SELECT u.acquisition_source AS source, COUNT(*) AS trials
         FROM users u JOIN guest_trials g ON g.user_id = u.id
        WHERE u.acquisition_source IS NOT NULL AND g.created_at >= ? AND g.created_at < ?
        GROUP BY u.acquisition_source`,
      [fromUtc, toUtc],
    ),
  ]);
  const campaigns = new Map<string, VisitSources['campaigns'][number]>();
  const row = (source: string) => {
    let r = campaigns.get(source);
    if (!r) campaigns.set(source, (r = { source, visitors: 0, trials: 0, signups: 0, madeASong: 0, madeAVideo: 0, paid: 0, revenueJpy: 0 }));
    return r;
  };
  for (const v of campaignVisits) row(v.source).visitors = n(v.visitors);
  for (const s of campaignSignups) {
    Object.assign(row(s.source), { signups: n(s.signups), madeASong: n(s.made), madeAVideo: n(s.video), paid: n(s.paid), revenueJpy: n(s.revenue) });
  }
  for (const t of campaignTrials) row(t.source).trials = n(t.trials);
  const all = referrers.map((r) => ({ host: r.host, visitors: n(r.visitors) }));
  return {
    arrivals: {
      visitors: all.reduce((sum, r) => sum + r.visitors, 0),
      fromOtherSites: all.filter((r) => r.host !== null).reduce((sum, r) => sum + r.visitors, 0),
    },
    referrers: all.slice(0, SOURCE_ROWS),
    paths: paths.map((r) => ({ path: r.path, views: n(r.views), visitors: n(r.visitors) })),
    campaigns: [...campaigns.values()].sort((a, b) => b.visitors - a.visitors || b.signups - a.signups || a.source.localeCompare(b.source)),
  };
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

  const [series, totals, previous, sources, trials, videos, phase] = await Promise.all([
    collect(fromUtc, toUtc, params.granularity),
    collect(fromUtc, toUtc, null),
    collect(prevFromUtc, fromUtc, null),
    visitSources(fromUtc, toUtc),
    trialStats(fromUtc, toUtc),
    videoStats(fromUtc, toUtc),
    phaseStats(fromUtc, toUtc),
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
    sources,
    trials,
    videos,
    phase,
  };
}

/** Today in Japan, as `YYYY-MM-DD`. */
export function jstToday(nowMs: number = Date.now()): string {
  return jstDate(nowMs);
}
