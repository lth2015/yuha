/**
 * Migration CLI: `pnpm db:migrate` / `pnpm db:reset`, and the logic rules:
 * `pnpm check:invariants [--json] [rule …]` (packages/db/src/invariants.ts).
 * Uses the mounted RDS credentials in the cluster, or DATABASE_URL for local
 * development and CI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { closeDb, db, initDb } from './pool.js';
import { migrate, reset } from './migrate.js';
import { INVARIANTS, checkInvariants } from './invariants.js';

type MysqlCredentials = {
  host?: string;
  port?: number | string;
  username?: string;
  password?: string;
  dbname?: string;
  database?: string;
};

const credentialsFile =
  process.env.DATABASE_SECRET_FILE ?? join(process.cwd(), 'secrets', 'mysql-credentials.json');

function readDatabaseUrl(): string | undefined {
  if (!existsSync(credentialsFile)) return undefined;
  try {
    const value = JSON.parse(readFileSync(credentialsFile, 'utf8')) as MysqlCredentials;
    const host = value.host ?? process.env.DATABASE_HOST;
    const port = value.port ?? process.env.DATABASE_PORT ?? 3306;
    const database = value.dbname ?? value.database ?? process.env.DATABASE_NAME;
    if (!host || !value.username || value.password === undefined || !database) return undefined;
    return `mysql://${encodeURIComponent(value.username)}:${encodeURIComponent(value.password)}@${host}:${port}/${encodeURIComponent(database)}`;
  } catch {
    return undefined;
  }
}

const url = process.env.DATABASE_SECRET_FILE
  ? readDatabaseUrl()
  : process.env.DATABASE_URL ?? readDatabaseUrl();
if (!url) {
  console.error(
    `MySQL connection settings are incomplete. Expected mounted username/password plus DATABASE_HOST, DATABASE_PORT, and DATABASE_NAME: ${credentialsFile}`,
  );
  process.exit(1);
}

const command = process.argv[2] ?? 'migrate';
// One connection for the logic rules, so the READ ONLY set below covers every query they run.
initDb({ connectionString: url, ...(command === 'invariants' ? { max: 1 } : {}) });

try {
  if (command === 'migrate') {
    const res = await migrate();
    console.log(
      res.applied.length ? `applied: ${res.applied.join(', ')}` : 'no pending migrations',
    );
  } else if (command === 'reset') {
    await reset();
    const res = await migrate();
    console.log(`reset complete; applied: ${res.applied.join(', ')}`);
  } else if (command === 'invariants') {
    /*
     * Read-only: every rule is a SELECT, and the session is set READ ONLY
     * besides, so this can be pointed at production. Output names ids, never
     * a person, so it can be pasted into a PR (docs/agents/CODEX_COLLABORATION.md).
     */
    const args = process.argv.slice(3);
    const json = args.includes('--json');
    const only = args.filter((a) => !a.startsWith('--'));
    await db().query('SET SESSION TRANSACTION READ ONLY');
    const results = await checkInvariants(only.length ? only : undefined);
    // A run that checked nothing must not read as a pass.
    if (results.length === 0 || INVARIANTS.length === 0) throw new Error('no logic rules were checked');
    const broken = results.filter((r) => r.count > 0);
    if (json) {
      console.log(JSON.stringify({ checked: results.length, broken: broken.length, results }, null, 2));
    } else {
      for (const r of results) {
        const count = r.count >= 1000 ? '1000+' : String(r.count);
        console.log(r.count ? `✗ ${r.name} — ${r.rule}: ${count} (e.g. ${r.sample.join(', ')})` : `✓ ${r.name} — ${r.rule}`);
      }
      console.log(`\n${results.length} rules checked, ${broken.length} broken.`);
    }
    if (broken.length) process.exitCode = 1;
  } else {
    console.error(`unknown command: ${command}`);
    process.exit(1);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
