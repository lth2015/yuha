/**
 * Crash reporting: the endpoint the error boundary calls.
 *
 * The boundary makes a render throw *look* handled, so nobody complains about
 * one any more. These tests exist because the thing that replaced the
 * complaint has to actually work, and has to stay safe to keep: the row it
 * writes carries no session, no user id and no URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
  await query(`DELETE FROM analytics_events WHERE name IN ('client_error', 'preview_10s')`);
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

function report(payload: unknown, headers: Record<string, string> = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/client-errors',
    headers,
    payload: payload as never,
  });
}

async function storedEvents() {
  return query<{ props: unknown; user_ref: string | null }>(
    `SELECT props, user_ref FROM analytics_events WHERE name = 'client_error'`,
  );
}

describe('client crash reporting', () => {
  it('records a crash without requiring a session', async () => {
    const res = await report({
      message: 'products.slice is not a function',
      route: '/pricing',
      component: 'Pricing',
      lang: 'ja',
    });

    // 202 and no body: the browser is mid-crash and has nothing to do with a
    // response. Unauthenticated on purpose — a crash on the sign-in screen is
    // the one most worth hearing about.
    expect(res.statusCode).toBe(202);

    const rows = await storedEvents();
    expect(rows).toHaveLength(1);
    const props = rows[0]!.props as Record<string, unknown>;
    expect(props.message).toBe('products.slice is not a function');
    expect(props.route).toBe('/pricing');
    expect(props.component).toBe('Pricing');
    expect(props.lang).toBe('ja');
  });

  it('stores no user reference, even when a caller sends a token', async () => {
    const user = await h.createUser({ credits: 1 });
    const res = await report(
      { message: 'boom', route: '/library' },
      { ...user.authHeader },
    );
    expect(res.statusCode).toBe(202);

    const rows = await storedEvents();
    expect(rows).toHaveLength(1);
    // §11.1: a crash groups by message and route, never by who hit it. The
    // browser does not attach the token either; this is the second line.
    expect(rows[0]!.user_ref).toBeNull();
    expect(JSON.stringify(rows[0]!.props)).not.toContain(user.id);
    expect(JSON.stringify(rows[0]!.props)).not.toContain(user.email);
  });

  it('rejects an empty message and an over-long one', async () => {
    expect((await report({ message: '', route: '/x' })).statusCode).toBe(400);
    expect((await report({ message: 'x'.repeat(301), route: '/x' })).statusCode).toBe(400);
    expect(await storedEvents()).toHaveLength(0);
  });

  it('accepts a report with no component and no language', async () => {
    // Both are optional: React cannot always produce a component stack, and a
    // visitor who has never chosen a language has none stored.
    const res = await report({ message: 'boom', route: '/' });
    expect(res.statusCode).toBe(202);
    const props = (await storedEvents())[0]!.props as Record<string, unknown>;
    expect(props.component).toBeNull();
    expect(props.lang).toBeNull();
  });
});

/**
 * Ten seconds heard.
 *
 * `reporting.ts` has queried `analytics_events` for `preview_10s` since the
 * activation metric was written, and `player.tsx` has detected the moment for
 * just as long. Nothing joined them, so the metric asked a question the
 * database could never answer. These tests hold the join together.
 */
describe('POST /v1/previews', () => {
  const previews = () =>
    query<{ props: unknown; user_ref: string | null }>(
      `SELECT props, user_ref FROM analytics_events WHERE name = 'preview_10s'`,
    );

  const trackId = '11111111-2222-4333-8444-555555555555';

  it('records who listened when the listener is signed in', async () => {
    const user = await h.createUser();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/previews',
      headers: user.authHeader,
      payload: { trackId } as never,
    });

    expect(res.statusCode).toBe(202);
    const rows = await previews();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_ref).toBe(user.id);
    expect(rows[0]!.props).toMatchObject({ track_id: trackId });
  });

  /*
   * The showcase plays to people with no account. Their listening is still
   * worth counting, and a null user_ref is the honest record of "somebody, we
   * do not know who" — the activation query asks what a registered user did in
   * their first day, so it simply will not see these, which is correct.
   */
  it('records a listener with no account, without inventing one', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/v1/previews', payload: { trackId } as never });

    expect(res.statusCode).toBe(202);
    const rows = await previews();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_ref).toBeNull();
  });

  it('refuses anything that is not a track id', async () => {
    for (const payload of [{}, { trackId: '' }, { trackId: 'not-a-uuid' }]) {
      const res = await h.app.inject({ method: 'POST', url: '/v1/previews', payload: payload as never });
      expect(res.statusCode).toBe(400);
    }
    expect(await previews()).toHaveLength(0);
  });

  /*
   * The body carries one id and nothing else. A listening event is the easiest
   * place in the product to start collecting more than the question needs —
   * position, dwell, device — so the shape is pinned here rather than left to
   * whoever edits the schema next.
   */
  it('stores the track id and nothing else about the listener', async () => {
    const user = await h.createUser();
    await h.app.inject({
      method: 'POST',
      url: '/v1/previews',
      headers: user.authHeader,
      payload: { trackId, positionSeconds: 42, userAgent: 'spy' } as never,
    });

    const props = (await previews())[0]!.props as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['track_id']);
  });
});
