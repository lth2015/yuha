/**
 * What the migration runner says when a file was left half-applied.
 *
 * MySQL commits DDL implicitly, so a migration that fails at statement 2 keeps
 * statement 1's effect and is never recorded in `schema_migrations`. The next
 * run replays statement 1 and fails on its own earlier work — and the error it
 * printed said only "Duplicate column name", which reads like the migration is
 * wrong rather than like the database is half-way through it. These tests pin
 * the added explanation, and pin that it stays off for unrelated failures.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate, query } from '@yuha/db';
import { createHarness, teardown, type Harness } from './helpers/harness.js';

const PROBE_FILE = '9001_migrate_partial_probe.sql';
const PROBE_TABLE = 'migrate_partial_probe';

let h: Harness;
let dir: string;

beforeAll(async () => {
  h = await createHarness();
  dir = await mkdtemp(join(tmpdir(), 'loopscene-migrate-'));
  // Two statements, so "applied the first, not the second" is representable.
  await writeFile(
    join(dir, PROBE_FILE),
    `CREATE TABLE ${PROBE_TABLE} (id INT PRIMARY KEY)\n` +
      `-- ;;\n` +
      `ALTER TABLE ${PROBE_TABLE} ADD COLUMN note VARCHAR(8) NULL\n`,
  );
});

afterAll(async () => {
  await query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
  await query('DELETE FROM schema_migrations WHERE name = ?', [PROBE_FILE]);
  await rm(dir, { recursive: true, force: true });
  await h?.close();
  await teardown();
});

it('explains that the schema is half-migrated when a statement collides with its own earlier run', async () => {
  const first = await migrate(dir);
  expect(first.applied).toContain(PROBE_FILE);

  // Exactly the state a mid-file failure leaves behind: the DDL stands, the
  // bookkeeping row does not.
  await query('DELETE FROM schema_migrations WHERE name = ?', [PROBE_FILE]);

  const err = await migrate(dir).then(
    () => null,
    (e: unknown) => e as Error,
  );

  expect(err, 'a replayed CREATE TABLE must fail, not succeed quietly').not.toBeNull();
  const message = err!.message;
  expect(message).toContain(`migration ${PROBE_FILE} failed at statement 1/2`);
  expect(message).toContain('half-migrated');
  expect(message).toContain('pnpm db:reset');
  // The original MySQL text survives; the hint is added to it, not instead of it.
  expect(message).toContain(PROBE_TABLE);
  expect((err as Error & { cause?: { errno?: number } }).cause?.errno).toBe(1050);
});

it('stays quiet about half-migration when the failure is something else', async () => {
  const otherDir = await mkdtemp(join(tmpdir(), 'loopscene-migrate-'));
  try {
    await writeFile(
      join(otherDir, '9002_bad_reference.sql'),
      'ALTER TABLE table_that_does_not_exist_anywhere ADD COLUMN x INT NULL\n',
    );

    const err = await migrate(otherDir).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).not.toBeNull();
    expect(err!.message).toContain('9002_bad_reference.sql failed at statement 1/1');
    expect(err!.message).not.toContain('half-migrated');
  } finally {
    await query('DELETE FROM schema_migrations WHERE name = ?', ['9002_bad_reference.sql']);
    await rm(otherDir, { recursive: true, force: true });
  }
});
