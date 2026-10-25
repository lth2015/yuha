/**
 * Renders listening recordings offline: `node scripts/render-air.mjs <outDir> [seed...]`.
 * Starts the Vite dev server, opens render.html in Chromium, writes one WAV per
 * seed (30 s, the length of a performance) and reports each one's peak level.
 * AIR_PRESETS=all renders every preset for each seed (files named by preset).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const [outDir = 'recordings', ...seedArgs] = process.argv.slice(2);
const seeds = seedArgs.length ? seedArgs.map(Number) : [1, 2, 3];
mkdirSync(outDir, { recursive: true });
const server = await createServer({ root: join(import.meta.dirname, '..'), server: { port: 5182, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:5182/render.html');
  await page.waitForFunction(() => 'render' in window);
  for (const seed of seeds) {
    const presets = process.env.AIR_PRESETS === 'all' ? await page.evaluate(() => window.presetIds) : [null];
    for (const [index, id] of presets.entries()) {
      const b64 = await page.evaluate(([s, i]) => window.render(s, 30, i), [seed, id === null ? 0 : index]);
      const peak = await page.evaluate(() => window.lastPeak);
      const stats = await page.evaluate(() => window.lastStats);
      const file = join(outDir, id === null ? `air-seed-${seed}.wav` : `air-${id}-seed-${seed}.wav`);
      writeFileSync(file, Buffer.from(b64, 'base64'));
      console.log(`${file}  peak ${peak.toFixed(3)}${peak >= 1 ? '  CLIPPED' : ''}  ${JSON.stringify(stats)}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
