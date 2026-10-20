import { parseDecimalRate, type RateObservation } from '../chain/quote.js';

/**
 * Two independent readings of USD/JPY, for quoting USDC.
 *
 * USDC is priced as one US dollar — a product decision (2026-10-20), not a
 * claim about redemption — so what a USDC quote needs is the dollar's price in
 * yen, read from two places that do not share a feed:
 *
 *   primary    Coinbase's public exchange-rate table, intraday. This is the
 *              number a quote is computed from.
 *   reference  Frankfurter's blended central-bank reference rate, daily. Never
 *              priced from; it exists so a primary that has frozen, broken or
 *              been tampered with is caught by disagreeing with it.
 *
 * Both response shapes were read from the live endpoints on 2026-10-20, not
 * assumed: Coinbase answers `{ data: { currency: 'USD', rates: { JPY: '158.0465' } } }`
 * with the rate as a STRING and no timestamp; Frankfurter answers
 * `{ date: '2026-10-20', base: 'USD', quote: 'JPY', rate: 158.16 }` with the
 * rate as a JSON NUMBER and only a calendar date.
 *
 * Neither needs a key. Both hosts must be reachable from the API pods; a
 * deployment that blocks them gets "USDC unavailable", never a guessed price.
 */

const COINBASE_USD_RATES_URL = 'https://api.coinbase.com/v2/exchange-rates?currency=USD';
const FRANKFURTER_USD_JPY_URL = 'https://api.frankfurter.dev/v2/rate/usd/jpy';

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

/** Primary. The rate arrives as a decimal string and is kept exactly as given. */
export async function readCoinbaseUsdJpy(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  opts: { timeoutMs?: number; nowMs?: () => number } = {},
): Promise<RateObservation> {
  const body = (await getJson(fetchImpl, COINBASE_USD_RATES_URL, opts.timeoutMs ?? 3000)) as {
    data?: { currency?: unknown; rates?: Record<string, unknown> };
  };
  // A table for some other base currency would parse perfectly and be wrong.
  if (body?.data?.currency !== 'USD') throw new Error('coinbase: response is not a USD rate table');
  const jpy = body.data.rates?.['JPY'];
  if (typeof jpy !== 'string') throw new Error('coinbase: no JPY rate in the table');
  return { rate: parseDecimalRate(jpy), provider: 'coinbase-usd-jpy', observedAtMs: (opts.nowMs ?? Date.now)() };
}

/**
 * Reference. The rate is a JSON number, so its text is re-derived; anything
 * that does not come back as a plain decimal is refused by `parseDecimalRate`
 * rather than interpreted. `sourceTimestampMs` is the start of the published
 * date in UTC, which is what the staleness check reads for this source.
 */
export async function readFrankfurterUsdJpy(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  opts: { timeoutMs?: number; nowMs?: () => number } = {},
): Promise<RateObservation> {
  const body = (await getJson(fetchImpl, FRANKFURTER_USD_JPY_URL, opts.timeoutMs ?? 3000)) as {
    date?: unknown;
    base?: unknown;
    quote?: unknown;
    rate?: unknown;
  };
  if (body?.base !== 'USD' || body?.quote !== 'JPY') throw new Error('frankfurter: response is not USD/JPY');
  if (typeof body.rate !== 'number' || !Number.isFinite(body.rate)) throw new Error('frankfurter: no numeric rate');
  if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    throw new Error('frankfurter: no publication date');
  }
  const sourceTimestampMs = Date.parse(`${body.date}T00:00:00Z`);
  if (!Number.isFinite(sourceTimestampMs)) throw new Error('frankfurter: unreadable publication date');
  return {
    rate: parseDecimalRate(String(body.rate)),
    provider: 'frankfurter-usd-jpy',
    observedAtMs: (opts.nowMs ?? Date.now)(),
    sourceTimestampMs,
  };
}
