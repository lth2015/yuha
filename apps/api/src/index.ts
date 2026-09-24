import { closeDb, migrate } from '@yuha/db';
import { ConfigError, loadConfig } from './config.js';
import { createContext } from './context.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // §3.1: an invalid mode/adapter combination fails at start-up rather than
      // producing a half-real service.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const ctx = createContext(config);

  if (config.mode !== 'production') {
    // Production migrations run as a separate, reviewable step (see
    // infra/helm — a pre-upgrade job), not implicitly on pod start.
    const res = await migrate();
    if (res.applied.length) console.log(`applied migrations: ${res.applied.join(', ')}`);
  }

  const app = await buildServer(ctx);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: config.HOST });

  app.log.info(
    {
      mode: config.mode,
      adapters: config.adapters,
      commercialDelivery: false,
    },
    config.isDemo
      ? 'LOOPSCENE API started in DEMO mode — simulated payments, synthetic audio, no commercial licence'
      : `LOOPSCENE API started in ${config.mode} mode`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
