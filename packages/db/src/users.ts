import type { PoolConnection } from 'mysql2/promise';
import type { UserRole } from '@yuha/contracts';
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

/**
 * Finds the accounts an operator might mean, by email.
 *
 * There was no way to look a person up at all: the only user-facing admin
 * route took a UUID in its path, and nothing in the console or the API could
 * turn an email address into one. "Give my friend fifty credits" therefore
 * meant opening a SQL client, which is not a feature — it is the absence of
 * one, dressed as a workaround.
 *
 * Deliberately narrow, because this reads other people's email addresses:
 *
 *  - Email only. Not display name, not a free-text sweep over songs or
 *    prompts. An operator looking somebody up already knows their address;
 *    anything broader turns support tooling into a people search.
 *  - A prefix, not a substring. `LIKE '%ab%'` lets two characters of a common
 *    domain return the whole customer list, and no index can serve it.
 *    Matched against `email_active`, which is the column that actually
 *    carries the unique index — this said "the unique index on email", and
 *    there is no such index: `users_email_active_uk` is on a generated column
 *    that is `email` while `deleted_at IS NULL` and NULL otherwise. Using it
 *    is what makes the lookup indexed, and it excludes deleted accounts by
 *    construction rather than by a predicate somebody has to remember.
 *  - Deleted accounts are therefore excluded. A deletion that was executed
 *    must not be undone by granting credits to the row it left behind. The
 *    `status` filter stays as a second expression of the same rule, because a
 *    row marked deleted without `deleted_at` set would otherwise be findable.
 *  - Capped, and the cap is the caller's business: `limit` rows come back and
 *    `more` says the query was too loose, so the interface can ask for a
 *    fuller address instead of paginating through everybody.
 *
 * It is not an anti-enumeration measure and should not be read as one. A
 * prefix search ordered by address, with a flag saying "there are more", is a
 * usable prefix-descent oracle over the customer base — three characters
 * narrows what two characters opened, it does not close it. What keeps this
 * closed is that the route is staff-only.
 */
export async function findUsersByEmail(
  params: { email: string; limit?: number },
  tx?: PoolConnection,
): Promise<{ items: UserRow[]; more: boolean }> {
  const needle = params.email.trim().toLowerCase();
  // Two characters is not a search, it is a listing. The caller gets nothing
  // rather than the first page of the customer base.
  if (needle.length < 3) return { items: [], more: false };
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);

  const rows = await query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users
      WHERE status <> 'deleted'
        AND email_active LIKE ?
      ORDER BY email_active ASC
      LIMIT ?`,
    // The escape is not decoration: an operator pasting an address with an
    // underscore in it — which is most addresses that have one — would
    // otherwise have it read as LIKE's single-character wildcard and match
    // accounts that are not the one they meant.
    //
    // No `email = ? OR` and no `ORDER BY email = ? DESC`: under `LIKE
    // 'needle%'` an exact match is already the shortest match and therefore
    // sorts first, so both were redundant — and the ranking term forced a
    // filesort on every search to re-derive something the index ordering
    // already gave.
    [`${escapeLike(needle)}%`, limit + 1],
    tx,
  );
  return { items: rows.slice(0, limit), more: rows.length > limit };
}

/** `\`, `%` and `_` are LIKE metacharacters; MySQL's default escape is `\`. */
function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
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

/**
 * Records that the user affirmed their age and accepted the terms.
 *
 * `marketingOptIn` is optional, and omitting it leaves the column alone. It
 * used to be required and written unconditionally while only the two
 * timestamps were COALESCE-protected, so any caller that did not have a real
 * answer from the user had to invent one — and the Google callback invented
 * `false`, on every sign-in, quietly undoing whatever the user had chosen in
 * settings. A caller with no answer should now say so by not passing one.
 */
export async function confirmAgeAndTerms(
  params: { userId: string; marketingOptIn?: boolean },
  tx?: PoolConnection,
): Promise<UserRow | undefined> {
  await execute(
    `UPDATE users SET
       age_confirmed_at = COALESCE(age_confirmed_at, UTC_TIMESTAMP(3)),
       terms_accepted_at = COALESCE(terms_accepted_at, UTC_TIMESTAMP(3)),
       marketing_opt_in = COALESCE(?, marketing_opt_in),
       updated_at = UTC_TIMESTAMP(3)
     WHERE id = ?`,
    [params.marketingOptIn === undefined ? null : params.marketingOptIn ? 1 : 0, params.userId],
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
