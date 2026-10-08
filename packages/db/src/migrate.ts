import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, newId, query } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, 'migrations');

/**
 * Statement separator.
 *
 * MySQL DDL commits implicitly, so a migration file cannot be wrapped in one
 * transaction; the runner sends statements individually. A plain `;` split
 * would break trigger bodies, which contain their own semicolons, so files use
 * an explicit sentinel line instead.
 */
const STATEMENT_SEPARATOR = /^\s*--\s*;;\s*$/m;

/**
 * "That object is already there."
 *
 * MySQL commits DDL implicitly, so a file that fails at statement 2 leaves
 * statement 1's effect behind — and because the file never reaches the
 * `schema_migrations` insert below, the next run replays statement 1 and
 * collides with its own earlier work. The errno is what separates that story
 * from a genuine clash with something made by hand, which is why the hint says
 * "most likely" rather than asserting it.
 */
const ALREADY_THERE_ERRNOS = new Set([
  1022, // ER_DUP_KEY
  1050, // ER_TABLE_EXISTS_ERROR
  1060, // ER_DUP_FIELDNAME
  1061, // ER_DUP_KEYNAME
  1091, // ER_CANT_DROP_FIELD_OR_KEY — the same story, told by a DROP statement
  // ER_CHECK_CONSTRAINT_NOT_FOUND. The CHECK-constraint telling of 1091: a
  // migration that rewrites a CHECK does DROP then ADD, and if the ADD fails
  // the re-run cannot find the constraint its own earlier pass removed. 0018
  // has this shape; 0005, 0006 and 0008 already did.
  3940,
  1359, // ER_TRG_ALREADY_EXISTS
  1826, // ER_FK_DUP_NAME
]);

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
  statements: string[];
}

function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_SEPARATOR)
    .map((s) => s.trim().replace(/;\s*$/, '').trim())
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)*$/.test(s));
}

async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(join(dir, name), 'utf8');
    out.push({
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      statements: splitStatements(sql),
    });
  }
  return out;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies pending migrations.
 *
 * An already-applied file whose contents changed is a hard error: forward-fix
 * with a new file rather than editing history (§12.3 "向前修复"). Because DDL
 * is not transactional in MySQL, a mid-file failure leaves the schema partly
 * migrated — the error names the statement so it can be repaired deliberately.
 */
export async function migrate(dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  const files = await loadMigrations(dir);
  const applied: string[] = [];
  const skipped: string[] = [];

  const conn = await db().getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       VARCHAR(191) NOT NULL,
        checksum   CHAR(64) CHARACTER SET ascii NOT NULL,
        applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Only one process may migrate at a time.
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, 60) AS got', ['loopscene:migrate']);
    if ((lockRows as Array<{ got: number }>)[0]?.got !== 1) {
      throw new Error('could not acquire the migration lock within 60s');
    }

    try {
      const [rows] = await conn.query('SELECT name, checksum FROM schema_migrations');
      const seen = new Map((rows as Array<{ name: string; checksum: string }>).map((r) => [r.name, r.checksum]));

      for (const file of files) {
        const prior = seen.get(file.name);
        if (prior) {
          if (prior !== file.checksum) {
            throw new Error(
              `migration ${file.name} was modified after being applied ` +
                `(expected ${prior}, got ${file.checksum}). Add a new migration instead.`,
            );
          }
          skipped.push(file.name);
          continue;
        }

        for (const [i, statement] of file.statements.entries()) {
          try {
            await conn.query(statement);
          } catch (err) {
            // ER_BINLOG_CREATE_ROUTINE_NEED_SUPER. The license immutability
            // trigger is a SEC-08 control, so this is reported as an
            // actionable configuration error rather than skipped.
            if ((err as { errno?: number }).errno === 1419) {
              throw new Error(
                `migration ${file.name} cannot create a trigger: the server requires ` +
                  'log_bin_trust_function_creators=1 (or SUPER). On RDS/Aurora set it in the ' +
                  'DB parameter group and reboot; locally it is set in docker-compose.yml. ' +
                  'The trigger enforces licence-snapshot immutability (SEC-08) and is not optional.',
                { cause: err },
              );
            }
            const errno = (err as { errno?: number }).errno;
            const hint =
              errno !== undefined && ALREADY_THERE_ERRNOS.has(errno)
                ? `\n${file.name} is not recorded in schema_migrations, yet this statement ` +
                  'collides with something that already exists. Most likely an earlier run of ' +
                  'this same file failed partway and left the schema half-migrated. Repair it ' +
                  'deliberately: on a dev or test database, `pnpm db:reset && pnpm db:migrate && ' +
                  'pnpm seed`; on a database you cannot drop, undo this file\'s completed ' +
                  'statements by hand, or record it as applied once the schema matches.'
                : '';
            throw new Error(
              `migration ${file.name} failed at statement ${i + 1}/${file.statements.length}: ` +
                `${(err as Error).message}${hint}\n--- statement ---\n${statement.slice(0, 400)}`,
              { cause: err },
            );
          }
        }
        await conn.query('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)', [
          file.name,
          file.checksum,
        ]);
        applied.push(file.name);
      }
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', ['loopscene:migrate']);
    }
  } finally {
    conn.release();
  }
  return { applied, skipped };
}

/** Drops every table. Refuses to touch anything that does not look like a dev/test database. */
export async function reset(): Promise<void> {
  const conn = await db().getConnection();
  try {
    const [dbRows] = await conn.query('SELECT DATABASE() AS db');
    const name = (dbRows as Array<{ db: string }>)[0]?.db ?? '';
    if (!/(test|dev|local)/i.test(name)) {
      throw new Error(`refusing to reset database "${name}": name must contain test, dev or local`);
    }

    const [tableRows] = await conn.query(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?`,
      [name],
    );
    const tables = (tableRows as Array<{ t: string }>).map((r) => r.t);
    if (tables.length) {
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of tables) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    }
  } finally {
    conn.release();
  }
}

/**
 * Truncates business data while keeping the schema, for the test harness.
 * Ordered by foreign keys with checks disabled, since MySQL cannot CASCADE.
 */
export async function truncateAll(tables: string[]): Promise<void> {
  const conn = await db().getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of tables) await conn.query(`TRUNCATE TABLE \`${t}\``);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

export { newId, query };
