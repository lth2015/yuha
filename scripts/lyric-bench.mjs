#!/usr/bin/env node
/**
 * Lyric sync benchmark report (docs/quality/LYRIC_BENCH.md).
 *
 *   node scripts/lyric-bench.mjs [dir] [--base <route>] [--tolerance 0.3] [--confident 0.5]
 *
 * dir (default quality-probes/lyric-bench, gitignored) holds:
 *   annotations/<annotator>/<songId>.json   what a person heard, one file per song
 *   routes/<route>/<songId>.json            a lyricTimings per song, per route
 *
 * The first annotator alphabetically is the reference; a second one gives the
 * noise floor. Every route is compared with --base (default: the first route).
 * Reads local files only; calls nothing and spends nothing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { annotatorFloor, compareRoutes, scoreSong, summarize } from './lib/lyric-bench.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dir = args[0] && !args[0].startsWith('--') ? args[0] : 'quality-probes/lyric-bench';
const opts = {
  tolerance: Number(flag('--tolerance') ?? 0.3),
  confident: Number(flag('--confident') ?? 0.5),
  seed: 1,
};

const subdirs = (p) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);
const jsonFiles = (p) =>
  readdirSync(p)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ id: f.slice(0, -5), body: JSON.parse(readFileSync(join(p, f), 'utf8')) }));

const annotators = subdirs(join(dir, 'annotations'));
const routes = subdirs(join(dir, 'routes'));
// A report over nothing is not a passing report.
if (!annotators.length || !routes.length) {
  console.error(`need annotations/<annotator>/ and routes/<route>/ under ${dir}`);
  process.exit(1);
}
const reference = jsonFiles(join(dir, 'annotations', annotators[0])).map((f) => ({ ...f.body, songId: f.body.songId ?? f.id }));
if (!reference.length) {
  console.error(`annotator ${annotators[0]} has no songs`);
  process.exit(1);
}

const pct = (x) => (x === null ? '–' : `${(x * 100).toFixed(1)}%`);
const sec = (x) => (x === null ? '–' : `${x.toFixed(2)} s`);
const ci = ([lo, hi]) => (lo === null ? '' : ` (${pct(lo)}–${pct(hi)})`);

const out = [`# Lyric sync benchmark`, '', `${reference.length} songs, reference annotator \`${annotators[0]}\`, tolerance ±${opts.tolerance}s, unconfirmed below ${opts.confident}.`, ''];

if (annotators.length > 1) {
  const second = jsonFiles(join(dir, 'annotations', annotators[1])).map((f) => ({ ...f.body, songId: f.body.songId ?? f.id }));
  const f = annotatorFloor(reference, second);
  out.push(`**Noise floor** (\`${annotators[0]}\` vs \`${annotators[1]}\`, ${f.lines} lines): median ${sec(f.median)}, P90 ${sec(f.p90)}, sung/unsung disagreements ${f.sungDisagreements}.`);
  if (f.p90 !== null && f.p90 > opts.tolerance) out.push(`> The tolerance is below the annotators' own P90: this measures the people, not the aligner.`);
  out.push('');
}

const rowsByRoute = {};
for (const route of routes) {
  const preds = new Map(jsonFiles(join(dir, 'routes', route)).map((f) => [f.id, f.body]));
  const rows = [];
  const missing = [];
  for (const a of reference) {
    const p = preds.get(a.songId);
    if (!p) missing.push(a.songId);
    else rows.push(...scoreSong(a, p, opts));
  }
  if (missing.length) {
    // A route that skipped songs would be scored on its easy ones.
    console.error(`route ${route} has no prediction for: ${missing.join(', ')}`);
    process.exit(1);
  }
  rowsByRoute[route] = rows;
}

out.push('| route | language | songs | usable with no edits | lines hit (95% CI) | unconfirmed | falsely lit | median / P90 error |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const route of routes) {
  const s = summarize(rowsByRoute[route], opts);
  for (const [lang, g] of [['all', s.all], ...Object.entries(s.byLanguage)]) {
    out.push(`| ${route} | ${lang} | ${g.songs} | ${g.usableSongs} (${pct(g.usableRate)}) | ${pct(g.hitRate)}${ci(g.hitRateCi)} | ${pct(g.unconfirmedRate)} | ${pct(g.falseHighlightRate)} | ${sec(g.medianError)} / ${sec(g.p90Error)} |`);
  }
}

const base = flag('--base') ?? routes[0];
if (!rowsByRoute[base]) {
  console.error(`no route named ${base}`);
  process.exit(1);
}
const others = routes.filter((r) => r !== base);
if (others.length) {
  out.push('', `**Against \`${base}\`** (paired by line, interval clustered by song):`, '');
  for (const r of others) {
    const c = compareRoutes(rowsByRoute[base], rowsByRoute[r], opts);
    out.push(`- \`${r}\`: ${c.verdict}, hit rate ${c.hitRateDiff >= 0 ? '+' : ''}${pct(c.hitRateDiff)}${ci(c.ci)}, falsely lit ${c.falseHighlights.a} → ${c.falseHighlights.b}`);
  }
}

console.log(out.join('\n'));
