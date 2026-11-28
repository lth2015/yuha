/**
 * Can this deployment write where the API writes? Run inside an API pod, so it
 * acts under the pod's own AWS role (Deploy QA does this after the rollout):
 *
 *   kubectl exec deployment/yuha-api -- node api/dist/check-storage.js <tag>
 *   pnpm --filter @yuha/api check:storage        # locally, against .env
 *
 * Writes, reads back and deletes one small object under each prefix in
 * API_STORAGE_WRITES, and exits 1 naming each prefix and step that was
 * refused. It cannot tell you why a policy refuses; the error it prints is
 * AWS's own, which is what an SRE needs.
 */
import { closeDb } from '@yuha/db';
import { ConfigError, loadConfig } from './config.js';
import { createContext } from './context.js';
import { probeStorage } from './services/storage-probe.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const ctx = createContext(config);
const tag = (process.argv[2] ?? String(Date.now())).replace(/[^A-Za-z0-9-]/g, '');
const results = await probeStorage(ctx.storage, tag || 'manual');
console.log(`storage: ${ctx.storage.kind}, delivery zone, API pod identity`);
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.prefix}  (${r.feature}): write, read, delete`);
  else console.error(`✗ ${r.prefix}  (${r.feature}): ${r.step} refused — ${r.error}${r.step === 'delete' ? `\n  left behind: ${r.key}` : ''}`);
}
await closeDb().catch(() => undefined);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} storage prefixes are not usable by the API; the features named above will fail in production.`);
  process.exit(1);
}
process.exit(0);
