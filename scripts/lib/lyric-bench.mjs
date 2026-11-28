/**
 * Scoring for the lyric sync benchmark (docs/quality/LYRIC_BENCH.md).
 *
 * Pure functions over two kinds of JSON:
 *   annotation — what a person heard: {songId, language, lines:[{idx, sung, start}]}
 *                `start` is the second the line is first sung, null when not sung.
 *   prediction — a stored lyricTimings: {source, lines:[{start, end, confidence?}]}
 *
 * The unit is the line, and lines are compared by index: a timeline that does
 * not carry the song's lines (timingsMatchLyrics) is not a prediction of it.
 * Intervals are bootstrapped by song (clustered), because lines of one song
 * share a tempo, a mix and an aligner run and are not independent.
 */

import { LINE_CONFIDENT, trustedMask } from '@yuha/contracts';

/** Tolerance on a line's start, seconds. Not below the annotators' own P90 disagreement. */
export const DEFAULT_TOLERANCE = 0.3;
/** Keep the default used in the actual player. */
export const DEFAULT_CONFIDENT = LINE_CONFIDENT;

/**
 * One row per line.
 *   hit            sung line, confirmed, start within tolerance (null for an unsung line)
 *   unconfirmed    the strict player would leave this line unlit
 *   falseHighlight unsung line that the prediction would light up as sung
 *   error          |predicted − heard| start for a sung line, seconds
 */
export function scoreSong(annotation, prediction, opts = {}) {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const confident = opts.confident ?? DEFAULT_CONFIDENT;
  const lines = annotation.lines;
  if (!prediction || !Array.isArray(prediction.lines) || prediction.lines.length !== lines.length) {
    throw new Error(
      `${annotation.songId}: line count differs (annotation ${lines.length}, prediction ${prediction?.lines?.length ?? 'none'})`,
    );
  }
  const visible = trustedMask(prediction, { minConfidence: confident });
  return lines.map((truth, i) => {
    const p = prediction.lines[i];
    const unconfirmed = !visible[i];
    const base = { songId: annotation.songId, language: annotation.language, idx: i, sung: truth.sung, unconfirmed };
    if (!truth.sung) {
      return { ...base, hit: null, error: null, falseHighlight: !unconfirmed };
    }
    const error = Math.abs(p.start - truth.start);
    return { ...base, hit: !unconfirmed && error <= tol, error, falseHighlight: false };
  });
}

/** Deterministic PRNG, so a report can be regenerated exactly. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bySong(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.songId)) m.set(r.songId, []);
    m.get(r.songId).push(r);
  }
  return [...m.values()];
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile: a value that was actually observed. */
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1];
}

/** 95% interval of `stat(songs)` over songs resampled with replacement. */
function bootstrap(songs, stat, { seed = 1, draws = 2000 } = {}) {
  if (!songs.length) return [null, null];
  const rand = rng(seed);
  const out = [];
  for (let d = 0; d < draws; d += 1) {
    const pick = [];
    for (let i = 0; i < songs.length; i += 1) pick.push(songs[Math.floor(rand() * songs.length)]);
    const v = stat(pick);
    if (v !== null && Number.isFinite(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  if (!out.length) return [null, null];
  return [out[Math.floor(0.025 * (out.length - 1))], out[Math.ceil(0.975 * (out.length - 1))]];
}

const ratio = (n, d) => (d ? n / d : null);
const hitRateOf = (songs) => {
  const sung = songs.flat().filter((r) => r.sung);
  return ratio(sung.filter((r) => r.hit).length, sung.length);
};
/** Every sung line hit and no unsung line lit: listenable with no one touching it. */
const usable = (song) => song.every((r) => (r.sung ? r.hit : !r.falseHighlight));

function group(rows, opts) {
  const songs = bySong(rows);
  const sung = rows.filter((r) => r.sung);
  const unsung = rows.filter((r) => !r.sung);
  const errors = sung.map((r) => r.error);
  return {
    songs: songs.length,
    lines: rows.length,
    sungLines: sung.length,
    hitRate: hitRateOf(songs),
    hitRateCi: bootstrap(songs, hitRateOf, opts),
    unconfirmedRate: ratio(sung.filter((r) => r.unconfirmed).length, sung.length),
    falseHighlightRate: ratio(unsung.filter((r) => r.falseHighlight).length, unsung.length),
    medianError: median(errors),
    p90Error: percentile(errors, 0.9),
    usableSongs: songs.filter(usable).length,
    usableRate: ratio(songs.filter(usable).length, songs.length),
  };
}

export function summarize(rows, opts = {}) {
  const byLanguage = {};
  for (const lang of [...new Set(rows.map((r) => r.language))].sort()) {
    byLanguage[lang] = group(rows.filter((r) => r.language === lang), opts);
  }
  return { all: group(rows, opts), byLanguage };
}

/**
 * How far apart two people put the same line: the floor under any tolerance.
 * `lines` is how many both heard sung; lines one heard sung and the other did
 * not are counted separately (`sungDisagreements`), not averaged in.
 */
export function annotatorFloor(first, second) {
  const other = new Map(second.map((a) => [a.songId, a]));
  const diffs = [];
  let sungDisagreements = 0;
  for (const a of first) {
    const b = other.get(a.songId);
    if (!b) continue;
    a.lines.forEach((l, i) => {
      const m = b.lines[i];
      if (!m) return;
      if (l.sung !== m.sung) sungDisagreements += 1;
      else if (l.sung) diffs.push(Math.abs(l.start - m.start));
    });
  }
  return { lines: diffs.length, median: median(diffs), p90: percentile(diffs, 0.9), sungDisagreements };
}

/**
 * Route B against route A on the same lines. `better`/`worse` only when the
 * song-clustered 95% interval of the paired hit-rate difference excludes 0;
 * and any increase in falsely lit unsung lines rejects B outright, because a
 * caption lit while nobody sings is the error people notice most.
 */
export function compareRoutes(a, b, opts = {}) {
  const key = (r) => `${r.songId}#${r.idx}`;
  const bRows = new Map(b.map((r) => [key(r), r]));
  const paired = a
    .filter((r) => bRows.has(key(r)))
    .map((r) => ({ songId: r.songId, sung: r.sung, a: r, b: bRows.get(key(r)) }));
  const diffOf = (songs) => {
    const sung = songs.flat().filter((p) => p.sung);
    return ratio(sung.reduce((s, p) => s + (Number(p.b.hit) - Number(p.a.hit)), 0), sung.length);
  };
  const songs = bySong(paired);
  const hitRateDiff = diffOf(songs);
  const ci = bootstrap(songs, diffOf, opts);
  const unsung = paired.filter((p) => !p.sung);
  const fhA = unsung.filter((p) => p.a.falseHighlight).length;
  const fhB = unsung.filter((p) => p.b.falseHighlight).length;
  let verdict = 'no_difference';
  if (fhB > fhA) verdict = 'rejected_false_highlight';
  else if (ci[0] !== null && ci[0] > 0) verdict = 'better';
  else if (ci[1] !== null && ci[1] < 0) verdict = 'worse';
  return { pairedLines: paired.length, hitRateDiff, ci, falseHighlights: { a: fhA, b: fhB }, verdict };
}
