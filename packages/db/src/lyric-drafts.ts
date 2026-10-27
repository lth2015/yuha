import { execute, newId, query, queryOne, withTx } from './pool.js';

/**
 * Counting lyric drafts (migration 0022): no credit pays for them, so each
 * account gets a set number in any 24 hours.
 *
 * Claims are serialised per account by locking its `users` row, then counted
 * and written in the same transaction, so concurrent requests get exactly the
 * remaining number and no more or fewer. (Inserting first and counting after
 * could not overrun the cap, but under contention every request saw the
 * others' rows and gave its own back: 8 at once against 3 left let 1 through.)
 */
export type LyricDraftStatus = 'pending' | 'ok' | 'refused' | 'failed';

/**
 * Claims one draft for `userId`. Returns its id and how many remain after it,
 * or null when the account has used its `limit` in the last 24 hours.
 */
export async function claimLyricDraft(userId: string, limit: number): Promise<{ id: string; remaining: number } | null> {
  return withTx(async (tx) => {
    await query(`SELECT id FROM users WHERE id = ? FOR UPDATE`, [userId], tx);
    const row = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM lyric_drafts WHERE user_id = ? AND created_at > NOW(3) - INTERVAL 24 HOUR`,
      [userId],
      tx,
    );
    const used = Number(row?.n ?? 0);
    if (used >= limit) return null;
    const id = newId();
    await execute(`INSERT INTO lyric_drafts (id, user_id, status) VALUES (?, ?, 'pending')`, [id, userId], tx);
    return { id, remaining: limit - used - 1 };
  });
}

export async function settleLyricDraft(id: string, status: Exclude<LyricDraftStatus, 'pending'>): Promise<void> {
  await execute(`UPDATE lyric_drafts SET status = ? WHERE id = ?`, [status, id]);
}
