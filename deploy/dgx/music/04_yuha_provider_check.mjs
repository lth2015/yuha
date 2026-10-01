#!/usr/bin/env node
// Run on your Mac after 03_wire_yuha.sh. Uses YUHA's OWN adapter code
// (HttpMusicProvider + fetchAudio from music/packages/providers/dist) with the values in
// music/.env, so it exercises exactly what the worker will do — minus the DB.
//   node 04_yuha_provider_check.mjs
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const music = path.resolve(here, '../../..'); // repo root
process.loadEnvFile(path.join(music, '.env'));
const e = process.env;
const { HttpMusicProvider, fetchAudio } = await import(path.join(music, 'packages/providers/dist/index.js'));

const provider = new HttpMusicProvider({
  providerId: e.MUSIC_PROVIDER_ID, baseUrl: e.MUSIC_BASE_URL, apiKey: e.MUSIC_API_KEY, model: e.MUSIC_MODEL,
  contractVersion: e.MUSIC_CONTRACT_VERSION, licenseVersion: e.MUSIC_LICENSE_VERSION,
  territory: 'JP', allowedUses: [], prohibitedUses: [],
  submitPath: e.MUSIC_SUBMIT_PATH, pollPath: e.MUSIC_POLL_PATH,
  requestIdField: e.MUSIC_REQUEST_ID_FIELD, statusField: e.MUSIC_STATUS_FIELD, audioUrlField: e.MUSIC_AUDIO_URL_FIELD,
  statusMap: JSON.parse(e.MUSIC_STATUS_MAP), idempotencyHeader: e.MUSIC_IDEMPOTENCY_HEADER || undefined,
  supportsInstrumentalOnly: e.MUSIC_SUPPORTS_INSTRUMENTAL === 'true', supportsVocals: true,
  supportsCancel: false, supportsWebhook: false, supportsStatusQuery: true,
  supportedDurationsSeconds: [30, 60, 120, 180, 240], supportedFormats: ['mp3'],
  commercialDeliveryPermitted: false, maxConcurrency: Number(e.MUSIC_MAX_CONCURRENCY ?? 1),
  dataRegion: e.MUSIC_DATA_REGION ?? 'unconfirmed', costPerRequestMinor: 0,
  billFailedRequests: true, costIsEstimate: true,
  allowedAudioHosts: e.MUSIC_ALLOWED_AUDIO_HOSTS.split(',').map((h) => h.trim()).filter(Boolean),
});
const fetchOpts = (insecure) => ({
  allowedHosts: provider.allowedAudioHosts(), maxBytes: provider.maxAudioBytes(),
  timeoutMs: Number(e.MUSIC_TIMEOUT_MS ?? 60000), allowInsecureSelfHosted: insecure,
});

const base = {
  brief: 'warm indie pop, gentle female vocal, acoustic guitar, light drums, hopeful evening mood',
  tempoHint: 'medium', energy: 0.5, instruments: ['acoustic_guitar', 'soft_drums'], styles: ['pop', 'indie'],
};
const cases = [
  { name: '30s instrumental', intent: { ...base, durationSeconds: 30, vocalMode: 'instrumental', lyrics: null } },
  { name: '60s with vocals', intent: { ...base, durationSeconds: 60, vocalMode: 'with_vocals',
      lyrics: '[verse]\nCity lights are fading slow\nI keep the window open\n[chorus]\nStay a little longer here\nLet the night be quiet\n' } },
];

const results = [];
let lastUrl = null;
mkdirSync(path.join(here, 'data'), { recursive: true });
for (const c of cases) {
  const requestKey = randomUUID();
  const t0 = Date.now();
  const sub = await provider.submit({ intent: c.intent, requestKey, format: 'mp3' });
  const submitMs = Date.now() - t0;
  if (sub.status !== 'submitted' && sub.status !== 'completed') {
    results.push({ case: c.name, ok: false, detail: `submit → ${sub.status} ${sub.code ?? ''} ${sub.message ?? ''}` });
    continue;
  }
  let poll, states = [];
  for (;;) {
    poll = await provider.poll({ requestKey, providerRequestId: sub.providerRequestId });
    if (states.at(-1) !== poll.status) states.push(poll.status);
    if (poll.status !== 'pending') break;
    if (Date.now() - t0 > 15 * 60_000) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  // the worker's UNKNOWN-recovery path polls by requestKey alone
  const byKey = await provider.poll({ requestKey, providerRequestId: null });
  if (poll.status !== 'completed') {
    results.push({ case: c.name, ok: false, detail: `poll → ${states.join('→')} ${poll.code ?? ''} ${poll.message ?? ''}` });
    continue;
  }
  lastUrl = poll.audio.url;
  const buf = await fetchAudio(poll.audio.url, fetchOpts(e.MUSIC_ALLOW_INSECURE_SELF_HOSTED === 'true'));
  const file = path.join(here, 'data', `yuha_${c.intent.durationSeconds}s_${c.intent.vocalMode}.mp3`);
  writeFileSync(file, buf);
  results.push({ case: c.name, ok: buf.length > 10_000 && byKey.status === 'completed',
    detail: `submit ${submitMs}ms, ${states.join('→')}, total ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
            `${(buf.length / 1e6).toFixed(2)}MB, poll-by-requestKey=${byKey.status} → ${path.relative(process.cwd(), file)}` });
}

// The SSRF guard must still refuse the same URL when the self-hosted switch is off.
if (lastUrl) {
  try { await fetchAudio(lastUrl, fetchOpts(false)); results.push({ case: 'guard with switch off', ok: false, detail: 'fetched — guard did NOT refuse' }); }
  catch (err) { results.push({ case: 'guard with switch off', ok: true, detail: `refused: ${err.reason ?? ''} ${err.message}` }); }
  // …and a host nobody allow-listed is refused even with the switch on.
  try { await fetchAudio(lastUrl.replace(/\/\/[^/:]+/, '//169.254.169.254'), fetchOpts(true)); results.push({ case: 'unlisted host, switch on', ok: false, detail: 'fetched' }); }
  catch (err) { results.push({ case: 'unlisted host, switch on', ok: true, detail: `refused: ${err.reason ?? ''} ${err.message}` }); }
}

console.log('\n=========== YUHA adapter check (paste this back) ===========');
for (const r of results) console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.case}: ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
