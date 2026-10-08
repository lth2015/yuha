#!/usr/bin/env node
/**
 * Can this machine actually run the product, and if not, exactly why?
 *
 * Written because "the tests cannot run here" was repeated for fourteen
 * commits on the strength of `node -v` printing v20 and Docker not being up.
 * nvm had Node 24 installed the whole time and Docker Desktop was sitting in
 * /Applications. Every check below therefore reports what it found, what it
 * needed, and the command that closes the gap — never just "failed".
 *
 *   node scripts/preflight.mjs [--verbose]
 *
 * Exit code 0 means the local stack can serve a human acceptance pass.
 * Optional capabilities that are switched off are reported, not failed: demo
 * mode is a legitimate way to accept most of this product.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const blockers = [];
const warnings = [];
const notes = [];

const pass = (what, detail) => console.log(`  ok    ${what}${detail ? ` — ${detail}` : ''}`);
const fail = (what, found, fix) => {
  console.log(`  FAIL  ${what}`);
  blockers.push({ what, found, fix });
};
const warn = (what, found, fix) => {
  console.log(`  warn  ${what}`);
  warnings.push({ what, found, fix });
};

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch {
    return null;
  }
}

function tcp(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
  });
}

// ─────────────────────────────────────────────────────────────── toolchain
console.log('\ntoolchain');

const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) {
  pass('node', `v${process.versions.node}`);
} else {
  // The exact trap from this repo's history: a newer Node is often installed
  // but not the active one. Look before declaring the machine insufficient.
  let hint = 'install Node 22 or newer';
  const nvmDir = join(process.env.HOME ?? '', '.nvm/versions/node');
  if (existsSync(nvmDir)) {
    const newer = readdirSync(nvmDir)
      .filter((v) => Number(v.replace(/^v/, '').split('.')[0]) >= 22)
      .sort();
    if (newer.length) {
      hint = `nvm already has ${newer[newer.length - 1]} installed — \`nvm use ${newer[newer.length - 1]}\``;
    }
  }
  fail('node', `v${process.versions.node}, need >= 22`, hint);
}

const pnpmVersion = sh('pnpm', ['--version']);
pnpmVersion ? pass('pnpm', `v${pnpmVersion}`) : fail('pnpm', 'not on PATH', 'npm i -g pnpm');

if (existsSync(join(ROOT, 'node_modules'))) pass('dependencies installed');
else fail('dependencies', 'node_modules missing', 'pnpm install');

// ────────────────────────────────────────────────────────────────── docker
console.log('\ncontainers');

const dockerUp = sh('docker', ['info', '--format', '{{.ServerVersion}}']);
if (dockerUp) {
  pass('docker daemon', `v${dockerUp}`);

  const names = sh('docker', ['ps', '--format', '{{.Names}}']) ?? '';
  for (const c of ['loopscene-mysql', 'loopscene-mysql-test']) {
    if (names.split('\n').includes(c)) {
      const health = sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', c]);
      health === 'healthy'
        ? pass(c, 'healthy')
        : warn(c, `state ${health ?? 'unknown'}`, 'give it a few seconds, then re-run');
    } else {
      fail(c, 'not running', 'pnpm db:up');
    }
  }
} else {
  const app = '/Applications/Docker.app';
  fail(
    'docker daemon',
    'not responding',
    existsSync(app) ? 'Docker Desktop is installed but not started — `open -a Docker`' : 'install Docker Desktop',
  );
}

// ───────────────────────────────────────────────────────────── environment
console.log('\nconfiguration');

const envPath = join(ROOT, '.env');
let env = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  pass('.env present', `${Object.keys(env).length} keys`);
} else {
  fail('.env', 'missing', 'cp .env.example .env');
}

const runMode = env.RUN_MODE ?? 'demo';
if (['demo', 'integration', 'production'].includes(runMode)) {
  pass('RUN_MODE', runMode);
  if (runMode === 'production') {
    warn('RUN_MODE', 'production', 'acceptance on a laptop should use demo or integration');
  }
} else {
  fail('RUN_MODE', runMode || 'unset', 'demo | integration | production');
}

// ────────────────────────────────────────────────────────────────── database
console.log('\ndatabase');

const dbUrl = env.DATABASE_URL ?? 'mysql://loopscene:loopscene_local_dev@localhost:53306/loopscene_dev';
let dbName = 'loopscene_dev';
try {
  const u = new URL(dbUrl);
  dbName = u.pathname.replace(/^\//, '') || dbName;
  const reachable = await tcp(u.hostname, Number(u.port || 3306));
  reachable ? pass('reachable', `${u.hostname}:${u.port}`) : fail('reachable', `${u.hostname}:${u.port} refused`, 'pnpm db:up');
} catch {
  fail('DATABASE_URL', 'unparseable', 'see .env.example');
}

function mysql(sql) {
  return sh('docker', [
    'exec', 'loopscene-mysql', 'mysql',
    '-uloopscene', '-ploopscene_local_dev', dbName, '-N', '-e', sql,
  ]);
}

const migrationDir = join(ROOT, 'packages/db/src/migrations');
const onDisk = existsSync(migrationDir) ? readdirSync(migrationDir).filter((f) => f.endsWith('.sql')) : [];
const appliedRaw = mysql('SELECT COUNT(*) FROM schema_migrations');
if (appliedRaw === null) {
  fail('migrations', 'could not query schema_migrations', 'pnpm db:migrate');
} else {
  const applied = Number(appliedRaw);
  applied >= onDisk.length && onDisk.length > 0
    ? pass('migrations', `${applied} applied, ${onDisk.length} on disk`)
    : fail('migrations', `${applied} applied, ${onDisk.length} on disk`, 'pnpm db:migrate');
}

const products = Number(mysql('SELECT COUNT(*) FROM product_catalog') ?? 0);
products > 0 ? pass('catalogue seeded', `${products} products`) : fail('catalogue', 'empty', 'pnpm seed');

const users = Number(mysql("SELECT COUNT(*) FROM users WHERE email LIKE '%@example.jp'") ?? 0);
users > 0 ? pass('demo accounts', `${users} seeded`) : warn('demo accounts', 'none', 'pnpm seed');

// ───────────────────────────────────────────────────────────────── fixtures
console.log('\nassets');

const fx = join(ROOT, 'assets/fixtures/audio');
const mp3s = existsSync(fx) ? readdirSync(fx).filter((f) => f.endsWith('.mp3')) : [];
mp3s.length
  ? pass('demo audio fixtures', `${mp3s.length} files`)
  : fail('demo audio fixtures', 'none', 'pnpm fixtures:audio');

// ──────────────────────────────────────────────────────────────────── ports
console.log('\nports');
for (const [port, what] of [[4000, 'api'], [5173, 'web']]) {
  const busy = await tcp('127.0.0.1', port, 400);
  busy ? notes.push(`port ${port} (${what}) is already serving — \`pnpm dev\` will fail unless that is us`) : pass(`${port} free`, what);
}

// ─────────────────────────────────────────────── optional real integrations
console.log('\noptional capabilities (off is fine — demo mode covers most acceptance)');

const has = (k) => Boolean(env[k] && !env[k].startsWith('REPLACE'));

const google = has('GOOGLE_CLIENT_ID') && has('GOOGLE_CLIENT_SECRET') && has('GOOGLE_REDIRECT_URI');
console.log(`  ${google ? 'on ' : 'off'}   real Google sign-in${google ? '' : ' — fill GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI in .env'}`);
if (!google) notes.push('dev login is active: sign in with creator@example.jp on /auth');

const stripe = has('STRIPE_SECRET_KEY') && has('STRIPE_WEBHOOK_SECRET');
console.log(`  ${stripe ? 'on ' : 'off'}   real Stripe checkout (test mode)${stripe ? '' : ' — fill STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET in .env'}`);
if (stripe && !env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
  fail('STRIPE_SECRET_KEY', 'not a test key', 'acceptance must never run against a live key');
}
if (!stripe) notes.push('payments are simulated: checkout completes without leaving the machine');
/*
 * The price ids too, and all four of them.
 *
 * This file promises it "says exactly what is missing", and for Stripe it
 * checked the key and the webhook secret only — while the API refuses to start
 * without an id for every product in the catalogue. So the thing meant to
 * predict the failure could not see it, and the failure itself arrives either
 * at boot or, for a product that was not checked at boot either, as a 500 on
 * the one page that takes money.
 */
if (stripe) {
  const priceKeys = [
    'STRIPE_PRICE_ID_DROP_5',
    'STRIPE_PRICE_ID_PRO_MONTHLY',
    'STRIPE_PRICE_ID_PREMIER_MONTHLY',
    'STRIPE_PRICE_ID_MARKET_LICENSE',
  ];
  const missing = priceKeys.filter((k) => !has(k));
  if (missing.length) {
    fail(
      missing.join(' / '),
      'no price id',
      'PAYMENTS_ADAPTER=stripe needs one live/test price id per catalogue row — `pnpm stripe:setup --apply` prints them',
    );
  }
  if (!has('STRIPE_API_VERSION')) {
    notes.push(
      'STRIPE_API_VERSION is unset: requests use whatever version the installed SDK pins. ' +
        'Fine locally, refused in production — 2025-03-31.basil is the version this code reads.',
    );
  }
}

const musicAdapter = env.MUSIC_ADAPTER ?? 'demo';
console.log(`  ${musicAdapter === 'demo' ? 'off' : 'on '}   real music provider — adapter is "${musicAdapter}"`);
if (musicAdapter === 'demo') notes.push('audio is synthesised from fixtures; no provider agreement is signed');

// ────────────────────────────────────────────────────────────────── verdict
console.log('');
if (notes.length && VERBOSE) for (const n of notes) console.log(`note: ${n}`);

if (warnings.length) {
  console.log(`${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ${w.what}: ${w.found}\n    → ${w.fix}`);
  console.log('');
}

if (blockers.length) {
  console.log(`${blockers.length} thing(s) stop the stack from running:\n`);
  for (const b of blockers) console.log(`  ${b.what}: ${b.found}\n    → ${b.fix}\n`);
  process.exit(1);
}

console.log('✓ ready. `pnpm dev` then open http://localhost:5173');
if (!VERBOSE && notes.length) console.log(`  (${notes.length} note(s) — re-run with --verbose)`);
