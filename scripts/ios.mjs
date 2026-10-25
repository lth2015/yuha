#!/usr/bin/env node
// Public build boundary: only an explicit environment + a public HTTPS origin
// enter the app. Vite's normal Web .env files are disabled for native builds.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const [command, ...args] = process.argv.slice(2);
try {
  if (!['build', 'sync', 'open', 'config'].includes(command) || args.length !== 2 || args[0] !== '--environment' ||
      !['development', 'staging', 'production'].includes(args[1])) {
    throw new Error('Usage: pnpm ios:<build|sync|open|config> --environment development|staging|production');
  }
  const environment = args[1];
  const raw = process.env.IOS_API_URL || (environment === 'production' ? 'https://yuha.studio' : '');
  let url;
  try { url = new URL(raw); } catch { /* reported below without echoing input */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('IOS_API_URL must be an HTTPS origin without credentials, path, query or fragment');
  }
  if (environment !== 'production' && url.origin === 'https://yuha.studio') {
    throw new Error('Use --environment production for the production API');
  }
  if (environment === 'production' && url.origin !== 'https://yuha.studio') {
    throw new Error('Production builds require the approved https://yuha.studio API origin');
  }
  const env = { ...process.env, VITE_APP_PLATFORM: 'ios', VITE_API_URL: url.origin, VITE_IOS_ENVIRONMENT: environment };
  if (command === 'config') {
    console.log(JSON.stringify({ environment, apiOrigin: url.origin, appId: 'studio.yuha.app', webDir: 'dist-ios' }));
  } else {
    const run = (args) => {
      const result = spawnSync('pnpm', ['--filter', '@yuha/web', ...args], { cwd: root, env, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`iOS ${args[0]} failed (${result.status})`);
    };
    if (command !== 'open') {
      run(['typecheck']);
      run(['exec', 'vite', 'build', '--mode', 'ios']);
      const licenses = join(root, 'apps/web/dist-ios/licenses');
      mkdirSync(licenses, { recursive: true });
      for (const family of ['noto-sans-sc', 'noto-sans-jp']) {
        copyFileSync(join(root, 'apps/web/node_modules/@fontsource-variable', family, 'LICENSE'),
          join(licenses, `${family}-OFL.txt`));
      }
      if (command === 'sync') run(['exec', 'cap', 'sync', 'ios']);
    } else run(['exec', 'cap', 'open', 'ios']);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
