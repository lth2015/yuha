#!/usr/bin/env node
/**
 * BGM listening review report (docs/quality/BGM_REVIEW.md).
 *
 *   node scripts/bgm-review.mjs [dir]      # default quality-probes/bgm-review (gitignored)
 *
 * dir holds what `pnpm bench:bgm-sheet` wrote (meta.json, quality.json) and
 * reviews/<reviewer>.csv, each a copy of sheet.csv filled in by one person.
 * Reads local files only.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRITERIA, agreement, calibrateVoice, parseReviews, summarize } from './lib/bgm-review.mjs';

const dir = process.argv[2] ?? 'quality-probes/bgm-review';
const reviewsDir = join(dir, 'reviews');
const files = existsSync(reviewsDir) ? readdirSync(reviewsDir).filter((f) => f.endsWith('.csv')).sort() : [];
// A report over nothing is not a passing report.
if (!files.length) {
  console.error(`no filled-in sheets in ${reviewsDir}`);
  process.exit(1);
}
const rows = files.flatMap((f) => {
  // Rows nobody filled in are left out: a sheet holds every BGM, a reviewer may hear some.
  const lines = readFileSync(join(reviewsDir, f), 'utf8').split(/\r?\n/);
  const filled = [lines[0], ...lines.slice(1).filter((l) => l.split(',').slice(8, 16).some((v) => v.trim()))];
  try {
    return parseReviews(filled.join('\n'));
  } catch (e) {
    throw new Error(`${f}: ${e.message}`);
  }
});
const read = (f) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : {});
const meta = read('meta.json');
const quality = read('quality.json');

const pct = (x) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(0)}%`);
const s = summarize(rows, meta);
const a = agreement(rows);
const out = [
  '# BGM listening review',
  '',
  `${s.tracks} BGM, ${s.reviews} reviews from ${new Set(rows.map((r) => r.reviewer)).size} people. A BGM's verdict is its reviewers' majority; a tie is "no".`,
  '',
  `- **Usable as is:** ${pct(s.usable)}`,
  `- **A voice heard:** ${pct(s.voiceHeard)}`,
  a.tracks ? `- **Reviewers agree** (${a.tracks} BGM heard by two or more): usable ${pct(a.usable)}, voice ${pct(a.voiceHeard)}` : '- Only one reviewer per BGM: no agreement measured.',
  '',
  '| criterion | mean (1–5) |',
  '| --- | --- |',
  ...CRITERIA.map((c) => `| ${c} | ${s.means[c].toFixed(2)} |`),
  '',
];
for (const [key, groups] of Object.entries(s.by)) {
  const entries = Object.entries(groups);
  if (!entries.length) continue;
  out.push(`| ${key} | BGM | usable |`, '| --- | --- | --- |');
  for (const [k, g] of entries.sort()) out.push(`| ${k} | ${g.tracks} | ${pct(g.usable / g.tracks)} |`);
  out.push('');
}
const cal = calibrateVoice(rows, quality);
if (cal[0]?.measured) {
  out.push(
    `**Voice threshold** (BGM_VOICE_SECONDS_MAX) against the reviewers, ${cal[0].measured} BGM the DGX measured:`,
    '',
    '| threshold (s) | flagged & heard | flagged, not heard | missed | precision | recall |',
    '| --- | --- | --- | --- | --- | --- |',
    ...cal.map((c) => `| ${c.threshold} | ${c.tp} | ${c.fp} | ${c.fn} | ${pct(c.precision)} | ${pct(c.recall)} |`),
    '',
    'A warning the owner sees should rarely be wrong: prefer the smallest threshold whose precision is high, then read the missed ones by ear.',
  );
} else {
  out.push('No BGM in the set has the DGX voice measurement yet (B2 needs the DGX updated): no threshold calibration.');
}
console.log(out.join('\n'));
