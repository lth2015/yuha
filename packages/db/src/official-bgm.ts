import type { OfficialBgmMetadata, OfficialBgmState } from '@yuha/contracts';
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
  master_key: string;
  master_ms: number;
  preview_key: string;
  preview_start_ms: number;
  preview_ms: number;
  state: OfficialBgmState;
}

export function getOfficialBgm(id: string, tx: PoolConnection, lock: 'share' | 'update') {
  const clause = lock === 'share' ? 'FOR SHARE' : 'FOR UPDATE';
  return queryOne<OfficialBgmRow>(`SELECT * FROM official_bgm WHERE id = ? ${clause}`, [id], tx);
}

export function findOfficialBgmImport(sourceKey: string, sha256: string) {
  return query<OfficialBgmRow>('SELECT * FROM official_bgm WHERE source_key = ? OR sha256 = ?', [sourceKey, sha256]);
}

export async function insertOfficialBgm(row: Omit<OfficialBgmRow, 'state'>, tx: PoolConnection): Promise<void> {
  await execute(
    `INSERT INTO official_bgm
      (id, source_key, sha256, title, genre, scenario, mood, master_key, master_ms, preview_key, preview_start_ms, preview_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.source_key, row.sha256, row.title, row.genre, row.scenario, row.mood,
      row.master_key, row.master_ms, row.preview_key, row.preview_start_ms, row.preview_ms], tx,
  );
}

export function listOfficialBgm(input: { admin?: boolean; genre?: string; search?: string; limit: number; offset: number }) {
  const clauses: string[] = input.admin ? [] : ["state = 'published'"];
  const values: Array<string | number> = [];
  if (input.genre) {
    clauses.push('genre = ?');
    values.push(input.genre);
  }
  if (input.search) {
    clauses.push("title LIKE ? ESCAPE '='");
    values.push(`%${input.search.replace(/[=%_]/g, '=$&')}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const order = input.admin ? 'created_at DESC, id DESC' : 'published_at DESC, id DESC';
  return query<OfficialBgmRow>(`SELECT * FROM official_bgm ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...values, input.limit, input.offset]);
}

export async function setOfficialBgmState(id: string, state: OfficialBgmState, tx: PoolConnection): Promise<void> {
  await execute(
    `UPDATE official_bgm SET state = ?, updated_at = UTC_TIMESTAMP(3),
       published_at = IF(? = 'published', UTC_TIMESTAMP(3), NULL) WHERE id = ?`,
    [state, state, id], tx,
  );
}
