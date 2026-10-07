import { AppError } from '@yuha/contracts';
import { insertOrder, purchaseActivitySince, type OrderRow, type Tx } from '@yuha/db';
import type { AppContext } from '../context.js';

/**
 * How much one account may buy in a rolling day.
 *
 * `docs/FRAUD_PREVENTION.md` ticked "velocity / amount limits per account" on
 * the strength of the generation and export rate limits, and then said plainly
 * in its own "what is still not true" section that those protect capacity
 * rather than money: "a stolen card used to buy forty DROP packs in an hour
 * would meet no limit here." This is that limit. It is on the channel that
 * carries every payment today.
 *
 * Two numbers, because the two abuses look different:
 *
 *   - A stolen card that WORKS is value. Few orders, each one real money.
 *   - Card testing is count. Many attempts, almost none of them paid, so a
 *     value cap never sees it.
 *
 * It is a speed limit and not a judgement: the message the customer gets says
 * so, and the defaults are set where the damage is bounded rather than where
 * abuse begins, because a cap that stops a genuine purchase is its own kind of
 * failure. An operator who needs to let a real customer through can raise the
 * configuration, or issue credits directly from the console — which does not
 * create an order and is therefore not capped, deliberately: that path has an
 * audit row and a person behind it.
 */
export async function assertWithinPurchaseCap(
  ctx: AppContext,
  params: { userId: string; amountMinor: number; currency: string },
  tx?: Tx,
): Promise<void> {
  const valueCap = ctx.config.PURCHASE_CAP_JPY_PER_DAY;
  const countCap = ctx.config.PURCHASE_CAP_ORDERS_PER_DAY;
  if (valueCap <= 0 && countCap <= 0) return;

  const since = new Date(Date.now() - 86_400_000);
  /*
   * Read inside the caller's transaction when there is one, so the count the
   * cap decides on is the count the order will be inserted against.
   */
  const activity = await purchaseActivitySince({ userId: params.userId, since }, tx);

  if (countCap > 0 && activity.createdCount >= countCap) {
    /*
     * Counted on orders STARTED, not orders paid. Card testing produces a
     * hundred declines and nothing paid, which a value cap cannot see at all.
     * The cost of counting attempts is that an indecisive customer who opened
     * checkout many times is also stopped, which is why the default is twenty
     * and not three.
     */
    throw new AppError('PURCHASE_CAP_REACHED', 'too many orders started in the last day', {
      limit: countCap,
      window: 'rolling_24h',
    });
  }

  if (valueCap <= 0) return;

  /*
   * A currency the cap cannot evaluate is a refusal, not an exemption.
   *
   * The catalogue is JPY and has always been. If a second currency appeared,
   * summing only the JPY rows would let an account buy past a yen cap by
   * switching currency — and silently, which is the shape of every defect this
   * project has had to find the hard way. Refusing fails closed, changes
   * nothing today, and makes adding a currency a decision somebody has to
   * make rather than one they make by accident.
   */
  if (params.currency !== 'jpy' || activity.paidOtherCurrencyCount > 0) {
    throw new AppError(
      'PURCHASE_CAP_REACHED',
      'the purchase cap is defined in JPY and this account has activity in another currency',
      { currency: params.currency },
    );
  }

  if (activity.paidJpyMinor + params.amountMinor > valueCap) {
    throw new AppError('PURCHASE_CAP_REACHED', 'this purchase would pass the daily limit', {
      limitMinor: valueCap,
      alreadyMinor: activity.paidJpyMinor,
      window: 'rolling_24h',
    });
  }
}

/**
 * The only way the API creates an order.
 *
 * Three call sites created orders — card checkout, licence checkout, and the
 * stablecoin quote — and a cap applied to two of three is a bypass, not a cap.
 * `tests/purchase-cap.test.ts` holds a scripted invariant over the source:
 * `insertOrder` may be called from this file and nowhere else in `apps/api`,
 * so a fourth purchase path cannot quietly skip the limit. Eyeballing has
 * never caught that shape here; a grep has, five times.
 */
export async function createPurchaseOrder(
  ctx: AppContext,
  params: Parameters<typeof insertOrder>[0],
  tx?: Tx,
): Promise<OrderRow> {
  await assertWithinPurchaseCap(
    ctx,
    {
      userId: params.userId,
      amountMinor: params.amountMinor,
      currency: params.currency ?? 'jpy',
    },
    tx,
  );
  return insertOrder(params, tx);
}
