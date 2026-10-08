/**
 * Where a checkout can send the payer afterwards.
 *
 * `POST /v1/checkout` accepts `successPath` and `cancelPath`, the schema said
 * `z.string().max(200)` and nothing else, and the service pasted them onto the
 * web origin:
 *
 *   `${PUBLIC_WEB_URL}${successPath}` with "@evil.example/"
 *     → https://yuha.studio@evil.example/   host: evil.example
 *   with ".evil.example"
 *     → https://yuha.studio.evil.example/   host: yuha.studio.evil.example
 *
 * No environment's `publicWebUrl` has a trailing slash, so `@` reads as
 * userinfo and a leading dot extends the hostname. The result is a genuine
 * `checkout.stripe.com` link, for the real account, that returns the payer to
 * somebody else's host — phishing with our own payment page as the lure, and
 * a brand problem either way. It is not CSRF: the attacker spends their own
 * account to mint the link, which costs them nothing and makes the link real.
 *
 * `apps/web/src/lib/paths.ts` has had `safeInternalPath` since the `next`
 * parameter was added. A guard in the browser on a value the browser supplies
 * is not a guard.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedPaymentsAdapter } from '@yuha/providers';
import { safeInternalPath, internalUrl } from '../apps/api/src/internal-path.js';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let user: TestUser;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
  user = await h.createUser({ email: 'redirect-probe@example.test' });
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const WEB = 'http://localhost:5173';

describe('a path the client supplies', () => {
  it('is accepted when it is a path', () => {
    expect(safeInternalPath('/checkout/complete')).toBe('/checkout/complete');
    expect(safeInternalPath('/pricing')).toBe('/pricing');
  });

  it.each([
    ['@evil.example/', 'userinfo — the host becomes evil.example'],
    ['.evil.example', 'a hostname suffix — yuha.studio.evil.example'],
    ['//evil.example', 'protocol-relative'],
    ['/\\evil.example', 'protocol-relative, the other slash'],
    ['https://evil.example', 'an absolute url'],
    ['evil', 'not a path at all'],
    ['/ok?injected=1', 'a query, which would collide with ours'],
    ['/ok#frag', 'a fragment, which would swallow ours'],
    ['/ok\nX-Injected: 1', 'a newline'],
    ['/ok\u0000', 'a NUL'],
  ])('refuses %o (%s)', (value) => {
    expect(safeInternalPath(value)).toBeNull();
  });

  it('never produces a URL on another origin, whatever it is given', () => {
    // The belt to the braces: even if something above were let through, the
    // result is checked against the origin it was built on.
    for (const value of ['@evil.example/', '.evil.example', '//evil.example', 'https://evil.example']) {
      expect(new URL(internalUrl(WEB, value, '/pricing')).origin).toBe(new URL(WEB).origin);
    }
  });
});

describe('the checkout session it builds', () => {
  const checkout = (body: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: '/v1/checkout',
      headers: user.authHeader,
      payload: body as never,
    });

  it('returns the payer to our own origin when asked to do otherwise', async () => {
    const res = await checkout({
      priceKey: 'drop_5',
      idempotencyKey: 'redirect-probe-1',
      successPath: '@evil.example/',
      cancelPath: '//evil.example',
    });
    expect(res.statusCode).toBe(200);

    const sim = h.ctx.payments as SimulatedPaymentsAdapter;
    const sessionId = new URL(res.json().checkoutUrl).searchParams.get('session_id')!;
    const session = sim.sessionFor(sessionId);
    expect(session, 'the simulated adapter did not record the session').toBeTruthy();

    for (const url of [session!.successUrl, session!.cancelUrl]) {
      expect(new URL(url).origin, `${url} left our origin`).toBe(new URL(WEB).origin);
    }
    // And the order id is still carried, which is what the success page reads.
    expect(new URL(session!.successUrl).searchParams.get('order_id')).toBe(res.json().orderId);
  });

  it('still honours a genuine path', async () => {
    const res = await checkout({
      priceKey: 'drop_5',
      idempotencyKey: 'redirect-probe-2',
      successPath: '/checkout/thanks',
    });
    const sim = h.ctx.payments as SimulatedPaymentsAdapter;
    const sessionId = new URL(res.json().checkoutUrl).searchParams.get('session_id')!;
    expect(new URL(sim.sessionFor(sessionId)!.successUrl).pathname).toBe('/checkout/thanks');
  });
});
