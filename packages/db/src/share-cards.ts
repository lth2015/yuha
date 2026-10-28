import type { PoolConnection } from 'mysql2/promise';
import { execute, queryOne } from './pool.js';

/**
 * A song's link-preview image (migration 0026, docs/GIFT_AND_SHARE_SPEC.md).
 * One per song; uploading again replaces it in place under the same key.
 */
export interface ShareCardRow {
  track_id: string;
  owner_id: string;
  storage_key: string;
  byte_size: number;
  sha256: string;
  updated_at: Date;
}

export async function getShareCard(trackId: string): Promise<ShareCardRow | null> {
  return (await queryOne<ShareCardRow>(`SELECT * FROM share_cards WHERE track_id = ?`, [trackId])) ?? null;
}

export async function upsertShareCard(
  params: { trackId: string; ownerId: string; storageKey: string; byteSize: number; sha256: string },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `INSERT INTO share_cards (track_id, owner_id, storage_key, byte_size, sha256)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE storage_key = VALUES(storage_key), byte_size = VALUES(byte_size),
                             sha256 = VALUES(sha256), updated_at = UTC_TIMESTAMP(3)`,
    [params.trackId, params.ownerId, params.storageKey, params.byteSize, params.sha256],
    tx,
  );
}

export async function forgetShareCard(trackId: string): Promise<void> {
  await execute(`DELETE FROM share_cards WHERE track_id = ?`, [trackId]);
}
