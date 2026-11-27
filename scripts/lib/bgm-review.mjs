/**
 * Scoring for the BGM listening review (docs/quality/BGM_REVIEW.md).
 *
 * Pure functions over a review sheet (CSV, one row per reviewer per BGM) and,
 * for calibration, what the DGX measured on each BGM's render (quality.json
 * from `pnpm bench:bgm-sheet`). A BGM's verdict is its reviewers' majority;
 * a tie counts as "no", because "usable as is" and "no voice" are claims a
 * product makes and a split vote does not support them.
 */

export const CRITERIA = ['fitsBackground', 'fitsScenario', 'fitsGenre', 'fitsMood', 'soundQuality', 'cleanEdges'];
const COLUMNS = ['trackId', 'reviewer', ...CRITERIA, 'voiceHeard', 'usable', 'note'];

/** Minimal CSV: commas, double-quoted fields with "" escapes. */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function yesNo(v, field, n) {
  const s = String(v).toLowerCase();
  if (['yes', 'y', '1', 'true', '是', 'はい'].includes(s)) return true;
  if (['no', 'n', '0', 'false', '否', 'いいえ'].includes(s)) return false;
  throw new Error(`row ${n}: ${field} must be yes or no, not "${v}"`);
}

/** Rows of a review sheet. Refuses what it cannot read rather than guess a score. */
export function parseReviews(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = splitCsvLine(lines[0] ?? '');
  const at = Object.fromEntries(COLUMNS.map((c) => [c, head.indexOf(c)]));
  for (const c of COLUMNS) if (at[c] < 0 && c !== 'note') throw new Error(`the sheet has no ${c} column`);
  const rows = lines.slice(1).map((line, i) => {
    const f = splitCsvLine(line);
    const n = i + 2;
    const r = { trackId: f[at.trackId], reviewer: f[at.reviewer] };
    if (!r.trackId || !r.reviewer) throw new Error(`row ${n}: trackId and reviewer are required`);
    for (const c of CRITERIA) {
      const v = Number(f[at[c]]);
      if (!Number.isInteger(v) || v < 1 || v > 5) throw new Error(`row ${n}: ${c} must be 1–5, not "${f[at[c]]}"`);
      r[c] = v;
    }
    r.voiceHeard = yesNo(f[at.voiceHeard], 'voiceHeard', n);
    r.usable = yesNo(f[at.usable], 'usable', n);
    r.note = at.note >= 0 ? (f[at.note] ?? '') : '';
    return r;
  });
  if (!rows.length) throw new Error('the sheet has no reviews');
  return rows;
}

function byTrack(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.trackId, [...(m.get(r.trackId) ?? []), r]);
  return m;
}
const majority = (rs, k) => rs.filter((r) => r[k]).length * 2 > rs.length;

/** The review as a whole: per-criterion means, usable and voice rates, and usable by each choice. */
export function summarize(rows, meta = {}) {
  const tracks = byTrack(rows);
  const verdicts = [...tracks].map(([id, rs]) => ({ id, usable: majority(rs, 'usable'), voiceHeard: majority(rs, 'voiceHeard') }));
  const means = Object.fromEntries(CRITERIA.map((c) => [c, rows.reduce((a, r) => a + r[c], 0) / rows.length]));
  const by = {};
  for (const key of ['scenario', 'genre', 'mood', 'durationSeconds', 'tempo']) {
    by[key] = {};
    for (const v of verdicts) {
      const value = meta[v.id]?.[key];
      if (value === undefined || value === null) continue;
      const k = String(value);
      by[key][k] ??= { tracks: 0, usable: 0 };
      by[key][k].tracks += 1;
      by[key][k].usable += v.usable ? 1 : 0;
    }
  }
  return {
    tracks: verdicts.length,
    reviews: rows.length,
    usable: verdicts.filter((v) => v.usable).length / verdicts.length,
    voiceHeard: verdicts.filter((v) => v.voiceHeard).length / verdicts.length,
    means,
    by,
  };
}

/** For BGM reviewed by two or more people: how often their verdicts agree. */
export function agreement(rows) {
  const shared = [...byTrack(rows).values()].filter((rs) => new Set(rs.map((r) => r.reviewer)).size >= 2);
  if (!shared.length) return { tracks: 0, usable: null, voiceHeard: null };
  const same = (rs, k) => rs.every((r) => r[k] === rs[0][k]);
  return {
    tracks: shared.length,
    usable: shared.filter((rs) => same(rs, 'usable')).length / shared.length,
    voiceHeard: shared.filter((rs) => same(rs, 'voiceHeard')).length / shared.length,
  };
}

/**
 * BGM_VOICE_SECONDS_MAX against people: for each threshold, the DGX's "a voice
 * may be in it" (vocalSeconds > threshold) next to the reviewers' majority.
 * A BGM with no measurement (null) is left out, not counted as "no voice".
 */
export function calibrateVoice(rows, quality, thresholds = [0.5, 1, 1.5, 2, 3, 4, 6, 8]) {
  const heard = [...byTrack(rows)]
    .map(([id, rs]) => ({ id, voice: majority(rs, 'voiceHeard'), seconds: quality[id]?.vocalSeconds }))
    .filter((t) => typeof t.seconds === 'number');
  return thresholds.map((threshold) => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const t of heard) {
      const flagged = t.seconds > threshold;
      if (flagged && t.voice) tp += 1; else if (flagged) fp += 1; else if (t.voice) fn += 1; else tn += 1;
    }
    return {
      threshold, measured: heard.length, tp, fp, fn, tn,
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: tp + fn ? tp / (tp + fn) : null,
    };
  });
}
