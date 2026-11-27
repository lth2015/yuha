import type { OfficialBgmCopy, OfficialBgmMetadata, OfficialBgmProvenance, OfficialBgmState } from '@yuha/contracts';
import type { PoolConnection } from 'mysql2/promise';
import { execute, query, queryOne } from './pool.js';

export interface OfficialBgmRow {
  id: string;
  source_key: string;
  sha256: string;
  title: string;
  genre: OfficialBgmMetadata['genre'];
  scenario: OfficialBgmMetadata['scenario'];
  mood: OfficialBgmMetadata['mood'];
  /** Migration 0044: an editor's zh/ja/en title and intro, style tags, and the editorial score. */
  copy: OfficialBgmCopy | null;
  tags: string[] | null;
  rating: string | number | null;
  /** Migration 0045: whether a licence may be sold, reviewed per track with a recorded basis. */
  sale_rights: 'unreviewed' | 'cleared' | 'refused';
  sale_rights_basis: string | null;
  master_key: string;
  master_format: 'mp3' | 'wav';
  master_ms: number;
  preview_key: string;
  preview_start_ms: number;
  preview_ms: number;
  state: OfficialBgmState;
  provenance: (OfficialBgmProvenance & { coverSha256?: string }) | null;
  cover_key: string | null;
}

/** mysql2 hands JSON columns back as strings in some configurations; one place reads them. */
function normalise<T extends OfficialBgmRow | undefined>(row: T): T {
  if (!row) return row;
  for (const k of ['copy', 'tags', 'provenance'] as const) {
    const v = row[k] as unknown;
    if (typeof v === 'string') (row as unknown as Record<string, unknown>)[k] = JSON.parse(v);
  }
  return row;
}

export async function getOfficialBgm(id: string, tx: PoolConnection, lock: 'share' | 'update') {
  const clause = lock === 'share' ? 'FOR SHARE' : 'FOR UPDATE';
  return normalise(await queryOne<OfficialBgmRow>(`SELECT * FROM official_bgm WHERE id = ? ${clause}`, [id], tx));
}

/**
 * A new track's starting score (product owner, 2026-11-27): random in
 * 3.8–4.5, one decimal, until there is a recommendation standard.
 */
export function startingRating(random: () => number = Math.random): number {
  return Math.round((3.8 + random() * 0.7) * 10) / 10;
}

/** An editor's words, tags and score for one track. */
export async function setOfficialBgmCatalog(
  id: string,
  edit: { copy: OfficialBgmCopy; tags: string[]; rating: number | null },
  tx: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE official_bgm SET copy = ?, tags = ?, rating = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
    [JSON.stringify(edit.copy), JSON.stringify(edit.tags), edit.rating, id],
    tx,
  );
}

/** Records a sale-rights decision for one track; the basis is required for any decision but "unreviewed". */
export async function setOfficialBgmSaleRights(
  id: string,
  decision: { status: 'unreviewed' | 'cleared' | 'refused'; basis: string | null; actorId: string },
  tx: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE official_bgm SET sale_rights = ?, sale_rights_basis = ?, sale_rights_by = ?, sale_rights_at = UTC_TIMESTAMP(3),
            updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
    [decision.status, decision.basis, decision.actorId, id],
    tx,
  );
}

/** Every track awaiting publication, oldest first. */
export function pendingOfficialBgmPublication(tx?: PoolConnection) {
  return query<{ id: string; title: string }>(
    `SELECT id, title FROM official_bgm WHERE state IN ('draft','reviewed') ORDER BY created_at, id`, [], tx,
  );
}

export function findOfficialBgmImport(sourceKey: string, sha256: string) {
  return query<OfficialBgmRow>('SELECT * FROM official_bgm WHERE source_key = ? OR sha256 = ?', [sourceKey, sha256]);
}

export async function insertOfficialBgm(
  row: Omit<OfficialBgmRow, 'state' | 'copy' | 'tags' | 'rating' | 'sale_rights' | 'sale_rights_basis'> & { tags?: string[]; rating?: number },
  tx: PoolConnection,
): Promise<void> {
  await execute(
    `INSERT INTO official_bgm
      (id, source_key, sha256, title, genre, scenario, mood, tags, rating, master_key, master_format, master_ms, preview_key,
       preview_start_ms, preview_ms, provenance, cover_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.source_key, row.sha256, row.title, row.genre, row.scenario, row.mood,
      JSON.stringify(row.tags ?? []), row.rating ?? startingRating(),
      row.master_key, row.master_format, row.master_ms, row.preview_key, row.preview_start_ms, row.preview_ms,
      row.provenance ? JSON.stringify(row.provenance) : null, row.cover_key], tx,
  );
}

export async function listOfficialBgm(input: { admin?: boolean; genre?: string; search?: string; limit: number; offset: number }) {
  const clauses: string[] = input.admin ? [] : ["state = 'published'"];
  const values: Array<string | number> = [];
  if (input.genre) {
    clauses.push('genre = ?');
    values.push(input.genre);
  }
  if (input.search) {
    // The original title, or any language's title an editor wrote.
    clauses.push("(title LIKE ? ESCAPE '=' OR CAST(JSON_EXTRACT(copy, '$.*.title') AS CHAR) LIKE ? ESCAPE '=')");
    const like = `%${input.search.replace(/[=%_]/g, '=$&')}%`;
    values.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const order = input.admin ? 'created_at DESC, id DESC' : 'published_at DESC, id DESC';
  return query<OfficialBgmRow>(`SELECT * FROM official_bgm ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...values, input.limit, input.offset]).then((rows) => rows.map(normalise));
}

export async function setOfficialBgmState(id: string, state: OfficialBgmState, tx: PoolConnection): Promise<void> {
  await execute(
    `UPDATE official_bgm SET state = ?, updated_at = UTC_TIMESTAMP(3),
       published_at = IF(? = 'published', UTC_TIMESTAMP(3), NULL) WHERE id = ?`,
    [state, state, id], tx,
  );
}
