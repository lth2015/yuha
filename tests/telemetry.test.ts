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
  await query(`DELETE FROM analytics_events WHERE name = 'client_error'`);
});
afterAll(async () => {
  await h.close();
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
