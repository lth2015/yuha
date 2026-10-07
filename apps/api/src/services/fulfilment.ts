import {
  getOrder,
  getProductVersion,
  grantLicense,
  grantUnits,
  markEntitlementGranted,
  withTx,
  type OrderRow,
  type Tx,
} from '@yuha/db';

/**
 * Handing over what a paid order bought.
 *
 * Extracted from the Stripe webhook handler so both payment channels run the
 * same code rather than two implementations that agree today. The uniqueness
 * that makes it exactly-once is on the business key and not on the event that
 * triggered it:
 *
 *   - credits: `entitlement_batches` is unique on (user, source, source_ref)
 *     with source_ref = the order id, taken under `lockUserEntitlements`
 *   - licence: `track_licenses` is unique on (track, buyer) AND on (order)
 *
 * That is what makes the §9 race safe. If a card payment and a stablecoin
 * payment both really settle for one order, this runs twice with the same
 * order id and hands over once; the second payment is then a duplicate to
 * refund, not a second delivery.
 */
export interface GrantResult {
  /**
   * False when the thing this order bought is already held, so nothing was
   * handed over and the order must NOT be marked delivered.
   *
   * `grantLicense` has always reported this — `track_licenses` is unique on
   * (track, buyer) — and this function discarded it and called
   * `markEntitlementGranted` regardless. Two orders for one song could both be
   * created before either was paid (the pre-flight `hasLicense` check is not a
   * lock), and paying both took the money twice, delivered one licence, and
   * left BOTH orders reading as delivered — which also hid the second from the
   * sweep that looks for paid orders with nothing granted.
   */
  delivered: boolean;
  reason?: 'already_licensed';
}

export async function grantEntitlementForOrder(order: OrderRow, tx: Tx): Promise<GrantResult> {
  const product = await getProductVersion(order.price_key, order.price_version, tx);
  if (!product) throw new Error(`unknown product version ${order.price_key}@${order.price_version}`);

  // A subscription's first period is granted by invoice.paid, keyed on the
  // invoice, so a checkout or a settlement must not also grant one (PAY-06).
  if (product.price_key === 'market_license') {
    // Market sale: no credits — the buyer receives a per-track license and
    // the authorship record is written, both idempotent on the order id.
    const trackId = (order.metadata['track_id'] as string | undefined) ?? null;
    const creatorId = (order.metadata['creator_id'] as string | undefined) ?? null;
    if (!trackId || !creatorId) {
      throw new Error(`market license order ${order.id} is missing track/creator metadata`);
    }
    const { created } = await grantLicense(
      {
        trackId,
        buyerId: order.user_id,
        creatorId,
        orderId: order.id,
        pricePaid: order.amount_minor,
        currency: order.currency,
      },
      tx,
    );
    if (!created) {
      // Not an error and not a delivery. Reported up, where the caller records
      // that a refund is owed and leaves the order visibly undelivered.
      return { delivered: false, reason: 'already_licensed' };
    }
    await markEntitlementGranted(order.id, tx);
  } else if (product.kind === 'one_time') {
    await grantUnits(
      {
        userId: order.user_id,
        source: 'one_time_order',
        sourceRef: order.id,
        units: product.units,
        productKey: product.price_key,
        priceVersion: product.version,
        expiresAt: product.validity_days ? new Date(Date.now() + product.validity_days * 86400_000) : null,
        reason: `order_paid:${order.id}`,
      },
      tx,
    );
    await markEntitlementGranted(order.id, tx);
  }
  return { delivered: true };
}

export type FulfilResult = 'delivered' | 'nothing_to_do' | 'duplicate_entitlement';

/**
 * Hands over what a paid order bought, re-reading the order inside the
 * transaction that grants.
 *
 * The re-read is the point, and it is why both channels and the recovery sweep
 * now go through here. The sweep used to trust the row it had listed: with up
 * to fifty orders in a batch, a refund arriving mid-sweep could set an order
 * to `refunded` — revoking nothing, because the grant it was selected for had
 * never landed — and the sweep then granted credits against a refunded order,
 * with nothing left to take them back.
 *
 * Safe to call repeatedly, which is what makes a crash between confirming a
 * payment and delivering it recoverable.
 */
export async function fulfilPaidOrder(orderId: string): Promise<FulfilResult> {
  return withTx(async (tx) => {
    const order = await getOrder(orderId, tx);
    if (!order || order.status !== 'paid' || order.entitlement_granted_at) return 'nothing_to_do';
    const result = await grantEntitlementForOrder(order, tx);
    return result.delivered ? 'delivered' : 'duplicate_entitlement';
  });
}
