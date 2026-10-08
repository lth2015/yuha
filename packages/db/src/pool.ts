import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';

export type Sql = mysql.Pool | mysql.PoolConnection;
export type QueryResultRow = mysql.RowDataPacket;

let pool: mysql.Pool | undefined;

export interface DbOptions {
  connectionString: string;
  max?: number;
  ssl?: boolean;
}

/**
 * Ids are generated in the application rather than by the database.
 *
 * MySQL has no `RETURNING`, so generating the id here is what lets an insert
 * and everything that references it happen in one round trip without a
 * read-back race. Stored as CHAR(36) ascii.
 */
export function newId(): string {
  return randomUUID();
}

// Module-private: `db()` below is the only way in, and keeping it exported put
// a second entry point on the package's surface that nothing ever used. The
// orphan gate had been unable to see that, because a comment in a test
// mentions the name and a mention used to count as a reference.
function createPool(opts: DbOptions): mysql.Pool {
  return mysql.createPool({
    uri: opts.connectionString,
    connectionLimit: opts.max ?? 10,
    waitForConnections: true,
    // Everything is stored and compared in UTC; JST is a presentation concern
    // only (§10). 'Z' makes the driver read and write DATETIME as UTC.
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    // Needed only by the migration runner, which sends one statement at a time
    // anyway; leaving it off removes a whole class of injection risk.
    multipleStatements: false,
    // TINYINT(1) is our boolean. Converting once here keeps every repository
    // returning real booleans instead of 0/1, which `if (row.billable)` would
    // read correctly but `expect(x).toBe(true)` would not.
    typeCast(field, next) {
      if (field.type === 'TINY' && field.length === 1) {
        const v = field.string();
        return v === null ? null : v === '1';
      }
      return next();
    },
    ...(opts.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
}

export function initDb(opts: DbOptions): mysql.Pool {
  pool ??= createPool(opts);
  return pool;
}

export function db(): mysql.Pool {
  if (!pool) throw new Error('database pool not initialised — call initDb() first');
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

export async function query<T extends object = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
  client?: Sql,
): Promise<T[]> {
  const runner = client ?? db();
  const [rows] = await runner.query(sql, params as unknown[]);
  return rows as T[];
}

export async function queryOne<T extends object = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
  client?: Sql,
): Promise<T | undefined> {
  const rows = await query<T>(sql, params, client);
  return rows[0];
}

/** Number of rows an INSERT/UPDATE/DELETE actually changed. */
export async function execute(
  sql: string,
  params: readonly unknown[] = [],
  client?: Sql,
): Promise<{ affectedRows: number; changedRows: number }> {
  const runner = client ?? db();
  const [result] = await runner.query(sql, params as unknown[]);
  const r = result as mysql.ResultSetHeader;
  return { affectedRows: r.affectedRows ?? 0, changedRows: r.changedRows ?? 0 };
}

/**
 * Runs `fn` inside a transaction. Nothing here holds a transaction open across
 * a network call to a provider — GEN-05 requires short transactions so a worker
 * that dies mid-request leaves no long-lived lock behind.
 */
/**
 * An open transaction, named so callers outside this package can type one.
 *
 * `withTx` hands its callback a `mysql.PoolConnection`, and a service that
 * wants to factor part of a transactional block into a helper needs to say so
 * in a signature. Without this the API package would have to depend on mysql2
 * for a type alone, which is a dependency bought with nothing.
 */
export type Tx = mysql.PoolConnection;

export async function withTx<T>(
  fn: (tx: mysql.PoolConnection) => Promise<T>,
  existing?: mysql.PoolConnection,
): Promise<T> {
  if (existing) return fn(existing);
  const conn = await db().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* connection already broken; nothing to roll back */
    }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Serialises all entitlement mutation for one user.
 *
 * Locking the user row is the MySQL equivalent of a transaction-scoped
 * advisory lock: concurrent reservations for the same user queue here instead
 * of racing over batch selection (GEN-03), and the lock is released with the
 * transaction rather than needing an explicit RELEASE_LOCK. The CHECK
 * constraints on entitlement_batches remain the hard backstop.
 */
export async function lockUser(userId: string, tx: mysql.PoolConnection): Promise<void> {
  await tx.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
}

/**
 * The same row lock, named for the thing most callers are protecting.
 *
 * `lockUser` exists separately because the operator-gift path locks the
 * ACTOR's row rather than the recipient's — a per-actor daily limit read
 * without that lock is not a limit, since two of the operator's own requests
 * to two different recipients take two different locks, both read the same
 * stale total, and both commit.
 */
export async function lockUserEntitlements(userId: string, tx: mysql.PoolConnection): Promise<void> {
  await lockUser(userId, tx);
}

/** MySQL error numbers we branch on. */
export const ER_DUP_ENTRY = 1062;
export const ER_CHECK_CONSTRAINT_VIOLATED = 3819;
export const ER_LOCK_DEADLOCK = 1213;
export const ER_LOCK_WAIT_TIMEOUT = 1205;

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { errno?: number; message?: string };
  if (e?.errno !== ER_DUP_ENTRY) return false;
  // MySQL reports the index name in the message: "Duplicate entry 'x' for key 'tbl.idx'".
  return constraint ? (e.message ?? '').includes(constraint) : true;
}

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  const e = err as { errno?: number; message?: string };
  if (e?.errno !== ER_CHECK_CONSTRAINT_VIOLATED) return false;
  return constraint ? (e.message ?? '').includes(constraint) : true;
}

export function isDeadlock(err: unknown): boolean {
  const e = err as { errno?: number };
  return e?.errno === ER_LOCK_DEADLOCK || e?.errno === ER_LOCK_WAIT_TIMEOUT;
}

/**
 * Retries a transaction on deadlock or lock-wait timeout.
 *
 * InnoDB will occasionally pick a deadlock victim when several requests
 * contend for the same user's credits. That is a transient condition, not an
 * insufficient-balance answer, so it must be retried rather than surfaced to
 * the user as "out of credits".
 */
export async function withTxRetry<T>(
  fn: (tx: mysql.PoolConnection) => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await withTx(fn);
    } catch (err) {
      if (!isDeadlock(err)) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 20 * 2 ** i + Math.random() * 20));
    }
  }
  throw lastErr;
}

/** JSON columns: mysql2 parses them on read, and expects a string on write. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
