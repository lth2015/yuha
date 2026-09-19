import type { PoolConnection } from 'mysql2/promise';
import { execute, newId, query, queryOne } from './pool.js';

/**
 * Market monetization repository: licenses bought by other users and the
 * creator-earnings accrual that follows each sale.
 *
 * Both writes are idempotent on the order id, so a replayed Stripe event
 * lands on a duplicate key instead of a second grant or a second payout row.
 */
export interface TrackLicenseRow {
  id: string;
  track_id: string;
  buyer_id: string;
  creator_id: string;
  order_id: string;
  price_paid: number;
  currency: string;
  creator_share_rate: string;
  created_at: Date;
}

export interface CreatorEarningRow {
  id: string;
  creator_id: string;
  track_id: string;
  license_id: string;
  order_id: string;
  gross_minor: number;
  amount_minor: number;
  currency: string;
  status: 'pending' | 'cleared' | 'paid';
  created_at: Date;
  cleared_at: Date | null;
  paid_at: Date | null;
}

/**
 * Grants one license + its earnings row in a single transaction. The unique
 * keys on (order_id) make replayed payment events a no-op.
 */
export async function grantLicenseWithEarnings(
  params: {
    trackId: string;
    buyerId: string;
    creatorId: string;
    orderId: string;
    pricePaid: number;
    currency: string;
    /** 0..1, frozen into the license row at sale time. */
    creatorShareRate: number;
  },
  tx: PoolConnection,
): Promise<{ created: boolean }> {
  const licenseId = newId();
  const res = await execute(
    `INSERT INTO track_licenses (id, track_id, buyer_id, creator_id, order_id, price_paid, currency, creator_share_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      licenseId,
      params.trackId,
      params.buyerId,
      params.creatorId,
      params.orderId,
      params.pricePaid,
      params.currency,
      params.creatorShareRate.toFixed(4),
    ],
    tx,
  );
  if (res.affectedRows === 0) return { created: false };

  await execute(
    `INSERT INTO creator_earnings (id, creator_id, track_id, license_id, order_id, gross_minor, amount_minor, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      newId(),
      params.creatorId,
      params.trackId,
      licenseId,
      params.orderId,
      params.pricePaid,
      Math.round(params.pricePaid * params.creatorShareRate),
      params.currency,
    ],
    tx,
  );
  return { created: true };
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

export interface EarningsSummary {
  totalMinor: number;
  pendingMinor: number;
  clearedMinor: number;
  paidMinor: number;
  sales: number;
  perTrack: Array<{ trackId: string; title: string; sales: number; amountMinor: number }>;
}

/** The creator's own earnings view, joined to titles for the dashboard. */
export async function earningsForCreator(creatorId: string): Promise<EarningsSummary> {
  const rows = await query<{ status: string; amount: number; track_id: string; title: string }>(
    `SELECT e.status, e.amount_minor AS amount, e.track_id, t.title
       FROM creator_earnings e
       JOIN tracks t ON t.id = e.track_id
      WHERE e.creator_id = ?
      ORDER BY e.created_at DESC`,
    [creatorId],
  );
  const summary: EarningsSummary = {
    totalMinor: 0,
    pendingMinor: 0,
    clearedMinor: 0,
    paidMinor: 0,
    sales: rows.length,
    perTrack: [],
  };
  const byTrack = new Map<string, { sales: number; amountMinor: number }>();
  for (const row of rows) {
    const amount = Number(row.amount);
    summary.totalMinor += amount;
    if (row.status === 'pending') summary.pendingMinor += amount;
    if (row.status === 'cleared') summary.clearedMinor += amount;
    if (row.status === 'paid') summary.paidMinor += amount;
    const agg = byTrack.get(row.track_id) ?? { sales: 0, amountMinor: 0 };
    agg.sales += 1;
    agg.amountMinor += amount;
    byTrack.set(row.track_id, agg);
  }
  summary.perTrack = [...byTrack.entries()].map(([trackId, agg]) => ({
    trackId,
    title: rows.find((r) => r.track_id === trackId)!.title,
    ...agg,
  }));
  return summary;
}
