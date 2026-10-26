/**
 * The instrument, built to be served at yuha.studio/air/ beside the web app.
 *
 *   AIR_SHARE_BASE=https://yuha.studio/air node build-web.mjs [outDir]
 *
 * Default outDir is ../web/dist/air, so the artifact build publishes it with
 * the web app in one `s3 sync`. Run it after `vite build` of apps/web, which
 * empties dist/. The base is absolute: `/air` (no slash) is a different
 * directory from `/air/` to a browser, and relative asset URLs would resolve
 * against the wrong one. The web app forwards both to /air/index.html
 * (apps/web/src/lib/air-redirect.ts).
 *
 * Only index.html is built: probe.html and render.html are development pages.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';

const root = import.meta.dirname;
const outDir = resolve(process.argv[2] ?? join(root, '..', 'web', 'dist', 'air'));
const BASE = '/air/';

process.env['AIR_PAGE'] = 'index';
await build({ root, configFile: join(root, 'vite.config.ts'), base: BASE, logLevel: 'warn', build: { outDir, emptyOutDir: true } });

// Each of these has broken a deploy somewhere before: say so here, not in production.
const html = readFileSync(join(outDir, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
const wrong = refs.filter((u) => !u.startsWith(`${BASE}assets/`));
if (refs.length === 0 || wrong.length) throw new Error(`build-web: asset URLs must start with ${BASE}assets/: ${wrong.join(', ') || 'none found'}`);
for (const u of refs) if (!existsSync(join(outDir, u.slice(BASE.length)))) throw new Error(`build-web: ${u} is referenced but was not built`);
const extra = readdirSync(outDir).filter((f) => f.endsWith('.html') && f !== 'index.html');
if (extra.length) throw new Error(`build-web: development pages in the output: ${extra.join(', ')}`);
console.log(`wrote ${outDir}/index.html (${refs.length} assets under ${BASE}assets/)`);
