#!/usr/bin/env node
/**
 * Blocks until MySQL accepts connections (used by `pnpm bootstrap`).
 *
 * It said Postgres, and defaulted to 5432, left over from the era when the
 * spec named Postgres. It only ever worked because DATABASE_URL always
 * carries an explicit port.
 * Uses a raw TCP probe plus the startup handshake so it has no dependencies of
 * its own and can run before `pnpm install` has finished linking workspaces.
 */
import { connect } from 'node:net';

const url = new URL(process.argv[2] ?? process.env.DATABASE_URL ?? '');
if (!url.hostname) {
  console.error('usage: wait-for-db.mjs <mysql-url>   (or set DATABASE_URL)');
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
    console.log(`postgres is accepting connections on ${host}:${port}`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.error(`postgres at ${host}:${port} did not become ready within 60s`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
