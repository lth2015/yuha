import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ConfigError, createContext, loadConfig } from '@yuha/api';
import { closeDb } from '@yuha/db';
import {
  generationLoop,
  maintenanceLoop,
  makeLogger,
  outboxLoop,
  pollingLoop,
  webhookLoop,
  type LoopDeps,
} from './loops.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const ctx = createContext(config);
  const log = makeLogger('worker');

  // Identifies this process in job leases, so a crashed worker's jobs are
  // recognisably its own and are re-claimed once the lease expires.
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  if (!(await ctx.audio.available())) {
    log('error', 'ffmpeg is not available — audio checks and exports cannot run');
    process.exit(1);
  }

  let stopping = false;
  const deps: LoopDeps = { ctx, owner, log, stopped: () => stopping };

  log('info', 'worker starting', {
    owner,
    mode: config.mode,
    music: ctx.music.capabilities().providerId,
    queue: ctx.queue.kind,
  });

  const loops = [
    outboxLoop(deps),
    generationLoop(deps),
    pollingLoop(deps),
    webhookLoop(deps),
    maintenanceLoop(deps),
  ];

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutting down', { signal });
    // Give in-flight steps a moment to finish; leases expire on their own if not.
    await Promise.race([Promise.allSettled(loops), new Promise((r) => setTimeout(r, 15_000))]);
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await Promise.all(loops);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
