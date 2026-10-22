#!/usr/bin/env node
/**
 * UI acceptance: every page, at phone, tablet and desktop widths, in a real
 * browser — and a failure when the layout breaks.
 *
 * Why this exists. 1041 tests passed while the admin console on a phone had a
 * tab bar wrapping onto two rows, a customer table whose only action button
 * was cut off at the right edge, and controls sliding under the bottom tab
 * bar. Every check this repository had was about behaviour, and every
 * screenshot anyone took was 1280 px wide. A layout nobody measures at 390 px
 * is a layout nobody has seen at 390 px.
 *
 * Why `scrollWidth` is not the test. `body` has `overflow-x: clip`, so a page
 * whose content is wider than the screen does NOT scroll sideways — the excess
 * is simply cut off, and `document.documentElement.scrollWidth` reports the
 * viewport width as if all were well. It did, on every page measured. What is
 * checked instead is each element's own box against what can actually show
 * it: the viewport, and every clipping ancestor.
 *
 * Rules (each one is a defect a person reported or would report on sight):
 *
 *   cut-off      a control, heading or line of text extends past the screen
 *                or past a clipping ancestor, so part of it can never be seen.
 *                Cells of a data table that scrolls sideways are allowed to
 *                sit off-screen — that is what the scroller is for — but a
 *                CONTROL in one is not: an action you have to discover by
 *                swiping a table is an action nobody finds. (A snapping
 *                carousel is the exception: the next card peeking past the
 *                edge is what tells you there is one.)
 *   wraps        a navigation row (a <nav> or tablist outside the footer)
 *                breaks onto a second line.
 *   hidden       content lies under a fixed or sticky bar at a scroll position
 *                where it cannot be scrolled out from under it: under a top bar
 *                at the top of the page, under a bottom bar at the bottom.
 *   overlap      two controls overlap each other.
 *
 *   truncated    a control's own label is cut short ("ダッシュボ…").
 *
 * Warnings (printed, not failed): tap targets under 32 px on a phone (inline
 * links in running text are the usual case), other text truncated by its own
 * box.
 *
 * Usage:
 *   pnpm dev            # demo stack on :5173 / :4000, seeded (pnpm seed)
 *   pnpm check:ui       # all pages × all widths; screenshots of failures
 *   UI_BASE=http://localhost:5173 UI_SHOTS=./ui-shots pnpm check:ui
 *   pnpm check:ui -- --only admin   # pages whose name contains "admin"
 *
 * Signs in with the seeded development identities, so it runs against a demo
 * or integration stack only — never production, where dev login is refused.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.UI_BASE ?? 'http://localhost:5173';

/**
 * In GitHub Actions each problem is also an annotation: annotations can be
 * read from the API and the PR page, where the raw job log often cannot.
 */
const annotate = (title, message) => {
  if (!process.env.GITHUB_ACTIONS) return;
  const esc = (v) => String(v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::error title=${esc(title).replace(/[:,]/g, ' ')}::${esc(message)}`);
};
process.on('uncaughtException', (err) => {
  annotate('check-ui crashed', err.stack ?? String(err));
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  annotate('check-ui crashed', err?.stack ?? String(err));
  console.error(err);
  process.exit(1);
});
const SHOTS = process.env.UI_SHOTS ?? 'ui-shots';
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? process.argv[i + 1] : null;
})();

/** Widths people actually hold. 360: small Android; 393: current iPhone. */
const VIEWPORTS = [
  { name: 'phone-360', width: 360, height: 740, mobile: true },
  { name: 'phone-393', width: 393, height: 852, mobile: true },
  { name: 'tablet-768', width: 768, height: 1024, mobile: true },
  { name: 'desktop-1280', width: 1280, height: 900, mobile: false },
];
/** Japanese and English run longer than Chinese; every language is a layout. */
const LANGS = ['zh', 'ja', 'en'];

/**
 * Every routed page, as the person who would see it. A page added to App.tsx
 * and not here is a page this check says nothing about — so `routesCovered`
 * below fails when App.tsx routes something this list does not name.
 */
const PAGES = [
  { name: 'home', path: '/', as: null },
  { name: 'home-signed-in', path: '/', as: 'creator' },
  { name: 'pricing', path: '/pricing', as: null },
  { name: 'auth', path: '/auth', as: null },
  { name: 'create', path: '/create', as: 'creator' },
  { name: 'library', path: '/library', as: 'creator' },
  { name: 'checkout-confirm', path: '/checkout/confirm?price=drop_5', as: 'creator' },
  { name: 'settings-billing', path: '/settings/billing', as: 'creator' },
  { name: 'settings-account', path: '/settings/account', as: 'creator' },
  { name: 'rights', path: '/help/rights', as: null },
  { name: 'legal', path: '/legal', as: null },
  { name: 'legal-terms', path: '/legal/terms', as: null },
  { name: 'legal-privacy', path: '/legal/privacy', as: null },
  { name: 'legal-company', path: '/legal/company', as: null },
  { name: 'legal-tokushoho', path: '/legal/tokushoho', as: null },
  { name: 'not-found', path: '/no-such-page', as: null },
  { name: 'song', path: '/song/:track', as: 'creator' },
  { name: 'song-public-view', path: '/song/:track', as: null },
  { name: 'track-export', path: '/tracks/:track/export', as: 'creator' },
  { name: 'track-license', path: '/tracks/:track/license', as: 'admin' },
  { name: 'checkout-complete', path: '/checkout/complete?order_id=:order', as: 'creator' },
  { name: 'admin-dashboard', path: '/admin/dashboard', as: 'admin' },
  { name: 'admin-users', path: '/admin/users', as: 'admin', prepare: openCustomer },
  { name: 'admin-orders', path: '/admin/orders', as: 'admin' },
  { name: 'admin-ops', path: '/admin/ops', as: 'admin' },
  { name: 'admin-review', path: '/admin/review', as: 'admin' },
  { name: 'admin-audit', path: '/admin/audit', as: 'admin' },
];

/** Routes deliberately not visited, each with the reason. */
const NOT_VISITED = {
  '/auth/google/callback': 'an OAuth redirect target, never a page anyone sees',
  '/auth/mfa': 'reached only mid-sign-in with an MFA factor enrolled',
  '/checkout/stablecoin': 'needs stablecoin configuration and a wallet',
  '/checkout/simulate': 'demo payment stub',
  '/admin': 'the same page as /admin/dashboard',
  '/admin/:tab': 'each tab is listed by name',
};

const USERS = { creator: 'creator@example.jp', admin: 'admin@example.jp' };

async function openCustomer(page) {
  const search = page.locator('main input[type=email], main input[type=search]').first();
  await search.fill(USERS.creator);
  await search.press('Enter');
  await page.waitForTimeout(600);
  const open = page.locator('main table button').first();
  if (await open.count()) await open.click();
  await page.waitForLoadState('networkidle');
}

/** Runs inside the page. Returns { problems, warnings } for this scroll state. */
function audit({ phone, phase }) {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const problems = [];
  const warnings = [];

  const isVisible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) => {
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 40);
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    return `<${el.tagName.toLowerCase()}${cls}> "${text}"`;
  };
  // People arrive at every sideways scroller at its start; so does this.
  for (const el of document.querySelectorAll('body *')) if (el.scrollLeft) el.scrollLeft = 0;

  const CONTROL = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab]';
  const isControl = (el) => el.matches(CONTROL);

  // What is checked: controls, headings and text-bearing leaves in the page.
  const targets = [
    ...document.querySelectorAll(
      `${CONTROL}, h1, h2, h3, h4, p, li, dt, dd, th, td, label, .badge, .stat__value, figcaption`,
    ),
  ].filter((el) => isVisible(el) && !el.closest('[aria-hidden=true], .sr-only, .visually-hidden, .skip-link'));

  // ---- cut-off ------------------------------------------------------------
  for (const el of targets) {
    if (getComputedStyle(el).position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    let left = 0;
    let right = vw;
    let scroller = null;
    let carousel = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox === 'visible') continue;
      const ar = a.getBoundingClientRect();
      left = Math.max(left, ar.left);
      right = Math.min(right, ar.right);
      if ((ox === 'auto' || ox === 'scroll') && a.scrollWidth > a.clientWidth + 1 && !scroller) scroller = a;
      // A snapping carousel shows the next card peeking past the edge on
      // purpose; that is its affordance, not a cut-off.
      if (getComputedStyle(a).scrollSnapType.startsWith('x') && a.scrollWidth > a.clientWidth + 1) carousel = true;
    }
    // Clipped to a box a pixel wide is the visually-hidden idiom (a table's
    // <thead> on a phone, where the cells carry the labels) — hidden on purpose.
    if (right - left <= 1) continue;
    const out = r.right > right + 1 || r.left < left - 1;
    if (!out) continue;
    if (scroller && (!isControl(el) || carousel)) continue; // data in a scroller, or a carousel: allowed
    problems.push({
      rule: 'cut-off',
      what: label(el),
      detail: `${Math.round(r.left)}–${Math.round(r.right)} px, visible ${Math.round(left)}–${Math.round(right)}${scroller ? ' (inside a sideways scroller)' : ''}`,
    });
  }

  // ---- wraps --------------------------------------------------------------
  for (const nav of document.querySelectorAll('nav, [role=tablist]')) {
    if (!isVisible(nav) || nav.closest('footer')) continue;
    const items = [...nav.querySelectorAll(':scope > a, :scope > button, :scope > * > a, :scope > * > button')].filter(isVisible);
    if (items.length < 2) continue;
    // A vertical list (every item on its own row) and a deliberate grid are
    // layouts; a row that ran out of room and broke is the defect.
    const rows = new Map();
    for (const i of items) {
      const key = Math.round(i.getBoundingClientRect().top / 8);
      rows.set(key, (rows.get(key) ?? 0) + 1);
    }
    const vertical = rows.size === items.length;
    const grid = items.some((i) => getComputedStyle(i.parentElement).display.includes('grid'));
    if (rows.size > 1 && !vertical && !grid) {
      problems.push({ rule: 'wraps', what: label(nav), detail: `${items.length} items on ${rows.size} rows` });
    }
  }

  // ---- hidden under a bar ---------------------------------------------------
  const bars = [...document.querySelectorAll('body *')].filter((el) => {
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'sticky') return false;
    if (s.pointerEvents === 'none' || !isVisible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= vw * 0.5 && r.height < vh * 0.4; // a bar, not a backdrop
  });
  for (const bar of bars) {
    const b = bar.getBoundingClientRect();
    const atTop = b.top < vh / 2;
    // A top bar only hides content for good at the top of the page; a bottom
    // bar only at the bottom. Anywhere else, scrolling uncovers it.
    if ((atTop && phase !== 'top') || (!atTop && phase !== 'bottom')) continue;
    if (atTop && getComputedStyle(bar).position === 'sticky') continue; // sticky takes its own room at the top
    for (const el of targets) {
      if (bar.contains(el) || el.contains(bar)) continue;
      const r = el.getBoundingClientRect();
      const ix = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const iy = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (ix > 2 && iy > 2) {
        problems.push({ rule: 'hidden', what: label(el), detail: `under ${label(bar)} when scrolled to the ${phase}` });
      }
    }
  }

  // ---- overlap --------------------------------------------------------------
  const controls = targets.filter(isControl).filter((el) => !bars.some((b) => b.contains(el)));
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i];
      const c = controls[j];
      if (a.contains(c) || c.contains(a)) continue;
      // Line boxes, not bounding boxes: a link that wraps onto two lines has
      // a bounding box as wide as the paragraph and "overlaps" its neighbour.
      const hit = [...a.getClientRects()].some((r1) =>
        [...c.getClientRects()].some((r2) => {
          const ix = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left);
          const iy = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
          return ix > 2 && iy > 2;
        }),
      );
      if (hit) problems.push({ rule: 'overlap', what: label(a), detail: `overlaps ${label(c)}` });
    }
  }

  // ---- warnings -------------------------------------------------------------
  if (phone) {
    for (const el of controls) {
      if (el.matches('input[type=checkbox], input[type=radio]')) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 32 && el.closest('main')) warnings.push({ rule: 'small-target', what: label(el), detail: `${Math.round(r.height)} px tall` });
    }
  }
  // A label cut to "ダッシュボ…" on a control is a defect — the control no
  // longer says what it does. Elsewhere an ellipsis is usually deliberate
  // (a long title in a list row), so it is only reported.
  for (const el of targets) {
    if (el.children.length) continue;
    const s = getComputedStyle(el);
    if ((s.overflowX === 'hidden' || s.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1) {
      (isControl(el) ? problems : warnings).push({ rule: 'truncated', what: label(el), detail: 'text cut by its own box' });
    }
  }

  // Report each element once, keeping the first reason.
  const seen = new Set();
  const dedupe = (list) => list.filter((p) => (seen.has(p.rule + p.what) ? false : (seen.add(p.rule + p.what), true)));
  return { problems: dedupe(problems), warnings: dedupe(warnings) };
}

async function signIn(browser, who) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/auth`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', USERS[who]);
  for (const c of await page.$$('input[type=checkbox]')) await c.check();
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 15_000 });
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function routesCovered() {
  // App.tsx is the list of pages; a route missing from both lists above is a
  // page this check would silently never look at.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const routed = [...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*');
  const asRoute = (p) => p.split('?')[0].replace(/:track|:order/g, ':id');
  const visited = new Set(PAGES.map((p) => asRoute(p.path)));
  return routed.filter((r) => !visited.has(r) && !(r in NOT_VISITED));
}

const unlisted = await routesCovered();
if (unlisted.length) {
  console.error(`✗ routes in App.tsx this check does not visit or explain: ${unlisted.join(', ')}`);
  process.exit(1);
}

/**
 * Something on every screen. An empty orders table, an empty audit log and a
 * library with no songs render as one line of "nothing here" — which fits any
 * screen and proves nothing. So before looking, the check makes the data a
 * real console has: a finished song, a paid order, an operator's gift (an
 * audit row and a ledger batch). Demo mode only: simulated payment and the
 * demo music adapter.
 */
async function fixtures(browser, states) {
  const ctx = await browser.newContext({ storageState: states.creator });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const call = (method, path, body, headers = {}) =>
    page.evaluate(
      async ([method, path, body, headers]) => {
        const res = await fetch(path, {
          method,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${localStorage.getItem('loopscene.token')}`,
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
        return text ? JSON.parse(text) : null;
      },
      [method, path, body, headers],
    );
  const key = () => `ui-check-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  let tracks = (await call('GET', '/v1/tracks')).items ?? [];
  if (!tracks.length) {
    await call('POST', '/v1/generations', { prompt: '傍晚的海边，朋友骑车回家' }, { 'idempotency-key': key() });
    for (let i = 0; i < 60 && !tracks.length; i++) {
      await page.waitForTimeout(1000);
      tracks = (await call('GET', '/v1/tracks')).items ?? [];
    }
  }
  if (!tracks.length) throw new Error('fixtures: the demo generation produced no track in 60 s — is the worker running?');
  const track = tracks[0].id;
  // Public, so the signed-out view of the song page is a real page too.
  await call('POST', `/v1/tracks/${track}/visibility`, { visibility: 'public' }).catch(() => undefined);

  let orders = (await call('GET', '/v1/orders')).items ?? [];
  let order = orders.find((o) => o.status === 'paid')?.id;
  if (!order) {
    const co = await call('POST', '/v1/checkout', { priceKey: 'drop_5', idempotencyKey: key() });
    const sessionId = new URL(co.checkoutUrl, BASE).searchParams.get('session_id');
    await call('POST', '/v1/dev/simulate-payment', { sessionId, outcome: 'paid' });
    order = co.orderId;
  }
  await ctx.close();

  const actx = await browser.newContext({ storageState: states.admin });
  const apage = await actx.newPage();
  await apage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await apage.evaluate(async ([email, k]) => {
    const auth = { authorization: `Bearer ${localStorage.getItem('loopscene.token')}`, 'content-type': 'application/json' };
    const found = await (await fetch(`/v1/admin/users?email=${encodeURIComponent(email)}`, { headers: auth })).json();
    const id = found.items?.[0]?.userId;
    if (!id) throw new Error('fixtures: the seeded creator was not found');
    await fetch(`/v1/admin/users/${id}/grant`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ units: 3, reason: 'UI acceptance fixture', idempotencyKey: k }),
    });
  }, [USERS.creator, `ui-check-grant-${new Date().toISOString().slice(0, 10)}`]);
  await actx.close();
  return { track, order };
}

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const states = { creator: await signIn(browser, 'creator'), admin: await signIn(browser, 'admin') };
const data = await fixtures(browser, states);
for (const p of PAGES) p.path = p.path.replace(':track', data.track).replace(':order', data.order);
let failures = 0;
let warnings = 0;
let checked = 0;

for (const pageDef of PAGES.filter((p) => !only || p.name.includes(only))) {
  for (const vp of VIEWPORTS) {
    // Every language at phone widths, where length decides the layout;
    // Chinese alone above that.
    for (const lang of vp.width < 600 ? LANGS : ['zh']) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        deviceScaleFactor: 1,
        ...(pageDef.as ? { storageState: states[pageDef.as] } : {}),
      });
      await ctx.addInitScript((l) => {
        try {
          localStorage.setItem('yuha.lang', l);
        } catch {
          /* storage refused: the page's default language is still a layout */
        }
      }, lang);
      const page = await ctx.newPage();
      await page.goto(`${BASE}${pageDef.path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400); // web fonts and the first paint of charts
      const results = [];
      // The page as it lands, then — for pages with a second state, like a
      // customer opened from the list — that state too, at both ends.
      if (pageDef.prepare) {
        results.push(await page.evaluate(audit, { phone: vp.width < 600, phase: 'top' }));
        await pageDef.prepare(page);
        await page.waitForTimeout(300);
      }
      for (const phase of ['top', 'bottom']) {
        await page.evaluate((p) => window.scrollTo(0, p === 'top' ? 0 : document.documentElement.scrollHeight), phase);
        await page.waitForTimeout(150);
        results.push(await page.evaluate(audit, { phone: vp.width < 600, phase }));
      }
      const problems = [];
      const seen = new Set();
      for (const p of results.flatMap((r) => r.problems)) {
        if (!seen.has(p.rule + p.what)) seen.add(p.rule + p.what) && problems.push(p);
      }
      const warns = results[0].warnings;
      checked++;
      warnings += warns.length;
      const where = `${pageDef.name} @ ${vp.name} [${lang}]`;
      if (problems.length) {
        failures += problems.length;
        const shot = join(SHOTS, `${pageDef.name}-${vp.name}-${lang}.png`);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: shot, fullPage: true });
        console.log(`✗ ${where}  (${shot})`);
        for (const p of problems) console.log(`    ${p.rule.padEnd(8)} ${p.what} — ${p.detail}`);
        annotate(`UI ${where}`, problems.map((p) => `${p.rule} ${p.what} — ${p.detail}`).join('\n'));
      } else {
        console.log(`✓ ${where}`);
      }
      if (process.env.UI_WARN) for (const w of warns) console.log(`    warn ${w.rule} ${w.what} — ${w.detail}`);
      await ctx.close();
    }
  }
}
await browser.close();

console.log(
  `\n${checked} page views checked; ${failures} problem${failures === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} (UI_WARN=1 to list them).`,
);
if (checked === 0) {
  console.error('✗ nothing was checked — a filter that matches no page passes vacuously');
  process.exit(1);
}
process.exit(failures ? 1 : 0);
