import type { PoolConnection } from 'mysql2/promise';
import type { UserRole } from '@loopscene/contracts';
import { execute, newId, query, queryOne } from './pool.js';

export interface UserRow {
  id: string;
  external_id: string;
  auth_provider: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  role: UserRole;
  status: 'active' | 'suspended' | 'deleted';
  age_confirmed_at: Date | null;
  terms_accepted_at: Date | null;
  marketing_opt_in: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const USER_COLUMNS = `
  id, external_id, auth_provider, email, display_name, avatar_url, role, status,
  age_confirmed_at, terms_accepted_at, marketing_opt_in, created_at, updated_at, deleted_at
`;

export async function getUser(id: string, tx?: PoolConnection): Promise<UserRow | undefined> {
  return queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id], tx);
}

export async function findByExternalId(
  authProvider: string,
  externalId: string,
  tx?: PoolConnection,
): Promise<UserRow | undefined> {
  return queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE auth_provider = ? AND external_id = ?`,
    [authProvider, externalId],
    tx,
  );
}

/**
 * Creates or refreshes the local mirror of an identity-provider subject.
 * `role` is deliberately not taken from the token — privilege lives in our own
 * database so an IdP attribute cannot escalate an account (SEC-02/SEC-03).
 */
export async function upsertUser(
  params: {
    authProvider: string;
    externalId: string;
    email: string;
    displayName?: string | null;
    avatarUrl?: string | null;
  },
  tx?: PoolConnection,
): Promise<UserRow> {
  await execute(
    `INSERT INTO users (id, auth_provider, external_id, email, display_name, avatar_url)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       email = VALUES(email),
       display_name = COALESCE(VALUES(display_name), display_name),
       avatar_url = COALESCE(VALUES(avatar_url), avatar_url),
       updated_at = UTC_TIMESTAMP(3)`,
    [
      newId(),
      params.authProvider,
      params.externalId,
      params.email,
      params.displayName ?? null,
      params.avatarUrl ?? null,
    ],
    tx,
  );
  return (await findByExternalId(params.authProvider, params.externalId, tx))!;
}

export async function confirmAgeAndTerms(
  params: { userId: string; marketingOptIn: boolean },
  tx?: PoolConnection,
): Promise<UserRow | undefined> {
  await execute(
    `UPDATE users SET
       age_confirmed_at = COALESCE(age_confirmed_at, UTC_TIMESTAMP(3)),
       terms_accepted_at = COALESCE(terms_accepted_at, UTC_TIMESTAMP(3)),
       marketing_opt_in = ?,
       updated_at = UTC_TIMESTAMP(3)
     WHERE id = ?`,
    [params.marketingOptIn ? 1 : 0, params.userId],
    tx,
  );
  return getUser(params.userId, tx);
}

export async function setMarketingOptIn(
  params: { userId: string; optIn: boolean },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE users SET marketing_opt_in = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
    [params.optIn ? 1 : 0, params.userId],
    tx,
  );
}

export async function setRole(
  params: { userId: string; role: UserRole },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE users SET role = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
    [params.role, params.userId],
    tx,
  );
}

// ------------------------------------------------------------------ projects

export interface ProjectRow {
  id: string;
  owner_id: string;
  title: string;
  scene: string;
  status: 'active' | 'deleted';
  created_at: Date;
  updated_at: Date;
}

const PROJECT_COLUMNS = `id, owner_id, title, scene, status, created_at, updated_at`;

export async function insertProject(
  params: { ownerId: string; title: string; scene: string },
  tx?: PoolConnection,
): Promise<ProjectRow> {
  const id = newId();
  await execute(
    `INSERT INTO projects (id, owner_id, title, scene) VALUES (?, ?, ?, ?)`,
    [id, params.ownerId, params.title, params.scene],
    tx,
  );
  return (await queryOne<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`,
    [id],
    tx,
  ))!;
}

export async function getProjectForUser(
  id: string,
  userId: string,
  tx?: PoolConnection,
): Promise<ProjectRow | undefined> {
  return queryOne<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? AND owner_id = ? AND status = 'active'`,
    [id, userId],
    tx,
  );
}

export async function listProjects(
  userId: string,
  limit = 50,
): Promise<Array<ProjectRow & { track_count: number }>> {
  return query<ProjectRow & { track_count: number }>(
    `SELECT p.id, p.owner_id, p.title, p.scene, p.status, p.created_at, p.updated_at,
            COUNT(t.id) AS track_count
       FROM projects p
       LEFT JOIN tracks t ON t.project_id = p.id AND t.deleted_at IS NULL
      WHERE p.owner_id = ? AND p.status = 'active'
      GROUP BY p.id, p.owner_id, p.title, p.scene, p.status, p.created_at, p.updated_at
      ORDER BY p.updated_at DESC
      LIMIT ?`,
    [userId, limit],
  );
}

export async function renameProject(
  params: { projectId: string; userId: string; title: string },
  tx?: PoolConnection,
): Promise<ProjectRow | undefined> {
  const res = await execute(
    `UPDATE projects SET title = ?, updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND owner_id = ? AND status = 'active'`,
    [params.title, params.projectId, params.userId],
    tx,
  );
  if (res.affectedRows === 0) return undefined;
  return getProjectForUser(params.projectId, params.userId, tx);
}

export async function deleteProject(
  params: { projectId: string; userId: string },
  tx?: PoolConnection,
): Promise<boolean> {
  const res = await execute(
    `UPDATE projects SET status = 'deleted', deleted_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND owner_id = ? AND status = 'active'`,
    [params.projectId, params.userId],
    tx,
  );
  return res.affectedRows > 0;
}

export async function touchProject(projectId: string, tx?: PoolConnection): Promise<void> {
  await execute(`UPDATE projects SET updated_at = UTC_TIMESTAMP(3) WHERE id = ?`, [projectId], tx);
}
