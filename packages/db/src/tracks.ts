import type { PoolConnection } from 'mysql2/promise';
import type { AssetKind, AudioFormat, TrackState, Visibility, VocalMode } from '@loopscene/contracts';
import { execute, newId, query, queryOne } from './pool.js';

export interface TrackRow {
  id: string;
  owner_id: string;
  project_id: string;
  job_id: string;
  title: string;
  scene: string;
  mood: string | null;
  duration_ms: number;
  state: TrackState;
  suspended_reason: string | null;
  styles: string[] | null;
  lyrics: string | null;
  vocal_mode: VocalMode;
  visibility: Visibility;
  play_count: number;
  like_count: number;
  cover_seed: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/** Explore/libary cards want the creator's name next to the song. */
export type TrackWithArtist = TrackRow & { artist_name: string | null; artist_avatar: string | null };

const TRACK_COLUMNS = `
  id, owner_id, project_id, job_id, title, scene, mood, duration_ms, state,
  suspended_reason, styles, lyrics, vocal_mode, visibility, play_count, like_count,
  cover_seed, created_at, updated_at, deleted_at
`;

const TRACK_SELECT = `
  SELECT t.id, t.owner_id, t.project_id, t.job_id, t.title, t.scene, t.mood, t.duration_ms,
         t.state, t.suspended_reason, t.styles, t.lyrics, t.vocal_mode, t.visibility,
         t.play_count, t.like_count, t.cover_seed, t.created_at, t.updated_at, t.deleted_at,
         u.display_name AS artist_name, u.avatar_url AS artist_avatar
    FROM tracks t
    JOIN users u ON u.id = t.owner_id
`;

/**
 * MySQL JSON columns come back as strings; normalise once, here, so callers
 * always see a plain array.
 */
function normaliseRow<T>(row: T): T {
  const r = row as { styles?: unknown };
  if (typeof r.styles === 'string') {
    try {
      r.styles = JSON.parse(r.styles as string);
    } catch {
      r.styles = null;
    }
  }
  return row;
}

export async function insertTrack(
  params: {
    /** Supplied by the caller so the storage key can be derived before insert. */
    id?: string;
    ownerId: string;
    projectId: string;
    jobId: string;
    title: string;
    scene: string;
    mood?: string | null;
    durationMs: number;
    state?: TrackState;
    styles?: string[];
    lyrics?: string | null;
    vocalMode?: VocalMode;
    visibility?: Visibility;
    coverSeed?: number;
  },
  tx: PoolConnection,
): Promise<TrackRow> {
  const id = params.id ?? newId();
  // A retried delivery must not create a second track for the same job.
  await execute(
    `INSERT INTO tracks (id, owner_id, project_id, job_id, title, scene, mood, duration_ms, state,
                         styles, lyrics, vocal_mode, visibility, cover_seed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP(3)`,
    [
      id,
      params.ownerId,
      params.projectId,
      params.jobId,
      params.title,
      params.scene,
      params.mood ?? null,
      params.durationMs,
      params.state ?? 'processing',
      params.styles ? JSON.stringify(params.styles) : null,
      params.lyrics ?? null,
      params.vocalMode ?? 'instrumental',
      params.visibility ?? 'private',
      params.coverSeed ?? 0,
    ],
    tx,
  );
  return normaliseRow(
    (await queryOne<TrackRow>(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE job_id = ?`, [params.jobId], tx))!,
  );
}

export async function getTrackForUser(
  id: string,
  userId: string,
  tx?: PoolConnection,
): Promise<TrackRow | undefined> {
  const row = await queryOne<TrackRow>(
    `SELECT ${TRACK_COLUMNS} FROM tracks
      WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`,
    [id, userId],
    tx,
  );
  return row ? normaliseRow(row) : undefined;
}

export async function getTrack(id: string, tx?: PoolConnection): Promise<TrackRow | undefined> {
  const row = await queryOne<TrackRow>(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ?`, [id], tx);
  return row ? normaliseRow(row) : undefined;
}

/**
 * A public, deliverable song — the only track an anonymous reader may fetch.
 * Ownership checks for private tracks stay on `getTrackForUser` (SEC-01).
 */
export async function getPublicTrack(id: string): Promise<TrackWithArtist | undefined> {
  const row = await queryOne<TrackWithArtist>(
    `${TRACK_SELECT}
      WHERE t.id = ? AND t.visibility = 'public' AND t.state = 'deliverable'
        AND t.deleted_at IS NULL`,
    [id],
  );
  return row ? normaliseRow(row) : undefined;
}

/** Owner-facing read that also carries the artist columns for detail views. */
export async function getTrackWithArtist(
  id: string,
  ownerId: string,
): Promise<TrackWithArtist | undefined> {
  const row = await queryOne<TrackWithArtist>(
    `${TRACK_SELECT}
      WHERE t.id = ? AND t.owner_id = ? AND t.deleted_at IS NULL`,
    [id, ownerId],
  );
  return row ? normaliseRow(row) : undefined;
}

export async function setTrackState(
  params: { trackId: string; state: TrackState; reason?: string | null },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE tracks SET state = ?, suspended_reason = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
    [params.state, params.reason ?? null, params.trackId],
    tx,
  );
}

export interface ListTracksParams {
  userId: string;
  limit: number;
  cursor?: string | undefined;
  state?: TrackState | undefined;
  q?: string | undefined;
  projectId?: string | undefined;
}

export async function listTracks(params: ListTracksParams): Promise<TrackRow[]> {
  const clauses = ['owner_id = ?', 'deleted_at IS NULL'];
  const values: unknown[] = [params.userId];
  if (params.cursor) {
    values.push(new Date(params.cursor));
    clauses.push('created_at < ?');
  }
  if (params.state) {
    values.push(params.state);
    clauses.push('state = ?');
  }
  if (params.projectId) {
    values.push(params.projectId);
    clauses.push('project_id = ?');
  }
  if (params.q) {
    values.push(`%${params.q}%`);
    clauses.push('title LIKE ?');
  }
  values.push(params.limit);
  const rows = await query<TrackRow>(
    `SELECT ${TRACK_COLUMNS} FROM tracks
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?`,
    values,
  );
  return rows.map(normaliseRow);
}

// -------------------------------------------------------------- explore / social

export interface ExploreParams {
  limit: number;
  cursor?: string | undefined;
  sort: 'trending' | 'new';
  vocal?: 'instrumental' | 'vocals' | undefined;
  q?: string | undefined;
  /** Present when the reader is signed in: fills `likedByMe`. */
  viewerId?: string | undefined;
}

/**
 * The public Explore feed. Every row is public and deliverable by construction,
 * so an accidental WHERE slip cannot leak a private song (SEC-01).
 *
 * `trending` orders by engagement (4×likes + plays) with recency as tiebreak;
 * `new` is plain reverse-chronological. Cursor pagination is keyset on the
 * same pair of columns the chosen sort uses, so rows cannot repeat or vanish
 * between pages as counters move.
 */
export function exploreTrendingScore(row: { like_count: number; play_count: number }): number {
  return row.like_count * 4 + row.play_count;
}

export async function listExploreTracks(params: ExploreParams): Promise<TrackWithArtist[]> {
  const clauses = ["t.visibility = 'public'", "t.state = 'deliverable'", 't.deleted_at IS NULL'];
  const values: unknown[] = [];

  if (params.cursor) {
    if (params.sort === 'trending') {
      // cursor = "<score>|<createdAtIso>"
      const [score, createdAt] = params.cursor.split('|');
      const s = Number(score);
      if (Number.isFinite(s) && createdAt) {
        clauses.push(
          '((t.like_count * 4 + t.play_count) < ? OR ((t.like_count * 4 + t.play_count) = ? AND t.created_at < ?))',
        );
        values.push(s, s, new Date(createdAt));
      }
    } else {
      values.push(new Date(params.cursor));
      clauses.push('t.created_at < ?');
    }
  }
  if (params.vocal === 'instrumental') clauses.push("t.vocal_mode = 'instrumental'");
  if (params.vocal === 'vocals') clauses.push("t.vocal_mode = 'with_vocals'");
  if (params.q) {
    values.push(`%${params.q}%`, `%${params.q}%`);
    clauses.push('(t.title LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(t.styles, "$")) LIKE ?)');
  }

  const order =
    params.sort === 'trending'
      ? 'ORDER BY (t.like_count * 4 + t.play_count) DESC, t.created_at DESC'
      : 'ORDER BY t.created_at DESC';

  values.push(params.limit);
  const rows = await query<TrackWithArtist>(
    `${TRACK_SELECT}
      WHERE ${clauses.join(' AND ')}
      ${order}
      LIMIT ?`,
    values,
  );
  return rows.map(normaliseRow);
}

/** Atomic visibility flip; only the owner's row can move (SEC-01). */
export async function setTrackVisibility(
  params: { trackId: string; ownerId: string; visibility: Visibility },
  tx?: PoolConnection,
): Promise<boolean> {
  const res = await execute(
    `UPDATE tracks SET visibility = ?, updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND state = 'deliverable'`,
    [params.visibility, params.trackId, params.ownerId],
    tx,
  );
  return res.affectedRows > 0;
}

/**
 * Toggle-like. `song_likes (user_id, track_id)` is unique, so the insert and
 * the like-count increment share one transaction; a double click collapses
 * into a no-op that reports the existing state rather than a double count.
 */
export async function likeTrack(
  params: { trackId: string; userId: string },
  tx: PoolConnection,
): Promise<{ liked: true; likeCount: number }> {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM song_likes WHERE user_id = ? AND track_id = ?`,
    [params.userId, params.trackId],
    tx,
  );
  if (!existing) {
    await execute(
      `INSERT INTO song_likes (id, user_id, track_id) VALUES (?, ?, ?)`,
      [newId(), params.userId, params.trackId],
      tx,
    );
    await execute(
      `UPDATE tracks SET like_count = like_count + 1, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [params.trackId],
      tx,
    );
  }
  const row = await queryOne<{ like_count: number }>(
    `SELECT like_count FROM tracks WHERE id = ?`,
    [params.trackId],
    tx,
  );
  return { liked: true, likeCount: Number(row?.like_count ?? 1) };
}

export async function unlikeTrack(
  params: { trackId: string; userId: string },
  tx: PoolConnection,
): Promise<{ liked: false; likeCount: number }> {
  const res = await execute(
    `DELETE FROM song_likes WHERE user_id = ? AND track_id = ?`,
    [params.userId, params.trackId],
    tx,
  );
  if (res.affectedRows > 0) {
    await execute(
      `UPDATE tracks
          SET like_count = GREATEST(like_count - 1, 0), updated_at = UTC_TIMESTAMP(3)
        WHERE id = ?`,
      [params.trackId],
      tx,
    );
  }
  const row = await queryOne<{ like_count: number }>(
    `SELECT like_count FROM tracks WHERE id = ?`,
    [params.trackId],
    tx,
  );
  return { liked: false, likeCount: Number(row?.like_count ?? 0) };
}

/** Present when the reader is signed in; drives the heart state on cards. */
export async function hasLiked(trackIds: string[], viewerId: string): Promise<Set<string>> {
  if (!trackIds.length) return new Set();
  const placeholders = trackIds.map(() => '?').join(',');
  const rows = await query<{ track_id: string }>(
    `SELECT track_id FROM song_likes WHERE user_id = ? AND track_id IN (${placeholders})`,
    [viewerId, ...trackIds],
  );
  return new Set(rows.map((r) => r.track_id));
}

/** Fire-and-forget engagement counter; rate limited at the route, not here. */
export async function incrementPlayCount(trackId: string): Promise<void> {
  await execute(
    `UPDATE tracks SET play_count = play_count + 1 WHERE id = ? AND visibility = 'public'`,
    [trackId],
  );
}

/**
 * Soft delete. The audio object is removed by a separate retention job, and a
 * track under an open rights case is never deleted from here — evidence
 * preservation beats a user-initiated wipe (design doc §18).
 */
export async function softDeleteTrack(
  params: { trackId: string; userId: string },
  tx?: PoolConnection,
): Promise<boolean> {
  const res = await execute(
    `UPDATE tracks t
        LEFT JOIN rights_cases rc
          ON rc.track_id = t.id
         AND rc.status IN ('received','under_review','suspended')
        SET t.deleted_at = UTC_TIMESTAMP(3),
            t.state = 'deleted',
            t.updated_at = UTC_TIMESTAMP(3)
      WHERE t.id = ? AND t.owner_id = ? AND t.deleted_at IS NULL
        AND rc.id IS NULL`,
    [params.trackId, params.userId],
    tx,
  );
  return res.affectedRows > 0;
}

export interface AssetRow {
  id: string;
  track_id: string;
  owner_id: string;
  kind: AssetKind;
  format: AudioFormat;
  storage_key: string;
  byte_size: number;
  duration_ms: number;
  sha256: string;
  clip_start_ms: number | null;
  clip_duration_ms: number | null;
  fade_out_ms: number;
  params_hash: string;
  created_at: Date;
}

const ASSET_COLUMNS = `
  id, track_id, owner_id, kind, format, storage_key, byte_size, duration_ms,
  sha256, clip_start_ms, clip_duration_ms, fade_out_ms, params_hash, created_at
`;

export async function insertAsset(
  params: {
    trackId: string;
    ownerId: string;
    kind: AssetKind;
    format: AudioFormat;
    storageKey: string;
    byteSize: number;
    durationMs: number;
    sha256: string;
    clipStartMs?: number | null;
    clipDurationMs?: number | null;
    fadeOutMs?: number;
    paramsHash: string;
  },
  tx?: PoolConnection,
): Promise<AssetRow> {
  // An identical export is reused rather than re-rendered (UI-06).
  await execute(
    `INSERT INTO asset_versions
       (id, track_id, owner_id, kind, format, storage_key, byte_size, duration_ms, sha256,
        clip_start_ms, clip_duration_ms, fade_out_ms, params_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      newId(),
      params.trackId,
      params.ownerId,
      params.kind,
      params.format,
      params.storageKey,
      params.byteSize,
      params.durationMs,
      params.sha256,
      params.clipStartMs ?? null,
      params.clipDurationMs ?? null,
      params.fadeOutMs ?? 0,
      params.paramsHash,
    ],
    tx,
  );
  return (await queryOne<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM asset_versions
      WHERE track_id = ? AND kind = ? AND params_hash = ?`,
    [params.trackId, params.kind, params.paramsHash],
    tx,
  ))!;
}

export async function findAsset(
  params: { trackId: string; kind: AssetKind; paramsHash: string },
  tx?: PoolConnection,
): Promise<AssetRow | undefined> {
  return queryOne<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM asset_versions
      WHERE track_id = ? AND kind = ? AND params_hash = ?`,
    [params.trackId, params.kind, params.paramsHash],
    tx,
  );
}

export async function getMasterAsset(trackId: string, tx?: PoolConnection): Promise<AssetRow | undefined> {
  return queryOne<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM asset_versions
      WHERE track_id = ? AND kind = 'master' ORDER BY created_at LIMIT 1`,
    [trackId],
    tx,
  );
}

/** Ownership is enforced in the query — download authorisation, not a UI check (SEC-04). */
export async function getAssetForUser(
  assetId: string,
  userId: string,
  tx?: PoolConnection,
): Promise<AssetRow | undefined> {
  return queryOne<AssetRow>(
    `SELECT a.id, a.track_id, a.owner_id, a.kind, a.format, a.storage_key, a.byte_size,
            a.duration_ms, a.sha256, a.clip_start_ms, a.clip_duration_ms, a.fade_out_ms,
            a.params_hash, a.created_at
       FROM asset_versions a
       JOIN tracks t ON t.id = a.track_id
      WHERE a.id = ? AND a.owner_id = ? AND t.deleted_at IS NULL AND t.state <> 'suspended'`,
    [assetId, userId],
    tx,
  );
}

export async function listAssets(trackId: string, tx?: PoolConnection): Promise<AssetRow[]> {
  return query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM asset_versions WHERE track_id = ? ORDER BY created_at`,
    [trackId],
    tx,
  );
}
