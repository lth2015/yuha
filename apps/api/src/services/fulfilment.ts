import {
  getProductVersion,
  grantLicense,
  grantUnits,
  markEntitlementGranted,
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
export async function grantEntitlementForOrder(order: OrderRow, tx: Tx): Promise<void> {
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
    await grantLicense(
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
}
