#!/usr/bin/env node
/**
 * The same descriptions, through each lyric model that has a key here, side
 * by side (docs/LYRICS_MODEL.md).
 *
 *   node scripts/lyric-compare.mjs                 # every brief, every model with a key
 *   node scripts/lyric-compare.mjs --only ja-summer
 *
 * Models: TokenStars when TOKENSTARS_API_KEY and TOKENSTARS_MODEL_ID are set;
 * Claude when YUHA_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY is set
 * (ANTHROPIC_TEXT_MODEL, ANTHROPIC_EFFORT optional). The YUHA_ name is for a
 * Claude Code environment, where a plain ANTHROPIC_API_KEY would also be
 * picked up by Claude Code itself. Keys are read from the environment and never printed. Each call
 * is a real, paid call: one per brief per model.
 *
 * The report (quality-probes/lyrics-<date>.md, gitignored) has the automatic
 * checks in one table and every lyric in full for a person to read. Lyrics
 * written by a model from these fixed briefs contain nothing about anyone.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AnthropicTextProvider, TokenStarsTextProvider } from '../packages/providers/dist/index.js';
import { checkLyrics } from './lib/lyric-checks.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const secondsPerLine = Number(process.env['LYRIC_SECONDS_PER_LINE'] ?? 4.5);

const set = JSON.parse(readFileSync(new URL('../docs/quality/lyric-briefs.json', import.meta.url), 'utf8'));
const briefs = set.briefs.filter((b) => !only || b.id === only);
if (!briefs.length) {
  console.error(only ? `no brief named ${only}` : 'the brief set is empty');
  process.exit(1);
}

const models = [];
if (process.env['TOKENSTARS_API_KEY'] && process.env['TOKENSTARS_MODEL_ID']) {
  models.push(
    new TokenStarsTextProvider({
      apiKey: process.env['TOKENSTARS_API_KEY'],
      model: process.env['TOKENSTARS_MODEL_ID'],
      ...(process.env['TOKENSTARS_BASE_URL'] ? { baseUrl: process.env['TOKENSTARS_BASE_URL'] } : {}),
      ...(process.env['TOKENSTARS_CHAT_PATH'] ? { chatPath: process.env['TOKENSTARS_CHAT_PATH'] } : {}),
      timeoutMs: 60_000,
      lyricSecondsPerLine: secondsPerLine,
    }),
  );
}
const anthropicKey = process.env['YUHA_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'];
if (anthropicKey) {
  models.push(
    new AnthropicTextProvider({
      apiKey: anthropicKey,
      ...(process.env['ANTHROPIC_TEXT_MODEL'] ? { model: process.env['ANTHROPIC_TEXT_MODEL'] } : {}),
      ...(process.env['ANTHROPIC_EFFORT'] ? { effort: process.env['ANTHROPIC_EFFORT'] } : {}),
      lyricSecondsPerLine: secondsPerLine,
    }),
  );
}
if (!models.length) {
  console.error('no lyric model has a key here: set TOKENSTARS_API_KEY + TOKENSTARS_MODEL_ID and/or YUHA_ANTHROPIC_API_KEY');
  process.exit(1);
}
console.log(`${briefs.length} brief(s) × ${models.map((m) => `${m.providerId}/${m.model}`).join(', ')}`);

const results = [];
for (const brief of briefs) {
  for (const m of models) {
    const started = Date.now();
    process.stdout.write(`${brief.id} · ${m.providerId} … `);
    const res = await m.writeLyrics({ prompt: brief.prompt, styles: brief.styles, durationSeconds: brief.durationSeconds });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const checks = res.status === 'ok' ? checkLyrics(brief, res.lyrics, secondsPerLine) : [];
    const failed = checks.filter((c) => !c.ok).map((c) => c.check);
    console.log(res.status === 'ok' ? `${failed.length ? 'checks failed: ' + failed.join(', ') : 'ok'} (${seconds}s, ¥${res.usage.costMinor})` : `${res.status}: ${res.reason}`);
    results.push({ brief, model: `${m.providerId}/${m.model}`, res, checks, seconds });
  }
}

const day = new Date().toISOString().slice(0, 10);
const checkNames = [...new Set(results.flatMap((r) => r.checks.map((c) => c.check)))];
const lines = [
  `# Lyric models compared ${day}`,
  '',
  `${models.map((m) => `${m.providerId}/${m.model}`).join(' vs ')} · ${briefs.length} briefs · one line per ${secondsPerLine}s`,
  '',
  '## Automatic checks',
  '',
  `| brief | model | status | time | cost | ${checkNames.join(' | ')} |`,
  `| --- | --- | --- | --- | --- | ${checkNames.map(() => '---').join(' | ')} |`,
  ...results.map((r) => {
    const by = Object.fromEntries(r.checks.map((c) => [c.check, `${c.ok ? '✓' : '✗'} ${c.detail}`.replace(/\|/g, '/')]));
    return `| ${r.brief.id} | ${r.model} | ${r.res.status} | ${r.seconds}s | ¥${r.res.usage.costMinor} | ${checkNames.map((n) => by[n] ?? '—').join(' | ')} |`;
  }),
  '',
  '## The lyrics',
  '',
  'Read each pair as a listener: does it say the feeling in the description, with its concrete details?',
  'Would you sing the chorus back? Does any line trip the tongue?',
  '',
  ...briefs.flatMap((brief) => [
    `### ${brief.id} — ${brief.durationSeconds}s, ${brief.styles.join(', ')}`,
    '',
    `> ${brief.prompt}`,
    '',
    ...results
      .filter((r) => r.brief.id === brief.id)
      .flatMap((r) => [`**${r.model}**`, '', '```', r.res.status === 'ok' ? r.res.lyrics : `(${r.res.status}: ${r.res.reason})`, '```', '']),
  ]),
];
mkdirSync('quality-probes', { recursive: true });
const file = `quality-probes/lyrics-${day}.md`;
writeFileSync(file, lines.join('\n'));
writeFileSync(file.replace(/\.md$/, '.json'), JSON.stringify(results.map((r) => ({ brief: r.brief.id, model: r.model, status: r.res.status, seconds: Number(r.seconds), costMinor: r.res.usage.costMinor, checks: r.checks, lyrics: r.res.status === 'ok' ? r.res.lyrics : null })), null, 2));
console.log(`\nreport: ${file}`);
