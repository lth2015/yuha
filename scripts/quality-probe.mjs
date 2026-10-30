#!/usr/bin/env node
/**
 * Generates the fixed probe songs on a running YUHA and checks what the API
 * states about each (docs/quality/PROBE_RUNBOOK.md).
 *
 *   YUHA_TOKEN=… node scripts/quality-probe.mjs            # dry run: what would be made, and the cost
 *   YUHA_TOKEN=… node scripts/quality-probe.mjs --spend    # make them (one credit each)
 *   … --only ja-numbers  … --base http://localhost:5173
 *
 * YUHA_TOKEN is the session token of the account that pays — in the browser,
 * localStorage['loopscene.token'] on the site. It is read from the
 * environment only and never printed.
 *
 * Spending needs `--spend`: a probe is a real song on real credits. The
 * idempotency key is the probe id, the day and `--attempt` (default 1), so a
 * rerun the same day returns the same jobs instead of paying again; to try
 * again after a failure, pass `--attempt 2` and pay for a new one.
 *
 * The report (quality-probes/<date>.md, gitignored) lists the automatic
 * checks and, per song, the listening checklist a person fills in. It
 * names job and track ids only, so it can be pasted into a PR.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { checkProbe } from './lib/probe-checks.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = (value('--base') ?? process.env['YUHA_BASE'] ?? 'https://yuha.studio').replace(/\/$/, '');
const TOKEN = process.env['YUHA_TOKEN'];
const SPEND = flag('--spend');
const only = value('--only');
const attempt = Number(value('--attempt') ?? 1);

const set = JSON.parse(readFileSync(new URL('../docs/quality/probe-set.json', import.meta.url), 'utf8'));
const probes = set.probes.filter((p) => !only || p.id === only);
if (probes.length === 0) {
  console.error(only ? `no probe named ${only}` : 'the probe set is empty');
  process.exit(1);
}
if (!TOKEN) {
  console.error('YUHA_TOKEN is not set (the paying account’s session token)');
  process.exit(1);
}

const day = new Date().toISOString().slice(0, 10);
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body?.error ?? body).slice(0, 200)}`);
  return body;
};

const runtime = await api('/v1/runtime');
const ent = await api('/v1/entitlements');
console.log(`${BASE} · ${runtime.mode} · music ${runtime.adapters?.music} · ${ent.availableUnits} credits available`);
console.log(`${probes.length} probe(s) × 1 credit, ${set.durationSeconds}s each: ${probes.map((p) => p.id).join(', ')}`);
if (!SPEND) {
  console.log('\ndry run — nothing was made. Add --spend to generate them.');
  process.exit(0);
}
if (ent.availableUnits < probes.length) {
  console.error(`needs ${probes.length} credits, the account has ${ent.availableUnits}`);
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
// One at a time: an account may have two generations open at once, and
// one GPU makes them one at a time anyway.
for (const p of probes) {
  const started = Date.now();
  process.stdout.write(`${p.id} … `);
  let job = await api('/v1/generations', {
    method: 'POST',
    headers: { 'idempotency-key': `probe-${day}-${p.id}-${attempt}` },
    body: JSON.stringify({
      mode: 'custom',
      title: p.title,
      prompt: `quality probe ${p.id}`,
      lyrics: p.lyrics,
      styles: p.styles,
      voice: p.voice,
      instrumental: false,
      durationSeconds: set.durationSeconds,
      visibility: 'private',
    }),
  });
  while (!['done', 'failed'].includes(job.phase) && Date.now() - started < 30 * 60_000) {
    await wait(10_000);
    job = await api(`/v1/jobs/${job.jobId}`);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  if (job.phase !== 'done' || !job.trackId) {
    console.log(`not delivered (${job.phase}, ${job.failure ?? job.errorCode ?? 'timeout'}) after ${seconds}s`);
    results.push({ probe: p, job, track: null, checks: [{ check: 'delivered', ok: false, detail: `${job.phase} ${job.errorCode ?? ''}` }], seconds });
    continue;
  }
  const track = await api(`/v1/tracks/${job.trackId}`);
  const checks = checkProbe(p, set.durationSeconds, track);
  console.log(`${checks.every((c) => c.ok) ? 'ok' : 'FAILED ' + checks.filter((c) => !c.ok).map((c) => c.check).join(', ')} (${seconds}s)`);
  results.push({ probe: p, job, track, checks, seconds });
}

const lines = [
  `# Quality probe ${day}`,
  '',
  `${BASE} · ${runtime.mode} · music ${runtime.adapters?.music} · build: see Console › Ops`,
  '',
  '## Automatic checks',
  '',
  '| probe | job | track | took | length | aligned | every line timed | inside the song | in order |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...results.map((r) => {
    const by = Object.fromEntries(r.checks.map((c) => [c.check, `${c.ok ? '✓' : '✗'} ${c.detail}`]));
    return `| ${r.probe.id} | ${r.job.jobId} | ${r.track?.trackId ?? '—'} | ${r.seconds}s | ${by['length'] ?? by['delivered'] ?? '—'} | ${by['aligned'] ?? '—'} | ${by['every line timed'] ?? '—'} | ${by['timeline inside the song'] ?? '—'} | ${by['lines in order'] ?? '—'} |`;
  }),
  '',
  '## Listening (fill in)',
  '',
  'For each song, open it, play it through once with the lyrics showing, and mark each box.',
  '',
  ...results.flatMap((r) => [
    `### ${r.probe.id} — ${r.probe.tests}`,
    '',
    r.track ? `${BASE}/song/${r.track.trackId}` : '(not delivered)',
    '',
    '- [ ] every line is sung (no missing or swapped words)',
    '- [ ] the voice is there and is the one asked for (' + r.probe.voice + ')',
    '- [ ] no noise, clipping or dropouts',
    '- [ ] the ending is not cut off',
    '- [ ] the highlighted line follows the singing (note where it drifts: mm:ss)',
    '',
  ]),
];
mkdirSync('quality-probes', { recursive: true });
const file = `quality-probes/${day}.md`;
writeFileSync(file, lines.join('\n'));
console.log(`\nreport: ${file}`);
if (results.some((r) => r.checks.some((c) => !c.ok))) process.exitCode = 1;
