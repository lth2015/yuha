/**
 * The operator console: the dashboard numbers, account suspension and roles,
 * and the cross-account order and audit lists.
 *
 * The dashboard is checked against rows placed at known instants, including
 * the ones that decide whether a number lands in the right bucket: 00:30 in
 * Tokyo is still the previous day in UTC, and an ISO week starts on Monday.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { grantUnits, query, withTx } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let admin: TestUser;
let support: TestUser;

beforeAll(async () => {
  h = await createHarness({ ADMIN_MFA_REQUIRED: 'false' });
  live = await createHarness({ ADMIN_MFA_REQUIRED: 'false', RUN_MODE: 'integration' });
});
beforeEach(async () => {
  await resetData();
  admin = await h.createUser({ email: 'console-admin@example.test', role: 'admin' });
  support = await h.createUser({ email: 'console-support@example.test', role: 'support' });
});
afterAll(async () => {
  await live.close();
  await teardown();
});

const get = (user: TestUser, url: string) => h.app.inject({ method: 'GET', url, headers: user.authHeader });
const post = (user: TestUser, url: string, payload: unknown) =>
  h.app.inject({ method: 'POST', url, headers: user.authHeader, payload: payload as never });

// ------------------------------------------------------------------ fixtures

async function insertJob(userId: string, createdAt: string, state: string): Promise<void> {
  const projectId = randomUUID();
  await query(`INSERT INTO projects (id, owner_id, title, scene) VALUES (?, ?, 'p', 'daily_log')`, [projectId, userId]);
  const id = randomUUID();
  await query(
    `INSERT INTO generation_jobs (id, user_id, project_id, idempotency_key, request_hash, state, input, provider_request_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, REPEAT('0', 64), ?, '{}', ?, ?, ?)`,
    [id, userId, projectId, `k-${id}`, state, `r-${id}`, createdAt, createdAt],
  );
}

async function catalogueVersion(priceKey: string): Promise<number> {
  const [row] = await query<{ version: number }>(`SELECT MAX(version) AS version FROM product_catalog WHERE price_key = ?`, [priceKey]);
  return Number(row!.version);
}

async function insertPaidOrder(userId: string, paidAt: string, method: 'card' | 'jpyc' | 'usdc', amount = 980): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO orders (id, user_id, price_key, price_version, kind, amount_minor, currency, status, idempotency_key, metadata, payment_method, paid_at, created_at)
     VALUES (?, ?, 'drop_5', ?, 'one_time', ?, 'jpy', 'paid', ?, '{}', ?, ?, ?)`,
    [id, userId, await catalogueVersion('drop_5'), amount, `idem-${id}`, method === 'card' ? 'card' : 'stablecoin', paidAt, paidAt],
  );
  if (method !== 'card') {
    await query(
      `INSERT INTO stablecoin_quotes (id, order_id, user_id, token_key, chain_id, token_address, token_decimals, receiver, payer,
         price_jpy, amount_atomic, start_block, config_version, expires_at)
       VALUES (?, ?, ?, ?, 137, '0x0000000000000000000000000000000000000001', 6,
         '0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003', ?, '1', 1, 1, ?)`,
      [randomUUID(), id, userId, method, amount, paidAt],
    );
  }
  return id;
}

async function grantAt(userId: string, units: number, source: 'one_time_order' | 'operator_gift', at: string): Promise<void> {
  const { batch } = await withTx((tx) =>
    grantUnits(
      { userId, source, sourceRef: `t:${randomUUID()}`, units, expiresAt: new Date(Date.now() + 90 * 86_400_000), reason: 'test' },
      tx,
    ),
  );
  await query(`UPDATE ledger_entries SET created_at = ? WHERE batch_id = ? AND entry_type = 'grant'`, [at, batch.id]);
}

/*
 * Visits go through an integration-mode server: in the demo every row is
 * internal by design, so a demo harness would prove only that nothing counts.
 */
let live: Harness;
const visit = (visitorId: string, path = '/', user?: TestUser) =>
  live.app.inject({
    method: 'POST',
    url: '/v1/visits',
    headers: user?.authHeader ?? {},
    payload: { visitorId, path } as never,
  });

// ------------------------------------------------------------------ dashboard

describe('the dashboard', () => {
  it('buckets by the Japan-time day — 00:30 in Tokyo belongs to that day, not the UTC one', async () => {
    const u = await h.createUser({ email: 'buyer@example.test' });
    // 2026-10-19T15:30Z is 2026-10-20 00:30 in Tokyo.
    await insertPaidOrder(u.id, '2026-10-19 15:30:00', 'card');
    await insertPaidOrder(u.id, '2026-10-19 14:30:00', 'card'); // 23:30 on the 19th in Tokyo

    const res = await get(admin, '/v1/admin/stats?granularity=day&from=2026-10-18&to=2026-10-20');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.buckets.map((b: { key: string }) => b.key)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20']);
    expect(body.buckets.map((b: { paidOrders: { count: number } }) => b.paidOrders.count)).toEqual([0, 1, 1]);
  });

  it('splits paid orders and revenue by card, JPYC and USDC', async () => {
    const u = await h.createUser({ email: 'mixed@example.test' });
    await insertPaidOrder(u.id, '2026-10-20 03:00:00', 'card', 980);
    await insertPaidOrder(u.id, '2026-10-20 03:00:00', 'jpyc', 980);
    await insertPaidOrder(u.id, '2026-10-20 03:00:00', 'usdc', 980);
    await insertPaidOrder(u.id, '2026-10-20 03:00:00', 'usdc', 980);

    const body = (await get(admin, '/v1/admin/stats?granularity=day&from=2026-10-20&to=2026-10-20')).json();
    expect(body.totals.paidOrders).toEqual({ count: 4, card: 1, jpyc: 1, usdc: 2 });
    expect(body.totals.revenueJpy).toEqual({ total: 3920, card: 980, jpyc: 980, usdc: 1960 });
  });

  it('labels a week by the Monday it starts on and fills empty buckets with zeros', async () => {
    const u = await h.createUser({ email: 'weekly@example.test' });
    // Sunday 2026-10-25 and Monday 2026-10-26 (Tokyo) fall in different ISO weeks.
    await insertJob(u.id, '2026-10-25 03:00:00', 'DELIVERED');
    await insertJob(u.id, '2026-10-26 03:00:00', 'FAILED');
    await insertJob(u.id, '2026-10-26 04:00:00', 'DELIVERED');

    const body = (await get(admin, '/v1/admin/stats?granularity=week&from=2026-10-12&to=2026-10-31')).json();
    expect(body.buckets.map((b: { key: string }) => b.key)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
    expect(body.buckets.map((b: { generations: unknown }) => b.generations)).toEqual([
      { submitted: 0, delivered: 0, failed: 0 },
      { submitted: 1, delivered: 1, failed: 0 },
      { submitted: 2, delivered: 1, failed: 1 },
    ]);
  });

  it('counts credits granted by source, and compares with the period before', async () => {
    const u = await h.createUser({ email: 'credits@example.test' });
    await grantAt(u.id, 5, 'one_time_order', '2026-10-20 03:00:00');
    await grantAt(u.id, 50, 'operator_gift', '2026-10-20 04:00:00');
    await grantAt(u.id, 5, 'one_time_order', '2026-10-19 03:00:00'); // the day before: "previous"

    const body = (await get(admin, '/v1/admin/stats?granularity=day&from=2026-10-20&to=2026-10-20')).json();
    expect(body.totals.creditsGranted).toMatchObject({ total: 55, purchased: 5, gift: 50 });
    expect(body.previous.creditsGranted).toMatchObject({ total: 5, purchased: 5 });
  });

  it('counts visits and distinct visitors, leaving staff and junk out', async () => {
    const a = randomUUID();
    const b = randomUUID();
    expect((await visit(a, '/')).statusCode).toBe(202);
    expect((await visit(a, '/pricing?token=secret')).statusCode).toBe(202);
    expect((await visit(b, '/create')).statusCode).toBe(202);
    const songId = randomUUID();
    expect((await visit(b, `/s/${songId}`)).statusCode).toBe(202);
    expect((await visit(randomUUID(), '/admin', admin)).statusCode).toBe(202); // staff: internal, not counted
    expect((await visit('not-a-uuid', '/')).statusCode).toBe(400);

    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const body = (await get(admin, `/v1/admin/stats?granularity=day&from=${today}&to=${today}`)).json();
    expect(body.totals.pageViews).toBe(4);
    expect(body.totals.visitors).toBe(2);
    // The query string, which can carry tokens, never reaches the table.
    const rows = await query<{ props: { path: string } }>(`SELECT props FROM analytics_events WHERE name = 'page_view'`);
    expect(rows.map((r) => r.props.path)).not.toContain('/pricing?token=secret');
    expect(rows.map((r) => r.props.path)).toContain('/pricing');
    // Nor does a song id: for a link-shared song the id is the key to it.
    expect(JSON.stringify(rows)).not.toContain(songId);
    expect(rows.map((r) => r.props.path)).toContain('/s/:id');
  });

  it('defaults to the last 30 days by day, and refuses a range with too many buckets', async () => {
    const def = (await get(admin, '/v1/admin/stats')).json();
    expect(def.granularity).toBe('day');
    expect(def.buckets).toHaveLength(30);
    expect((await get(admin, '/v1/admin/stats?granularity=day&from=2020-01-01&to=2026-01-01')).statusCode).toBe(400);
    expect((await get(admin, '/v1/admin/stats?granularity=month&from=2020-01-01&to=2026-01-01')).statusCode).toBe(200);
  });

  it('is staff-only', async () => {
    const u = await h.createUser({ email: 'nosy@example.test' });
    expect((await get(u, '/v1/admin/stats')).statusCode).toBe(403);
    expect((await get(support, '/v1/admin/stats')).statusCode).toBe(200);
  });
});

// ------------------------------------------------------------- suspension

describe('suspending and reactivating an account', () => {
  it('locks the person out on their next request, and records who did it and why', async () => {
    const u = await h.createUser({ email: 'abuser@example.test' });
    expect((await get(u, '/v1/me')).statusCode).toBe(200);

    const res = await post(admin, `/v1/admin/users/${u.id}/suspend`, { reason: 'chargeback fraud pattern' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'suspended', changed: true });
    expect((await get(u, '/v1/me')).statusCode).toBeGreaterThanOrEqual(401);

    const audit = await query<{ action: string; reason: string; actor_id: string }>(
      `SELECT action, reason, actor_id FROM audit_logs WHERE subject_type = 'user' AND subject_id = ? AND action LIKE 'user.%'`,
      [u.id],
    );
    expect(audit).toEqual([{ action: 'user.suspended', reason: 'chargeback fraud pattern', actor_id: admin.id }]);

    const back = await post(admin, `/v1/admin/users/${u.id}/reactivate`, { reason: 'cleared after review' });
    expect(back.json()).toEqual({ status: 'active', changed: true });
    expect((await get(u, '/v1/me')).statusCode).toBe(200);
  });

  it('refuses a suspended account at sign-in, with a code the sign-in page can explain', async () => {
    // The console promises "cannot sign in". Refusing only later requests
    // meant a suspended person signed in successfully and then watched every
    // screen fail with a generic error.
    const login = (email: string) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/auth/dev-login',
        payload: { email, ageConfirmed: true, termsAccepted: true },
      });
    const first = await login('banned-at-door@example.test');
    expect(first.statusCode, first.body).toBe(200);
    const userId = first.json().user.userId as string;
    const token = first.json().token as string;

    await post(admin, `/v1/admin/users/${userId}/suspend`, { reason: 'abuse of the free trial' });

    const again = await login('banned-at-door@example.test');
    expect(again.statusCode).toBe(403);
    expect(again.json().error.code).toBe('ACCOUNT_SUSPENDED');
    expect(again.json().token).toBeUndefined();

    const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(403);
    expect(me.json().error.code).toBe('ACCOUNT_SUSPENDED');

    await post(admin, `/v1/admin/users/${userId}/reactivate`, { reason: 'appeal upheld' });
    expect((await login('banned-at-door@example.test')).statusCode).toBe(200);
  });

  it('says "no change" for a second suspension instead of writing a second audit row', async () => {
    const u = await h.createUser({ email: 'twice@example.test' });
    await post(admin, `/v1/admin/users/${u.id}/suspend`, { reason: 'first time round' });
    const again = await post(admin, `/v1/admin/users/${u.id}/suspend`, { reason: 'second time round' });
    expect(again.json()).toEqual({ status: 'suspended', changed: false });
    const [row] = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs WHERE subject_id = ? AND action = 'user.suspended'`, [u.id]);
    expect(Number(row!.n)).toBe(1);
  });

  it('refuses yourself, another administrator, a missing reason, and support', async () => {
    const other = await h.createUser({ email: 'other-admin@example.test', role: 'admin' });
    const u = await h.createUser({ email: 'target@example.test' });
    expect((await post(admin, `/v1/admin/users/${admin.id}/suspend`, { reason: 'locking myself out' })).statusCode).toBe(409);
    expect((await post(admin, `/v1/admin/users/${other.id}/suspend`, { reason: 'one click removal' })).statusCode).toBe(409);
    expect((await post(admin, `/v1/admin/users/${u.id}/suspend`, {})).statusCode).toBe(400);
    expect((await post(support, `/v1/admin/users/${u.id}/suspend`, { reason: 'support cannot ban' })).statusCode).toBe(403);
    const [row] = await query<{ status: string }>(`SELECT status FROM users WHERE id = ?`, [u.id]);
    expect(row!.status).toBe('active');
  });
});

describe('changing an account’s role', () => {
  it('promotes from the console, so nobody has to write SQL to make an operator', async () => {
    const u = await h.createUser({ email: 'new-support@example.test' });
    const res = await post(admin, `/v1/admin/users/${u.id}/role`, { role: 'support', reason: 'joined the support rota' });
    expect(res.json()).toEqual({ role: 'support', changed: true });
    expect((await get(u, '/v1/admin/stats')).statusCode).toBe(200);
    const [a] = await query<{ before_state: unknown; after_state: unknown }>(
      `SELECT before_state, after_state FROM audit_logs WHERE subject_id = ? AND action = 'user.role_changed'`,
      [u.id],
    );
    expect(a).toEqual({ before_state: { role: 'user' }, after_state: { role: 'support' } });
  });

  it('will not let an administrator change their own role, or support change anyone’s', async () => {
    const u = await h.createUser({ email: 'climber@example.test' });
    expect((await post(admin, `/v1/admin/users/${admin.id}/role`, { role: 'user', reason: 'demoting myself' })).statusCode).toBe(409);
    expect((await post(support, `/v1/admin/users/${u.id}/role`, { role: 'admin', reason: 'promoting a friend' })).statusCode).toBe(403);
    expect((await post(support, `/v1/admin/users/${support.id}/role`, { role: 'admin', reason: 'promoting myself' })).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------- lists and detail

describe('orders, audit and the customer record', () => {
  it('lists orders across accounts, filtered by payment method and email', async () => {
    const a = await h.createUser({ email: 'alice@example.test' });
    const b = await h.createUser({ email: 'bob@example.test' });
    await insertPaidOrder(a.id, '2026-10-20 03:00:00', 'card');
    await insertPaidOrder(a.id, '2026-10-20 04:00:00', 'usdc');
    await insertPaidOrder(b.id, '2026-10-20 05:00:00', 'jpyc');

    const all = (await get(admin, '/v1/admin/orders')).json();
    expect(all.items).toHaveLength(3);
    const usdc = (await get(admin, '/v1/admin/orders?method=usdc')).json();
    expect(usdc.items.map((o: { email: string; method: string }) => [o.email, o.method])).toEqual([['alice@example.test', 'usdc']]);
    const bob = (await get(admin, '/v1/admin/orders?email=bob')).json();
    expect(bob.items.map((o: { method: string }) => o.method)).toEqual(['jpyc']);
  });

  it('shows the audit log with the people named, filterable by email', async () => {
    const u = await h.createUser({ email: 'audited@example.test' });
    await post(admin, `/v1/admin/users/${u.id}/suspend`, { reason: 'spam uploads' });
    const res = (await get(support, '/v1/admin/audit?email=audited&action=user.')).json();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      action: 'user.suspended',
      actorEmail: 'console-admin@example.test',
      subjectEmail: 'audited@example.test',
      reason: 'spam uploads',
    });
  });

  it('opens a customer with their recent generations and what operators did to the account', async () => {
    const u = await h.createUser({ email: 'detail@example.test' });
    await insertJob(u.id, '2026-10-20 03:00:00', 'DELIVERED');
    await post(admin, `/v1/admin/users/${u.id}/role`, { role: 'support', reason: 'trial support shift' });
    const view = (await get(admin, `/v1/admin/users/${u.id}`)).json();
    expect(view.recentJobs).toHaveLength(1);
    expect(view.recentJobs[0].state).toBe('DELIVERED');
    expect(view.activity.map((a: { action: string }) => a.action)).toEqual(['user.role_changed']);
  });
});
