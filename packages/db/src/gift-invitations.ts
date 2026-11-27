import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execute, query, queryOne } from './pool.js';

/** Music Gift Invitation rows (migration 0041). The token itself is never stored. */
export interface GiftInvitationRow {
  id: string;
  track_id: string;
  owner_id: string;
  recipient_name: string | null;
  sender_name: string | null;
  message: string | null;
  theme: 'warm' | 'romantic' | 'celebration';
  status: 'active' | 'revoked';
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const giftTokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** 32 random bytes, base64url: 43 characters, never derived from any id. */
function newGiftToken(): string {
  return randomBytes(32).toString('base64url');
}

const COLUMNS = `id, track_id, owner_id, recipient_name, sender_name, message, theme, status, created_at, updated_at, expires_at, revoked_at`;

export async function insertGiftInvitation(params: {
  trackId: string;
  ownerId: string;
  recipientName: string;
  senderName: string;
  message: string;
  theme: GiftInvitationRow['theme'];
}): Promise<{ row: GiftInvitationRow; token: string }> {
  const id = randomUUID();
  const token = newGiftToken();
  await execute(
    `INSERT INTO gift_invitations (id, track_id, owner_id, recipient_name, sender_name, message, theme, token_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, params.trackId, params.ownerId, params.recipientName, params.senderName || null, params.message || null, params.theme, giftTokenHash(token)],
  );
  return { row: (await getGiftInvitation(id))!, token };
}

async function getGiftInvitation(id: string): Promise<GiftInvitationRow | null> {
  return (await queryOne<GiftInvitationRow>(`SELECT ${COLUMNS} FROM gift_invitations WHERE id = ?`, [id])) ?? null;
}

export async function listGiftInvitations(trackId: string, ownerId: string): Promise<GiftInvitationRow[]> {
  return query<GiftInvitationRow>(
    `SELECT ${COLUMNS} FROM gift_invitations WHERE track_id = ? AND owner_id = ? ORDER BY created_at DESC`,
    [trackId, ownerId],
  );
}

/**
 * The invitation a token opens, with its song — only while the invitation
 * stands and the song is deliverable and not deleted. Anything else is null,
 * whichever of those it was.
 */
export async function openGiftInvitation(token: string): Promise<
  | (GiftInvitationRow & {
      title: string;
      duration_ms: number;
      cover_seed: number;
      styles: string | string[] | null;
      vocal_mode: 'instrumental' | 'with_vocals';
      lyrics: string | null;
      lyric_timings: unknown;
    })
  | null
> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await queryOne<GiftInvitationRow & { title: string; duration_ms: number; cover_seed: number; styles: string | string[] | null; vocal_mode: 'instrumental' | 'with_vocals'; lyrics: string | null; lyric_timings: unknown }>(
    `SELECT g.id, g.track_id, g.owner_id, g.recipient_name, g.sender_name, g.message, g.theme, g.status, g.created_at, g.updated_at, g.expires_at, g.revoked_at,
            t.title, t.duration_ms, t.cover_seed, t.styles, t.vocal_mode, t.lyrics, t.lyric_timings
       FROM gift_invitations g JOIN tracks t ON t.id = g.track_id
      WHERE g.token_hash = ? AND g.status = 'active'
        AND (g.expires_at IS NULL OR g.expires_at > UTC_TIMESTAMP(3))
        AND t.deleted_at IS NULL AND t.state = 'deliverable'`,
    [giftTokenHash(token)],
  );
  return row ?? null;
}

/** Changes the words or theme of a standing invitation; false when it is not the owner's or was revoked. */
export async function updateGiftInvitation(
  id: string,
  ownerId: string,
  patch: { recipientName?: string; senderName?: string; message?: string; theme?: GiftInvitationRow['theme'] },
): Promise<'updated' | 'not_found' | 'revoked'> {
  const row = await getGiftInvitation(id);
  if (!row || row.owner_id !== ownerId) return 'not_found';
  if (row.status !== 'active') return 'revoked';
  await execute(
    `UPDATE gift_invitations
        SET recipient_name = COALESCE(?, recipient_name), sender_name = ?, message = ?, theme = COALESCE(?, theme),
            updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND owner_id = ? AND status = 'active'`,
    [
      patch.recipientName ?? null,
      patch.senderName !== undefined ? patch.senderName || null : row.sender_name,
      patch.message !== undefined ? patch.message || null : row.message,
      patch.theme ?? null,
      id,
      ownerId,
    ],
  );
  return 'updated';
}

export async function revokeGiftInvitation(id: string, ownerId: string): Promise<boolean> {
  const row = await getGiftInvitation(id);
  if (!row || row.owner_id !== ownerId) return false;
  await execute(
    `UPDATE gift_invitations SET status = 'revoked', revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(3)), updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND owner_id = ?`,
    [id, ownerId],
  );
  return true;
}

/** A song deleted, or an account closed: every invitation to it stops and its words go. */
export async function revokeGiftInvitationsOf(where: { trackId?: string; ownerId?: string }): Promise<void> {
  const [col, val] = where.trackId ? ['track_id', where.trackId] : ['owner_id', where.ownerId!];
  await execute(
    `UPDATE gift_invitations
        SET status = 'revoked', revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(3)),
            recipient_name = NULL, sender_name = NULL, message = NULL, updated_at = UTC_TIMESTAMP(3)
      WHERE ${col} = ?`,
    [val],
  );
}
