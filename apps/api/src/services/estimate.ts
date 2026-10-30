import { recentGenerationTimings, type GenerationTiming } from '@yuha/db';

/**
 * How long a song will take, from songs that actually finished
 * (docs/GENERATION_QUEUE_SPEC.md).
 *
 * The figure this replaces was a constant: "30–120 s" for a two-minute song,
 * the same for the first in line and the fifth, and "taking longer than
 * usual" at 180 s for every length — which on one GPU is every four-minute
 * song. Everything here is the middle half (25th–75th percentile) of what
 * the provider really took over the last seven days, so the range is as
 * wide as the provider is uneven and no wider.
 */
export type Timing = GenerationTiming;

/** Below this many finished songs a percentile is a guess; say "default" instead. */
const MIN_SAMPLES = 5;
/** A running song is "taking longer" only this far past its own upper bound. */
const LATE_FACTOR = 1.5;
const WINDOW_DAYS = 7;
const CACHE_MS = 60_000;

export interface Estimate {
  minSeconds: number;
  maxSeconds: number;
  delayed: boolean;
  basis: 'measured' | 'default';
  samples: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

const middleHalf = (xs: number[]): [number, number] => {
  const sorted = [...xs].sort((a, b) => a - b);
  return [percentile(sorted, 0.25), percentile(sorted, 0.75)];
};

/** The old constant, kept for when nothing has finished yet. */
function defaultRange(durationSeconds: number): [number, number] {
  const scale = Math.min(durationSeconds / 120, 2);
  return [30 * scale, 120 * scale];
}

/**
 * The estimate for one job. `ahead` is how many jobs are in front of it on
 * the same provider (running or waiting); `runningSeconds` is how long it has
 * been with the provider, or null while it waits.
 */
export function estimateFromTimings(params: {
  timings: readonly Timing[];
  durationSeconds: number;
  ahead: number;
  concurrency: number;
  runningSeconds: number | null;
}): Estimate {
  const { timings, durationSeconds } = params;
  const measured = timings.length >= MIN_SAMPLES;

  // This song's own time: songs of the same length if there are enough of
  // them, otherwise every song scaled by seconds of generation per second of
  // music, which is how the model's cost grows.
  const sameLength = timings.filter((t) => t.durationSeconds === durationSeconds);
  const own: [number, number] = !measured
    ? defaultRange(durationSeconds)
    : sameLength.length >= MIN_SAMPLES
      ? middleHalf(sameLength.map((t) => t.genSeconds))
      : (middleHalf(timings.map((t) => t.genSeconds / Math.max(t.durationSeconds, 1))).map((r) => r * durationSeconds) as [number, number]);
  // A song ahead of it is of unknown length: a typical one.
  const typical: [number, number] = measured ? middleHalf(timings.map((t) => t.genSeconds)) : defaultRange(120);

  if (params.runningSeconds !== null) {
    const ran = params.runningSeconds;
    return {
      minSeconds: Math.max(0, Math.round(own[0] - ran)),
      maxSeconds: Math.max(0, Math.round(own[1] - ran)),
      delayed: ran > own[1] * LATE_FACTOR,
      basis: measured ? 'measured' : 'default',
      samples: timings.length,
    };
  }
  // Jobs ahead run `concurrency` at a time: two ahead with two slots is one
  // wave of waiting, not two.
  const waves = Math.floor(Math.max(0, params.ahead) / Math.max(1, params.concurrency));
  return {
    minSeconds: Math.round(waves * typical[0] + own[0]),
    maxSeconds: Math.round(waves * typical[1] + own[1]),
    delayed: false,
    basis: measured ? 'measured' : 'default',
    samples: timings.length,
  };
}

let cache: { providerId: string; at: number; timings: Timing[] } | null = null;

/**
 * The provider's recent timings, read at most once a minute per process: a
 * page polling every two seconds must not rescan the jobs table each time.
 */
export async function providerTimings(providerId: string): Promise<Timing[]> {
  if (cache && cache.providerId === providerId && Date.now() - cache.at < CACHE_MS) return cache.timings;
  const timings = await recentGenerationTimings(providerId, WINDOW_DAYS);
  cache = { providerId, at: Date.now(), timings };
  return timings;
}

/** Tests write history and then read; a cached minute would hide it. */
export function resetTimingCache(): void {
  cache = null;
}

export function percentiles(xs: readonly number[]): { p50: number; p90: number } {
  const sorted = [...xs].sort((a, b) => a - b);
  return { p50: Math.round(percentile(sorted, 0.5)), p90: Math.round(percentile(sorted, 0.9)) };
}
