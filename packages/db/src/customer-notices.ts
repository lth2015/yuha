import { execute, newId } from './pool.js';

/**
 * Claims the right to send one customer notice (migration 0024).
 *
 * True for the first claim of (kind, ref), false for every later one. Read
 * from INSERT IGNORE's affected rows, which reports 0 for a skipped row even
 * under mysql2's CLIENT_FOUND_ROWS (CLAUDE.md, "Verifying"); an ON DUPLICATE
 * KEY UPDATE would report 1 either way and send every redelivery.
 */
export async function claimCustomerNotice(params: { userId: string; kind: string; ref: string }): Promise<boolean> {
  const res = await execute(
    `INSERT IGNORE INTO customer_notices (id, user_id, kind, ref) VALUES (?, ?, ?, ?)`,
    [newId(), params.userId, params.kind, params.ref.slice(0, 191)],
  );
  return res.affectedRows === 1;
}

/**
 * Gives a claim back when the notice did not go out, so the next attempt can
 * send it. A claim taken and then not delivered was a notice lost for good:
 * every later event for the same refund found it claimed (review S2).
 */
export async function releaseCustomerNotice(params: { userId: string; kind: string; ref: string }): Promise<void> {
  await execute(`DELETE FROM customer_notices WHERE user_id = ? AND kind = ? AND ref = ?`, [
    params.userId,
    params.kind,
    params.ref.slice(0, 191),
  ]);
}
