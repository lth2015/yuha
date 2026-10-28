/**
 * Draws apps/web/public/brand/og-card.png — the picture every YUHA link shows
 * when it is not a song's own (docs/GIFT_AND_SHARE_SPEC.md) — with the same
 * renderer the song cards use (apps/web/src/lib/share-art.ts), so the site's
 * card and a song's card are recognisably one product.
 *
 *   pnpm dev   # in another terminal; the renderer runs in the page
 *   node scripts/make-og-card.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = process.env.WEB_URL ?? 'http://localhost:5173';
const OUT = new URL('../apps/web/public/brand/og-card.png', import.meta.url);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const png = await page.evaluate(async () => {
  const { shareCardPng } = await import('/src/lib/share-art.ts');
  return shareCardPng(
    { title: '让心动，有回声。', coverSeed: 20261028, styles: ['warm'], dedication: null },
    { detail: '写下一段心情，做成属于这一刻的音乐。', site: 'yuha.studio' },
  );
});
await browser.close();
writeFileSync(OUT, Buffer.from(png, 'base64'));
console.log(`wrote ${OUT.pathname}`);
