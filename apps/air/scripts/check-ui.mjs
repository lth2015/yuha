/**
 * `pnpm --filter @yuha/air check:ui` — the instrument measured, not eyeballed (#34).
 *
 * In zh, ja and en, at 320/360/393/768/1280 px, opens every screen a person can
 * reach — playing, the end panel, the parameter card, a friend's shared link,
 * a broken link — and fails if any control or line of text lies outside the
 * screen or overflows its own box. The root `pnpm check:ui` drives apps/web
 * and does not see this app, which is why this exists.
 *
 * On the same run it checks two promises the page makes:
 * - it can be played with the keyboard alone (Space down, arrows move);
 * - it collects nothing: no request leaves the page, and no cookie,
 *   localStorage, sessionStorage or IndexedDB entry exists afterwards.
 */
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const LOCALES = { zh: 'zh-CN', ja: 'ja-JP', en: 'en-US' };
const WIDTHS = [320, 360, 393, 768, 1280];
const PORT = 5187;
const base = `http://localhost:${PORT}/`;

const failures = [];
let passed = 0;
const check = (ok, what) => (ok ? (passed += 1) : failures.push(what));

/** Visible elements of the open panels that leave the screen or overflow their own box. */
const layoutProblems = () =>
  [...document.querySelectorAll('#hint, #ring, #ring *, #ended, #ended *, #shared, #shared *, #card, #card *, #toast')]
    .filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden]'))
    .flatMap((e) => {
      const r = e.getBoundingClientRect();
      const name = e.id || `${e.tagName.toLowerCase()}.${e.className}`;
      const out = [];
      if (r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5 || r.bottom > innerHeight + 0.5) out.push(`${name} off screen`);
      if (e.matches('button, a, p, dd, dt, h2') && e.scrollWidth > e.clientWidth + 1) out.push(`${name} text overflows`);
      return out;
    });

async function everyWidth(page, lang, screen) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(30);
    const problems = await page.evaluate(layoutProblems);
    check(problems.length === 0, `${lang} ${width}px ${screen}: ${problems.join(', ')}`);
  }
  await page.setViewportSize({ width: 393, height: 852 });
}

/** A six-second performance with the mouse, then 「完成」. */
async function perform(page) {
  const start = Date.now();
  await page.mouse.move(200, 300);
  await page.mouse.down();
  for (let i = 0; i < 100; i += 1) {
    await page.mouse.move(120 + 150 * Math.abs(Math.sin(i / 7)), 300 - 60 * Math.sin(i / 5));
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  while (Date.now() - start < 6000) await page.waitForTimeout(100);
  await page.click('#done');
}

const server = await createServer({ root: join(import.meta.dirname, '..'), server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch();
try {
  for (const [lang, locale] of Object.entries(LOCALES)) {
    const context = await browser.newContext({ locale, viewport: { width: 393, height: 852 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const outside = [];
    context.on('request', (r) => {
      if (!r.url().startsWith(base) && !r.url().startsWith('blob:')) outside.push(r.url());
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__notes = 0;
      const start = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (...a) {
        window.__notes += 1;
        return start.apply(this, a);
      };
    });
    await page.goto(base);

    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    check(htmlLang.startsWith(lang), `${lang}: <html lang> is ${htmlLang}`);
    check(((await page.getAttribute('#stage', 'aria-label')) ?? '').length > 20, `${lang}: the stage has no spoken description`);
    await everyWidth(page, lang, 'ready');

    // The keyboard alone can play.
    await page.focus('#stage');
    await page.keyboard.down(' ');
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press(i < 6 ? 'ArrowUp' : 'ArrowRight');
      await page.waitForTimeout(60);
    }
    check(await page.locator('#ring').isVisible(), `${lang}: holding Space did not start a performance`);
    check((await page.evaluate(() => window.__notes)) > 0, `${lang}: holding Space made no sound`);
    await everyWidth(page, lang, 'playing');
    await page.keyboard.up(' ');
    await page.click('#again').catch(() => {});
    await page.goto(base);

    await perform(page);
    await everyWidth(page, lang, 'end panel');
    await page.click('#to-song');
    await everyWidth(page, lang, 'parameter card');
    await page.click('#card-back');
    await page.click('#share');
    const link = await page.evaluate(() => navigator.clipboard.readText());
    await everyWidth(page, lang, 'end panel, link copied');

    const friend = await context.newPage();
    await friend.goto(link);
    check(await friend.locator('#shared').isVisible(), `${lang}: a shared link did not open the 聆听 panel`);
    await everyWidth(friend, lang, 'shared link');
    await friend.goto('about:blank');
    await friend.goto(`${base}#${'Q'.repeat(40)}`);
    check(await friend.locator('#toast').isVisible(), `${lang}: a broken link said nothing`);
    await everyWidth(friend, lang, 'broken link');

    // Nothing collected, nothing sent.
    check(outside.length === 0, `${lang}: requests left the page: ${outside.join(', ')}`);
    check((await context.cookies()).length === 0, `${lang}: a cookie was set`);
    const stored = await page.evaluate(async () => [localStorage.length, sessionStorage.length, (await indexedDB.databases()).length]);
    check(stored.every((n) => n === 0), `${lang}: something was stored (localStorage, sessionStorage, IndexedDB = ${stored})`);
    check(errors.length === 0, `${lang}: page errors: ${errors.join(' | ')}`);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`✗ ${failures.length} problem(s), ${passed} check(s) passed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ ${passed} checks: 3 languages × 5 widths × every screen, keyboard play, nothing sent or stored`);
