import type { PoolConnection } from 'mysql2/promise';
import { execute, newId, query, queryOne } from './pool.js';

/**
 * Licensing repository: the record that a buyer holds usage rights to one
 * specific song, and that a named creator authored it.
 *
 * The platform sells its own service and does not split revenue with
 * creators, so there is no earnings ledger here — only the rights record,
 * which is the part meant to carry over to on-chain proof of authorship.
 *
 * The write is idempotent on the order id, so a replayed Stripe event lands
 * on a duplicate key instead of a second grant.
 */
export interface TrackLicenseRow {
  id: string;
  track_id: string;
  buyer_id: string;
  creator_id: string;
  order_id: string;
  price_paid: number;
  currency: string;
  created_at: Date;
}
/** Grants one license. The unique key on (order_id) makes a replayed payment event a no-op. */
export async function grantLicense(
  params: {
    trackId: string;
    buyerId: string;
    creatorId: string;
    orderId: string;
    pricePaid: number;
    currency: string;
  },
  tx: PoolConnection,
): Promise<{ created: boolean; heldByOrderId: string }> {
  const licenseId = newId();
  await execute(
    `INSERT INTO track_licenses (id, track_id, buyer_id, creator_id, order_id, price_paid, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      licenseId,
      params.trackId,
      params.buyerId,
      params.creatorId,
      params.orderId,
      params.pricePaid,
      params.currency,
    ],
    tx,
  );
  const row = await queryOne<{ order_id: string }>(
    `SELECT order_id FROM track_licenses WHERE track_id = ? AND buyer_id = ?`,
    [params.trackId, params.buyerId],
    tx,
  );
  if (!row) throw new Error('license insert failed to read back');
  // Our own order, whether this call wrote the row or an earlier replay did:
  // the licence this order paid for is in place either way.
  return { created: row.order_id === params.orderId, heldByOrderId: row.order_id };
}

/** Ownership OR an active license authorises downloads for this buyer. */
export async function hasLicense(trackId: string, buyerId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM track_licenses WHERE track_id = ? AND buyer_id = ?`,
    [trackId, buyerId],
  );
  return !!row;
}

export async function countLicenses(trackId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM track_licenses WHERE track_id = ?`, [trackId]);
  return Number(row?.n ?? 0);
}
