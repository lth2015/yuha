import type { PoolConnection } from 'mysql2/promise';
import type { AssetKind, AudioFormat, LyricTimings, TrackState, Visibility, VocalMode } from '@yuha/contracts';
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
  cover_seed: number;
  lyric_timings: LyricTimings | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/** Library cards want the creator's name next to the song. */
export type TrackWithArtist = TrackRow & { artist_name: string | null; artist_avatar: string | null };

const TRACK_COLUMNS = `
  id, owner_id, project_id, job_id, title, scene, mood, duration_ms, state,
  suspended_reason, styles, lyrics, vocal_mode, visibility, play_count,
  cover_seed, lyric_timings, created_at, updated_at, deleted_at
`;

const TRACK_SELECT = `
  SELECT t.id, t.owner_id, t.project_id, t.job_id, t.title, t.scene, t.mood, t.duration_ms,
         t.state, t.suspended_reason, t.styles, t.lyrics, t.vocal_mode, t.visibility,
         t.play_count, t.cover_seed, t.lyric_timings, t.created_at, t.updated_at, t.deleted_at,
         u.display_name AS artist_name, u.avatar_url AS artist_avatar
    FROM tracks t
    JOIN users u ON u.id = t.owner_id
`;

/**
 * MySQL JSON columns come back as strings; normalise once, here, so callers
 * always see a plain array.
 */
function normaliseRow<T>(row: T): T {
  const r = row as { styles?: unknown; lyric_timings?: unknown };
  if (typeof r.styles === 'string') {
    try {
      r.styles = JSON.parse(r.styles as string);
    } catch {
      r.styles = null;
    }
  }
  if (typeof r.lyric_timings === 'string') {
    try {
      r.lyric_timings = JSON.parse(r.lyric_timings as string);
    } catch {
      r.lyric_timings = null;
    }
  }
  return row;
}

/** Stores the worker's alignment output (source-labelled inside the JSON). */
export async function setTrackLyricTimings(
  params: { trackId: string; timings: LyricTimings },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE tracks SET lyric_timings = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
    [JSON.stringify(params.timings), params.trackId],
    tx,
  );
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
