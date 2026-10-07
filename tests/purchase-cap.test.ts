/**
 * The per-account purchase cap, and the invariant that keeps it unbypassable.
 *
 * `docs/FRAUD_PREVENTION.md` ticked "velocity / amount limits per account" on
 * the strength of the generation and export rate limits, and said plainly in
 * its own "what is still not true" section that those protect capacity rather
 * than money: "a stolen card used to buy forty DROP packs in an hour would
 * meet no limit here." These are the tests for that limit.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query, withTx } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `198.18.0.${(callNo++ % 200) + 10}` });

beforeAll(async () => {
  h = await createHarness({
    // Low enough to reach in a test, and both caps on: the defaults are
    // ¥50,000 and twenty orders, which a test would have to grind towards.
    PURCHASE_CAP_JPY_PER_DAY: '2000',
    PURCHASE_CAP_ORDERS_PER_DAY: '5',
  });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await teardown();
});

const checkout = (user: TestUser, key: string, priceKey = 'drop_5') =>
  h.app.inject({
    method: 'POST',
    url: '/v1/checkout',
    headers: { ...user.authHeader, ...freshIp() },
    payload: { priceKey, idempotencyKey: key } as never,
  });

/** Marks an order paid the way a settled payment does, without a webhook. */
async function markPaid(orderId: string): Promise<void> {
  await query(`UPDATE orders SET status = 'paid', paid_at = UTC_TIMESTAMP(3) WHERE id = ?`, [orderId]);
}

describe('money already spent in the last day', () => {
  it('refuses the purchase that would pass the limit, and says why', async () => {
    const user = await h.createUser({ email: 'cap-value@example.jp' });

    // ¥980 twice is ¥1,960, inside the ¥2,000 cap.
    for (const key of ['cap-value-1', 'cap-value-2']) {
      const res = await checkout(user, key);
      expect(res.statusCode, res.body).toBe(200);
      await markPaid(res.json().orderId as string);
    }

    const third = await checkout(user, 'cap-value-3');
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('PURCHASE_CAP_REACHED');
    // The detail says what the limit is and how much is already spent, so
    // support can answer "why can I not buy this" without reading the code.
    expect(third.json().error.details).toMatchObject({ limitMinor: 2000, alreadyMinor: 1960 });

    // And no order row was created for the refused purchase.
    const orders = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE user_id = ?`, [user.id]);
    expect(Number(orders[0]!.n)).toBe(2);
  });

  it('counts money that moved, not orders that were started', async () => {
    // Two unpaid orders are not spend. A cap that counted them would stop a
    // customer who abandoned checkout twice.
    const user = await h.createUser({ email: 'cap-unpaid@example.jp' });
    for (const key of ['cap-unpaid-1', 'cap-unpaid-2']) {
      expect((await checkout(user, key)).statusCode).toBe(200);
    }
    expect((await checkout(user, 'cap-unpaid-3')).statusCode).toBe(200);
  });

  it('is per account, so one customer cannot spend another’s allowance', async () => {
    const a = await h.createUser({ email: 'cap-a@example.jp' });
    const b = await h.createUser({ email: 'cap-b@example.jp' });
    for (const key of ['cap-acct-a-1', 'cap-acct-a-2']) {
      const res = await checkout(a, key);
      await markPaid(res.json().orderId as string);
    }
    expect((await checkout(a, 'cap-acct-a-3')).statusCode).toBe(429);
    expect((await checkout(b, 'cap-acct-b-1')).statusCode).toBe(200);
  });

  it('forgets what fell out of the window', async () => {
    /*
     * A rolling day. The alternative — a calendar day — is a cap with a known
     * gap in it: an attacker buys to the limit at 23:50 and again at 00:01.
     */
    const user = await h.createUser({ email: 'cap-window@example.jp' });
    for (const key of ['cap-window-1', 'cap-window-2']) {
      const res = await checkout(user, key);
      await markPaid(res.json().orderId as string);
    }
    expect((await checkout(user, 'cap-window-3')).statusCode).toBe(429);

    // Age the two payments past the window.
    await query(
      `UPDATE orders SET paid_at = UTC_TIMESTAMP(3) - INTERVAL 25 HOUR,
                         created_at = UTC_TIMESTAMP(3) - INTERVAL 25 HOUR
        WHERE user_id = ?`,
      [user.id],
    );
    expect((await checkout(user, 'cap-window-4')).statusCode).toBe(200);
  });
});

describe('orders started in the last day', () => {
  it('is what catches card testing, where nothing is ever paid', async () => {
    /*
     * The abuse a value cap cannot see: a hundred attempts, almost all
     * declined, so no money ever moves and the sum stays at zero.
     */
    const user = await h.createUser({ email: 'cap-count@example.jp' });
    for (let i = 0; i < 5; i += 1) {
      expect((await checkout(user, `cap-count-${i}`)).statusCode, `attempt ${i}`).toBe(200);
    }
    const sixth = await checkout(user, 'cap-count-5');
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.details).toMatchObject({ limit: 5 });
  });

  it('does not count a replayed idempotency key, which creates no order', async () => {
    // A double-clicked buy button must not spend the allowance twice.
    const user = await h.createUser({ email: 'cap-replay@example.jp' });
    for (let i = 0; i < 4; i += 1) {
      expect((await checkout(user, `cap-replay-${i}`)).statusCode).toBe(200);
    }
    // The same key again, four times: same order, no new rows.
    for (let i = 0; i < 4; i += 1) {
      expect((await checkout(user, 'cap-replay-0')).statusCode).toBe(200);
    }
    const orders = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE user_id = ?`, [user.id]);
    expect(Number(orders[0]!.n)).toBe(4);
    // Still room for the fifth.
    expect((await checkout(user, 'cap-replay-4')).statusCode).toBe(200);
  });
});

describe('a cap that is switched off', () => {
  it('lets everything through, which is what a deployment with no card channel wants', async () => {
    const off = await createHarness({
      PURCHASE_CAP_JPY_PER_DAY: '0',
      PURCHASE_CAP_ORDERS_PER_DAY: '0',
    });
    try {
      const user = await off.createUser({ email: 'cap-off@example.jp' });
      for (let i = 0; i < 8; i += 1) {
        const res = await off.app.inject({
          method: 'POST',
          url: '/v1/checkout',
          headers: { ...user.authHeader, ...freshIp() },
          payload: { priceKey: 'drop_5', idempotencyKey: `cap-off-${i}` } as never,
        });
        expect(res.statusCode, `attempt ${i}`).toBe(200);
        await query(`UPDATE orders SET status = 'paid', paid_at = UTC_TIMESTAMP(3) WHERE id = ?`, [
          res.json().orderId as string,
        ]);
      }
    } finally {
      await off.app.close();
    }
  });
});

describe('a currency the cap cannot evaluate', () => {
  it('is refused rather than exempted', async () => {
    /*
     * The catalogue is JPY and has always been. If a second currency appeared,
     * summing only the JPY rows would let an account buy past a yen cap by
     * switching currency, silently — the shape of defect this project has had
     * to find the hard way five times. Failing closed changes nothing today
     * and makes adding a currency a decision somebody has to make.
     */
    const { assertWithinPurchaseCap } = await import('../apps/api/src/services/purchase-cap.js');
    const user = await h.createUser({ email: 'cap-usd@example.jp' });
    await expect(
      assertWithinPurchaseCap(h.ctx, { userId: user.id, amountMinor: 499, currency: 'usd' }),
    ).rejects.toThrow(/defined in JPY/);
  });

  it('is also refused when the ACCOUNT has paid in another currency', async () => {
    // The sum would otherwise be an undercount of what this account has spent.
    const { assertWithinPurchaseCap } = await import('../apps/api/src/services/purchase-cap.js');
    const user = await h.createUser({ email: 'cap-mixed@example.jp' });
    const res = await checkout(user, 'cap-mixed-1');
    const orderId = res.json().orderId as string;
    await query(
      `UPDATE orders SET status = 'paid', paid_at = UTC_TIMESTAMP(3), currency = 'usd' WHERE id = ?`,
      [orderId],
    );
    await expect(
      assertWithinPurchaseCap(h.ctx, { userId: user.id, amountMinor: 980, currency: 'jpy' }),
    ).rejects.toThrow(/another currency/);
  });
});

describe('every way to buy goes through the cap', () => {
  /**
   * A scripted invariant, because this is the shape that has bitten five
   * times: a rule applied at the call sites that existed when it was written,
   * and a sixth call site added later that quietly skips it.
   *
   * `insertOrder` may be called from `purchase-cap.ts` and nowhere else in
   * `apps/api`. A new purchase path has to go through the capped helper or
   * fail this test.
   */
  it('is enforced by the source, not by remembering', () => {
    const root = new URL('../apps/api/src', import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.ts$/.test(entry)) files.push(full);
      }
    };
    walk(root);

    const callers = files
      .filter((f) => /\binsertOrder\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));

    expect(callers).toEqual(['services/purchase-cap.ts']);
  });

  it('includes the stablecoin quote, which creates its own order', async () => {
    /*
     * The quote endpoint does not go through `/v1/checkout` at all — it
     * creates or reuses the order itself, because the card path creates the
     * order and the Stripe session together and there was no
     * order-without-a-session to quote against. A cap on the card channel
     * alone would have been a cap with a second door beside it.
     */
    const { createStablecoinQuote } = await import('../apps/api/src/services/stablecoin.js');
    const user = await h.createUser({ email: 'cap-sc@example.jp' });
    const wallet = '0x7777777777777777777777777777777777777777';
    await query(`INSERT INTO verified_wallets (user_id, chain_id, address) VALUES (?, 137, ?)`, [
      user.id,
      wallet,
    ]);

    // Spend the allowance on the card channel first.
    for (const key of ['cap-scquote-1', 'cap-scquote-2']) {
      const res = await checkout(user, key);
      await markPaid(res.json().orderId as string);
    }

    const { seedScanCursor, verifiedChainStub } = await import('./helpers/harness.js');
    await seedScanCursor(1n);
    const ctx = {
      ...h.ctx,
      chain: verifiedChainStub(),
      config: {
        ...h.ctx.config,
        STABLECOIN_ENABLED: true,
        STABLECOIN_JPYC_ENABLED: true,
        STABLECOIN_RECEIVER_ADDRESS: '0x9999999999999999999999999999999999999999',
      },
    } as typeof h.ctx;

    await expect(
      createStablecoinQuote(ctx, {
        userId: user.id,
        priceKey: 'drop_5',
        idempotencyKey: 'cap-sc-quote',
        tokenKey: 'jpyc',
        payer: wallet,
      }),
    ).rejects.toThrow(/daily limit/);
  });

  it('does not stop the console from issuing credits, which creates no order', async () => {
    /*
     * Deliberately outside the cap: `compensate` is a support action with an
     * audit row and a person behind it, and it is the remedy when a real
     * customer has been stopped by the limit. A cap that also blocked the
     * remedy would leave nothing to do.
     */
    const user = await h.createUser({ email: 'cap-comp@example.jp' });
    for (let i = 0; i < 5; i += 1) await checkout(user, `cap-comp-${i}`);
    expect((await checkout(user, 'cap-comp-blocked')).statusCode).toBe(429);

    const { grantUnits } = await import('@yuha/db');
    await withTx(async (tx) => {
      await grantUnits(
        {
          userId: user.id,
          source: 'manual_adjustment',
          sourceRef: 'cap-comp-goodwill',
          units: 5,
          productKey: null,
          priceVersion: null,
          expiresAt: null,
          reason: 'make-good while the cap was in the way',
        },
        tx,
      );
    });
    const { balanceOf } = await import('./helpers/harness.js');
    expect((await balanceOf(user.id)).available).toBe(5);
  });
});
