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
