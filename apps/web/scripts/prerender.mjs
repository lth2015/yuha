// Writes the public pages as HTML into dist/ (src/prerender.tsx). Runs after
// `vite build` and `vite build --ssr src/prerender.tsx --outDir dist-ssr`;
// dist-ssr is the renderer, not something to publish.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const { prerenderPages } = await import(join(web, 'dist-ssr', 'prerender.js'));
const origin = process.env['SITE_ORIGIN'] ?? 'https://yuha.studio';
const template = readFileSync(join(web, 'dist', 'index.html'), 'utf8');

const pages = await prerenderPages(template, origin);
if (pages.length === 0) throw new Error('prerender: no pages written');
for (const { file, html } of pages) {
  const out = join(web, 'dist', file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
}
rmSync(join(web, 'dist-ssr'), { recursive: true, force: true });
console.log(`prerender: ${pages.length} pages → dist/{zh,ja,en}/`);
