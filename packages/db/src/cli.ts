/**
 * Migration CLI: `pnpm db:migrate` / `pnpm db:reset`.
 * Reads the RDS JSON credentials mounted under the shared application secret
 * directory so migration uses the same database source as API and Worker.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { closeDb, initDb } from './pool.js';
import { migrate, reset } from './migrate.js';

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
    const database = value.dbname ?? value.database ?? process.env.DATABASE_NAME;
    if (!value.host || !value.username || value.password === undefined || !database) return undefined;
    return `mysql://${encodeURIComponent(value.username)}:${encodeURIComponent(value.password)}@${value.host}:${value.port ?? 3306}/${encodeURIComponent(database)}`;
  } catch {
    return undefined;
  }
}

const url = readDatabaseUrl();
if (!url) {
  console.error(
    `MySQL connection settings are incomplete. Expected a mounted JSON file with host, username, password, and dbname/database, or DATABASE_NAME: ${credentialsFile}`,
  );
  process.exit(1);
}

const command = process.argv[2] ?? 'migrate';
initDb({ connectionString: url });

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
