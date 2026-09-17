import { createHash, randomBytes } from 'node:crypto';
import { execute, queryOne } from './pool.js';

/**
 * One-time codes that end the Google OAuth redirect.
 *
 * The SPA never receives a token in a URL fragment (where it can leak into
 * browser history or referrers); it receives a 60-second code and exchanges it
 * over POST. Codes are stored hashed and are consumed atomically, so a replay
 * of the same code is a hard failure rather than a second session.
 */
const TTL_SECONDS = 60;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function issueAuthCode(
  params: { userId: string },
): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
  await execute(
    `INSERT INTO auth_codes (id, code_hash, user_id, expires_at) VALUES (UUID(), ?, ?, ?)`,
    [hashCode(code), params.userId, expiresAt],
  );
  return { code, expiresAt };
}

/**
 * Consumes a code exactly once. The `used_at IS NULL` guard is in the UPDATE
 * itself, so two concurrent exchanges cannot both succeed.
 */
export async function consumeAuthCode(code: string): Promise<{ userId: string } | null> {
  if (!code || code.length > 256) return null;
  const res = await execute(
    `UPDATE auth_codes
        SET used_at = UTC_TIMESTAMP(3)
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP(3)`,
    [hashCode(code)],
  );
  if (res.affectedRows === 0) return null;
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM auth_codes WHERE code_hash = ?`,
    [hashCode(code)],
  );
  return row ? { userId: row.user_id } : null;
}
