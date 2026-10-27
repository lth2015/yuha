import { execute, newId, queryOne } from './pool.js';

/**
 * Counting lyric drafts (migration 0022): no credit pays for them, so each
 * account gets a set number in any 24 hours.
 *
 * The row is written before the text model is called and then counted with
 * itself included, so two requests racing for the last draft cannot both see
 * room: the later one counts both rows and gives its own back.
 */
export type LyricDraftStatus = 'pending' | 'ok' | 'refused' | 'failed';

/**
 * Claims one draft for `userId`. Returns its id and how many remain after it,
 * or null when the account has used its `limit` in the last 24 hours.
 */
export async function claimLyricDraft(userId: string, limit: number): Promise<{ id: string; remaining: number } | null> {
  const id = newId();
  await execute(`INSERT INTO lyric_drafts (id, user_id, status) VALUES (?, ?, 'pending')`, [id, userId]);
  const used = await lyricDraftsUsed(userId);
  if (used > limit) {
    await execute(`DELETE FROM lyric_drafts WHERE id = ?`, [id]);
    return null;
  }
  return { id, remaining: limit - used };
}

export async function settleLyricDraft(id: string, status: Exclude<LyricDraftStatus, 'pending'>): Promise<void> {
  await execute(`UPDATE lyric_drafts SET status = ? WHERE id = ?`, [status, id]);
}

/** Drafts this account asked for in the last 24 hours, whatever came of them: each was a paid call. */
async function lyricDraftsUsed(userId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM lyric_drafts WHERE user_id = ? AND created_at > NOW(3) - INTERVAL 24 HOUR`,
    [userId],
  );
  return Number(row?.n ?? 0);
}
