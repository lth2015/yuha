/**
 * One self-contained page per entry, for publishing as a hosted artifact (an
 * HTTPS link a phone can open with nothing running locally).
 *
 *   node build-artifact.mjs probe dist/artifact.html   # #27 first-sound probe
 *   node build-artifact.mjs index dist/play.html       # the instrument
 *
 * Each page is built alone so nothing is split into a shared chunk, then its
 * script and stylesheet are inlined. The host wraps the file in its own
 * document skeleton, so this emits the title, styles, body and module only.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'vite';

const [page = 'probe', out = join(import.meta.dirname, 'dist', page === 'probe' ? 'artifact.html' : page === 'index' ? 'play.html' : `${page}.html`)] = process.argv.slice(2);
const root = import.meta.dirname;
const outDir = mkdtempSync(join(tmpdir(), 'yuha-air-'));
try {
  process.env['AIR_PAGE'] = page;
  // Where a shared link should point (the artifact's own link); see vite.config.ts.
  if (page === 'index' && !process.env['AIR_SHARE_BASE']) {
    console.warn('build-artifact: AIR_SHARE_BASE is not set; shared links will point at the frame, not the artifact');
  }
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir, emptyOutDir: true, sourcemap: false } });
  const html = readFileSync(join(outDir, `${page}.html`), 'utf8');
  const assets = readdirSync(join(outDir, 'assets'));
  const read = (ext) => {
    const files = assets.filter((f) => f.endsWith(ext));
    if (files.length !== 1) throw new Error(`build-artifact: expected one ${ext} for ${page}, found ${files.length}`);
    return readFileSync(join(outDir, 'assets', files[0]), 'utf8');
  };
  const js = read('.js').replace(/<\/script/gi, '<\\/script'); // an inline script ends at the first "</script"
  const css = read('.css');
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? 'YUHA';
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/.exec(html);
  // An empty body would publish a page with no mount point and fail only at runtime.
  if (!bodyMatch) throw new Error(`build-artifact: no <body> in ${page}.html`);
  const body = bodyMatch[1].replace(/<script[^>]*><\/script>/g, '').trim();
  mkdirSync(dirname(out), { recursive: true }); // dist/ need not exist: vite built into a temp dir
  writeFileSync(out, `<title>${title}</title>\n<meta name="robots" content="noindex">\n<style>\n${css}\n</style>\n${body}\n<script type="module">\n${js}\n</script>\n`);
  console.log(`wrote ${out} (${((js.length + css.length) / 1000) | 0} kB inlined)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
