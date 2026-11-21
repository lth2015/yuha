/**
 * Where people came from, per campaign link (docs/ATTRIBUTION_SPEC.md).
 *
 * A link carries `?src=…`; the browser keeps it (first touch, thirty days)
 * and sends it with each page view and, once, after sign-in. The dashboard
 * follows each source from visit to sign-up to a first song to a purchase,
 * so a campaign's spend can be held against what it brought.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execute, query } from '@yuha/db';
import { normalizeSource } from '@yuha/contracts';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';
import { allowInvariantBreach } from './helpers/invariant-guard.js';

let h: Harness;
let live: Harness;
let admin: TestUser;
beforeAll(async () => {
  h = await createHarness({ ADMIN_MFA_REQUIRED: 'false' });
  // In the demo every page view is internal by design; counting needs a live mode.
  live = await createHarness({ ADMIN_MFA_REQUIRED: 'false', RUN_MODE: 'integration' });
});
beforeEach(async () => {
  await resetData();
  admin = await h.createUser({ email: 'attr-admin@example.test', role: 'admin' });
});
afterAll(async () => {
  await live.close();
  await teardown();
});

const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const visit = (visitorId: string, source?: string) =>
  live.app.inject({ method: 'POST', url: '/v1/visits', payload: { visitorId, path: '/', ...(source ? { source } : {}) } as never });
const tag = (user: TestUser, source: unknown) =>
  h.app.inject({ method: 'POST', url: '/v1/me/source', headers: user.authHeader, payload: { source } as never });
const sourceOf = async (userId: string) =>
  (await query<{ s: string | null }>(`SELECT acquisition_source AS s FROM users WHERE id = ?`, [userId]))[0]!.s;

describe('a source name', () => {
  it('is kept to a short tag, whatever the link carried', () => {
    expect(normalizeSource('X-Xmas-1')).toBe('x-xmas-1');
    expect(normalizeSource(' x xmas ')).toBe('x-xmas');
    expect(normalizeSource('a'.repeat(60))).toBeNull();
    expect(normalizeSource('<script>')).toBeNull();
    expect(normalizeSource('')).toBeNull();
  });
});

describe('page views', () => {
  it('carry the source, and a malformed one is dropped rather than the view', async () => {
    expect((await visit(randomUUID(), 'X-Ad-1')).statusCode).toBe(202);
    expect((await visit(randomUUID(), 'not a <tag>')).statusCode).toBe(202);
    const rows = await query<{ props: { source?: string } }>(`SELECT props FROM analytics_events WHERE name = 'page_view'`);
    expect(rows.map((r) => r.props.source ?? null).sort()).toEqual([null, 'x-ad-1']);
  });
});

describe("an account's source", () => {
  it('is recorded once, from the first link, soon after sign-up', async () => {
    const u = await h.createUser({ email: 'new@example.test' });
    expect((await tag(u, 'x-ad-1')).json()).toEqual({ recorded: true });
    expect((await tag(u, 'x-ad-2')).json()).toEqual({ recorded: false });
    expect(await sourceOf(u.id)).toBe('x-ad-1');
  });

  it('is not given to an account that already existed', async () => {
    const u = await h.createUser({ email: 'old@example.test' });
    await execute(`UPDATE users SET created_at = UTC_TIMESTAMP(3) - INTERVAL 3 DAY WHERE id = ?`, [u.id]);
    expect((await tag(u, 'x-ad-1')).json()).toEqual({ recorded: false });
    expect(await sourceOf(u.id)).toBeNull();
  });

  it('refuses a malformed tag', async () => {
    const u = await h.createUser({ email: 'bad@example.test' });
    expect((await tag(u, 'not a <tag>')).statusCode).toBe(400);
  });
});

describe('the dashboard, per source', () => {
  it('follows each source from visit to sign-up to a first song to a purchase', async () => {
    // Rows written directly for the counts: a delivered job with no song, a paid order with no grant.
    allowInvariantBreach('delivered-job-has-a-song', 'finished-at-iff-ended', 'paid-order-granted', 'delivered-job-spent-its-credit');
    await visit(randomUUID(), 'x-ad-1');
    await visit(randomUUID(), 'x-ad-1');
    await visit(randomUUID(), 'x-ad-2');

    const a = await h.createUser({ email: 'a@example.test' });
    const b = await h.createUser({ email: 'b@example.test' });
    const c = await h.createUser({ email: 'c@example.test' });
    await tag(a, 'x-ad-1');
    await tag(b, 'x-ad-1');
    await tag(c, 'x-ad-2');
    await deliveredJob(a.id);
    await deliveredJob(b.id);
    await paidOrder(a.id, 980);

    const { sources } = (await h.app.inject({ method: 'GET', url: `/v1/admin/stats?granularity=day&from=${today()}&to=${today()}`, headers: admin.authHeader })).json();
    const by = Object.fromEntries((sources.campaigns as Array<{ source: string | null }>).map((r) => [r.source ?? '-', r]));
    expect(by['x-ad-1']).toEqual({ source: 'x-ad-1', visitors: 2, signups: 2, madeASong: 2, paid: 1, revenueJpy: 980 });
    expect(by['x-ad-2']).toEqual({ source: 'x-ad-2', visitors: 1, signups: 1, madeASong: 0, paid: 0, revenueJpy: 0 });
  });
});

async function deliveredJob(userId: string): Promise<void> {
  const projectId = randomUUID();
  await execute(`INSERT INTO projects (id, owner_id, title, scene) VALUES (?, ?, 'p', 'daily_log')`, [projectId, userId]);
  const id = randomUUID();
  await execute(
    `INSERT INTO generation_jobs (id, user_id, project_id, idempotency_key, request_hash, state, input, provider_request_key)
     VALUES (?, ?, ?, ?, REPEAT('0', 64), 'DELIVERED', '{}', ?)`,
    [id, userId, projectId, `k-${id}`, `r-${id}`],
  );
}

async function paidOrder(userId: string, amount: number): Promise<void> {
  const [row] = await query<{ v: number }>(`SELECT MAX(version) AS v FROM product_catalog WHERE price_key = 'drop_5'`);
  const id = randomUUID();
  await execute(
    `INSERT INTO orders (id, user_id, price_key, price_version, kind, amount_minor, currency, status, idempotency_key, metadata, payment_method, paid_at)
     VALUES (?, ?, 'drop_5', ?, 'one_time', ?, 'jpy', 'paid', ?, '{}', 'card', UTC_TIMESTAMP(3))`,
    [id, userId, Number(row!.v), amount, `idem-${id}`],
  );
}
