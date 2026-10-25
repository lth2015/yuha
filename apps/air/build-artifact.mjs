/**
 * One self-contained page from `vite build`, for publishing as a hosted
 * artifact (an HTTPS link a phone can open with nothing running locally).
 *
 * The host wraps the file in its own document skeleton, so this emits the
 * title, the inlined stylesheet, the mount point and the inlined module, and
 * no <html>/<head>/<body>.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(import.meta.dirname, 'dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const asset = (re, what) => {
  const m = re.exec(html);
  if (!m) throw new Error(`build-artifact: no ${what} in dist/index.html — run vite build first`);
  return readFileSync(join(dist, m[1]), 'utf8');
};
const js = asset(/<script[^>]+src="\.\/([^"]+\.js)"/, 'script');
const css = asset(/<link[^>]+href="\.\/([^"]+\.css)"/, 'stylesheet');
// An inline script ends at the first "</script", wherever it appears.
const safeJs = js.replace(/<\/script/gi, '<\\/script');

const out = process.argv[2] ?? join(dist, 'artifact.html');
writeFileSync(
  out,
  `<title>YUHA 第一声测试</title>\n<meta name="robots" content="noindex">\n<style>\n${css}\n</style>\n<main id="app"></main>\n<script type="module">\n${safeJs}\n</script>\n`,
);
console.log(`wrote ${out} (${(js.length + css.length) / 1000 | 0} kB inlined)`);
