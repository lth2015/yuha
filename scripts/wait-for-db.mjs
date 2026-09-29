#!/usr/bin/env node
/**
 * Blocks until MySQL accepts connections (used by `pnpm bootstrap`).
 *
 * It said Postgres, and defaulted to 5432, left over from the era when the
 * spec named Postgres. It only ever worked because DATABASE_URL always
 * carries an explicit port.
 * Uses a raw TCP probe plus the startup handshake so it has no dependencies of
 * its own and can run before `pnpm install` has finished linking workspaces.
 *
 * It reads no `.env` of its own: `bootstrap` runs it with
 * `--env-file-if-exists=.env`, the same way every other entry point in this
 * repository gets one. Without that flag `DATABASE_URL` is simply unset, which
 * is how `pnpm bootstrap` — the first command the runbook gives a new machine —
 * died on line one of this file.
 */
import { connect } from 'node:net';

const raw = process.argv[2] ?? process.env.DATABASE_URL ?? '';

/*
 * Parsed with the failure handled, not asserted afterwards.
 *
 * The usage message below used to sit under `new URL(raw)`, testing
 * `url.hostname` for empty. `new URL('')` throws, so the friendly line could
 * never print: an unset DATABASE_URL produced `TypeError: Invalid URL` and a
 * node stack trace instead of the one sentence that says what to do.
 */
let url;
try {
  url = new URL(raw);
} catch {
  url = null;
}
if (!url?.hostname) {
  console.error(
    raw
      ? `wait-for-db: ${JSON.stringify(raw)} is not a database URL`
      : 'wait-for-db: no database URL. Pass one, or set DATABASE_URL ' +
        '(pnpm scripts read it from .env via --env-file-if-exists).',
  );
  process.exit(1);
}

const host = url.hostname;
const port = Number.parseInt(url.port || '3306', 10);
const deadline = Date.now() + 60_000;

function probe() {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

for (;;) {
  if (await probe()) {
    // The port opens slightly before the server finishes initialising, so give
    // it a beat before the migration runner connects for real.
    await new Promise((r) => setTimeout(r, 500));
    console.log(`mysql is accepting connections on ${host}:${port}`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.error(`mysql at ${host}:${port} did not become ready within 60s`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
