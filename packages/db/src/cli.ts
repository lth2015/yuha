/**
 * Migration CLI: `pnpm db:migrate` / `pnpm db:reset`, and the logic rules:
 * `pnpm check:invariants [--json] [rule …]` (packages/db/src/invariants.ts),
 * and the break-glass second-factor reset: `mfa-reset <email> --reason "…"`
 * (docs/OPERATIONS_MFA_RESET.md).
 * Uses the mounted RDS credentials in the cluster, or DATABASE_URL for local
 * development and CI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { closeDb, db, initDb } from './pool.js';
import { migrate, reset } from './migrate.js';
import { INVARIANTS, checkInvariants } from './invariants.js';
import { resetMfaFactor } from './mfa.js';
import { lyricTruth } from './lyric-truth.js';

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
initDb({ connectionString: url, ...(command === 'invariants' || command === 'lyric-truth' ? { max: 1 } : {}) });

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
  } else if (command === 'lyric-truth') {
    /*
     * Ground truth for the lyric sync benchmark (docs/quality/LYRIC_BENCH.md):
     * staff songs whose timing a person corrected, never a customer's. Read
     * only, one connection, so it can be pointed at production. Writes the
     * scorer's annotations and a songs.json for bench_align.py on the DGX.
     */
    const dir = resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[3] ?? 'quality-probes/lyric-bench');
    await db().query('SET SESSION TRANSACTION READ ONLY');
    const songs = await lyricTruth();
    // An export of nothing is not a ground truth.
    if (!songs.length) throw new Error('no staff song has a corrected timeline yet: correct some in the song page first');
    mkdirSync(join(dir, 'annotations', 'staff'), { recursive: true });
    for (const s of songs) writeFileSync(join(dir, 'annotations', 'staff', `${s.songId}.json`), JSON.stringify(s.annotation, null, 1));
    writeFileSync(
      join(dir, 'songs.json'),
      JSON.stringify(songs.map(({ songId, providerRequestId, language, lyrics }) => ({ songId, providerRequestId, language, lyrics })), null, 1),
    );
    const by = (l: string) => songs.filter((s) => s.language === l).length;
    console.log(`${songs.length} songs (zh ${by('zh')}, ja ${by('ja')}, en ${by('en')}) -> ${dir}`);
    const missing = songs.filter((s) => !s.providerRequestId).length;
    if (missing) console.log(`${missing} have no DGX job id: their audio cannot be found on the DGX`);
  } else if (command === 'mfa-reset') {
    /*
     * The address comes from the command line, never from a file: an
     * operator's own address is not something this repository may hold.
     * Output names the account id only.
     */
    const args = process.argv.slice(3);
    const at = args.indexOf('--reason');
    const reason = at >= 0 ? (args[at + 1] ?? '') : '';
    const email = args.find((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1));
    if (!email) throw new Error('usage: mfa-reset <email> --reason "why"');
    const res = await resetMfaFactor({ email, reason });
    if (!res) {
      console.log('no live account has that address; nothing changed');
      process.exitCode = 1;
    } else if (!res.removed) {
      console.log(`account ${res.userId} has no second factor; nothing changed`);
    } else {
      console.log(
        `account ${res.userId}: second factor removed (was ${res.wasEnabled ? 'enabled' : 'pending'}, ${res.recoveryCodesLeft} recovery codes unused). ` +
          'Recorded in audit_logs as mfa.reset. The owner signs in with Google alone and can enrol again.',
      );
    }
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
