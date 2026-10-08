import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  buildServer,
  createContext,
  loadConfig,
  DevAuthAdapter,
  type AppContext,
} from '@yuha/api';
import {
  closeDb,
  confirmAgeAndTerms,
  grantUnits,
  migrate,
  query,
  setChainCursor,
  setRole,
  truncateAll,
  upsertProduct,
  upsertUser,
  withTx,
} from '@yuha/db';
import {
  ChainNode,
  DualChainReader,
  JPYC_POLYGON,
  USDC_POLYGON,
} from '@yuha/providers';

/**
 * Test harness.
 *
 * Runs against a REAL MySQL instance, never an in-memory stand-in.
 * PROJECT_TASK.md §12.1 is explicit that ledger transactions, concurrency and
 * unique constraints must be verified against the actual database — an
 * in-memory balance would prove nothing about the constraints that do the work.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'mysql://loopscene:loopscene_local_test@localhost:53307/loopscene_test';

let storageRoot: string | undefined;

export interface Harness {
  ctx: AppContext;
  app: FastifyInstance;
  auth: DevAuthAdapter;
  /** Creates a confirmed user and returns a usable bearer token. */
  createUser(params?: { email?: string; credits?: number; role?: 'user' | 'support' | 'admin' }): Promise<TestUser>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  authHeader: Record<string, string>;
}

export async function createHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  storageRoot ??= await mkdtemp(join(tmpdir(), 'loopscene-test-storage-'));

  const env: NodeJS.ProcessEnv = {
    RUN_MODE: 'demo',
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    DEV_AUTH_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    STORAGE_SIGNING_SECRET: 'test-signing-0123456789abcdef0123456789abcd',
    STORAGE_LOCAL_ROOT: storageRoot,
    DEMO_FIXTURES_DIR: './assets/fixtures/audio',
    // Fast enough that tests do not wait on artificial latency.
    DEMO_LATENCY_MS: '0',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    PUBLIC_WEB_URL: 'http://localhost:5173',
    PUBLIC_API_URL: 'http://localhost:4000',
    MAX_CONCURRENT_JOBS_PER_USER: '10',
    GENERATION_RATE_LIMIT_PER_HOUR: '1000',
    EXPORT_RATE_LIMIT_PER_HOUR: '1000',
    ...overrides,
  };

  const config = loadConfig(env);
  const ctx = createContext(config);
  await migrate();
  // resetData rather than seedCatalogue alone: it truncates first, so the
  // catalogue can be rewritten from scratch below regardless of what a
  // previous run left behind.
  await resetData();

  const app = await buildServer(ctx);
  await app.ready();

  const auth = new DevAuthAdapter({ secret: env.DEV_AUTH_SECRET! });

  return {
    ctx,
    app,
    auth,
    async createUser(params = {}) {
      const email = params.email ?? `user-${randomUUID().slice(0, 8)}@example.test`;
      const externalId = `dev-${Buffer.from(email).toString('hex').slice(0, 24)}`;
      const user = await upsertUser({ authProvider: 'dev', externalId, email });
      await confirmAgeAndTerms({ userId: user.id, marketingOptIn: false });
      if (params.role && params.role !== 'user') await setRole({ userId: user.id, role: params.role });
      if (params.credits) {
        await withTx(async (tx) => {
          await grantUnits(
            {
              userId: user.id,
              source: 'manual_adjustment',
              sourceRef: `test:${randomUUID()}`,
              units: params.credits!,
              productKey: 'drop_5',
              priceVersion: 1,
              expiresAt: new Date(Date.now() + 90 * 86400_000),
              reason: 'test_grant',
            },
            tx,
          );
        });
      }
      const { token } = auth.issue({ externalId, email });
      return { id: user.id, email, token, authHeader: { authorization: `Bearer ${token}` } };
    },
    reset: resetData,
    async close() {
      await app.close();
    },
  };
}

/*
 * Priced in JPY, matching apps/api/src/seed.ts.
 *
 * This used to seed USD 499/999/2999 while production seeds JPY
 * 980/1980/3980 — harmless for tests that only care that a number is
 * consistent, and not harmless at all for anything that converts a price.
 * A stablecoin quote inheriting this fixture would have had its arithmetic
 * verified against $4.99.
 *
 * The unit counts are deliberately NOT production's (15 and 45): a great many
 * tests assert on credit balances, and this change is about the prices that
 * get converted. The mismatch is recorded here rather than left implied.
 */
async function seedCatalogue(): Promise<void> {
  /*
   * Cleared first, and that is not tidiness.
   *
   * `upsertProduct` refuses to redefine an existing version's commercial
   * terms — correctly, since a version is what an order was placed against.
   * So a database left holding an older fixture (or one a test mutated) makes
   * every subsequent `seedCatalogue` throw, and the symptom is 26 unrelated
   * files failing at once, which reads as deep breakage rather than a stale
   * row. Rewriting the catalogue from nothing makes the fixtures idempotent
   * across changes to them. Safe because the callers truncate orders and
   * subscriptions first, so nothing references these rows.
   */
  await query(`DELETE FROM product_catalog`);
  await upsertProduct({
    price_key: 'drop_5',
    version: 2,
    kind: 'one_time',
    display_name: 'DROP — 5 songs',
    amount_minor: 980,
    currency: 'jpy',
    tax_included: true,
    units: 5,
    validity_days: 90,
    auto_renew: false,
    billing_interval: null,
    stripe_price_id: 'price_test_drop5',
    active: true,
  });
  await upsertProduct({
    price_key: 'pro_monthly',
    version: 1,
    kind: 'subscription',
    display_name: 'CREATOR — 15 songs / month',
    amount_minor: 1980,
    currency: 'jpy',
    tax_included: true,
    units: 100,
    validity_days: null,
    auto_renew: true,
    billing_interval: 'month',
    stripe_price_id: 'price_test_pro',
    active: true,
  });
  await upsertProduct({
    price_key: 'market_license',
    version: 1,
    kind: 'one_time',
    display_name: 'Licence — one song',
    amount_minor: 980,
    currency: 'jpy',
    tax_included: true,
    units: 1,
    validity_days: null,
    auto_renew: false,
    billing_interval: null,
    stripe_price_id: 'price_test_market',
    active: true,
  });
  await upsertProduct({
    price_key: 'premier_monthly',
    version: 1,
    kind: 'subscription',
    display_name: 'STUDIO — 45 songs / month',
    amount_minor: 3980,
    currency: 'jpy',
    tax_included: true,
    units: 400,
    validity_days: null,
    auto_renew: true,
    billing_interval: 'month',
    stripe_price_id: 'price_test_premier',
    active: true,
  });
}

/**
 * Truncates business data between tests, keeping the schema and catalogue.
 * MySQL cannot CASCADE, so `truncateAll` disables foreign-key checks for the
 * duration and clears every table explicitly.
 */
const BUSINESS_TABLES = [
  // Not clearing this let a cursor from one file decide another file's
  // `start_block`, so an observation that was fine became "older than the
  // quote". The fifth explicit list this work has had to be remembered into.
  'order_reviews',
  'chain_cursors',
  'chain_transfer_events',
  'stablecoin_orphan_transfers',
  'stablecoin_attempts',
  'stablecoin_intents',
  'stablecoin_quotes',
  'verified_wallets',
  'wallet_challenges',
  'known_sign_in_sources',
  'mfa_factors',
  'track_licenses',
  'auth_codes',
  'ledger_entries',
  'entitlement_batches',
  'asset_versions',
  'license_snapshots',
  'provider_cost_events',
  'generation_attempts',
  'rights_cases',
  'tracks',
  'generation_jobs',
  'projects',
  'payments',
  'subscriptions',
  'orders',
  'webhook_events',
  'outbox',
  'local_queue_messages',
  'audit_logs',
  'analytics_events',
  'runtime_settings',
  // Before users: it has a foreign key to them, both as the subject and as the
  // operator who verified it.
  'account_deletions',
  'users',
];

export async function resetData(): Promise<void> {
  await truncateAll(BUSINESS_TABLES);
  await seedCatalogue();
}

export async function teardown(): Promise<void> {
  await closeDb();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
}

/** Convenience: the raw balance numbers straight from the database. */
export async function balanceOf(userId: string): Promise<{ available: number; reserved: number; consumed: number }> {
  const rows = await query<{ granted: number; reserved: number; consumed: number }>(
    `SELECT COALESCE(SUM(granted_units), 0)  AS granted,
            COALESCE(SUM(reserved_units), 0) AS reserved,
            COALESCE(SUM(consumed_units), 0) AS consumed
       FROM entitlement_batches
      WHERE user_id = ? AND status = 'active'`,
    [userId],
  );
  const r = rows[0]!;
  const granted = Number(r.granted);
  const reserved = Number(r.reserved);
  const consumed = Number(r.consumed);
  return { available: granted - reserved - consumed, reserved, consumed };
}

/** Ledger entries for one job, for asserting exactly-once semantics. */
export async function ledgerFor(jobId: string): Promise<Array<{ entry_type: string; units: number }>> {
  return query<{ entry_type: string; units: number }>(
    `SELECT entry_type, units FROM ledger_entries WHERE job_id = ? ORDER BY created_at, entry_type`,
    [jobId],
  );
}

/**
 * A chain reader that answers the two startup questions truthfully.
 *
 * Quoting now asks the chain what `decimals()` each configured token reports,
 * before computing an amount from the constant in `tokens.ts` — the check
 * existed only in the worker, which does not compute quotes or deliver
 * anything. Tests that quote therefore need an answer, and giving them a real
 * `DualChainReader` over a fake transport means the gate itself is exercised
 * rather than bypassed.
 *
 * Anything else it is asked for throws, deliberately: a test that starts
 * needing block data should say so rather than silently receive zeroes.
 */
export function verifiedChainStub(chainId = 137): DualChainReader {
  const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  const decimalsOf = (to: string): number | undefined => {
    const a = to.toLowerCase();
    if (a === JPYC_POLYGON.address) return JPYC_POLYGON.decimals;
    if (a === USDC_POLYGON.address) return USDC_POLYGON.decimals;
    return undefined;
  };
  const node = (label: string) =>
    new ChainNode({
      label,
      async request(method: string, params: readonly unknown[]) {
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
        if (method === 'eth_call') {
          const to = (params[0] as { to: string }).to;
          const decimals = decimalsOf(to);
          if (decimals === undefined) throw new Error(`the chain stub was asked about ${to}`);
          return word(decimals);
        }
        throw new Error(`the chain stub was asked for ${method}`);
      },
    });
  return new DualChainReader(node('stub-primary'), node('stub-secondary'));
}

/**
 * Puts the scan cursor somewhere, because quoting refuses to price a payment
 * nothing is watching for.
 *
 * `start_block` used to default to zero when no cursor existed, which disabled
 * the only bound on how OLD a satisfying transfer may be — any historical
 * transfer from a verified wallet could settle a brand-new quote. The default
 * is now a refusal, so a test that wants a quote says where the watcher is.
 */
export async function seedScanCursor(block: bigint, chainId = 137): Promise<void> {
  await setChainCursor({ chainId, stream: 'stablecoin_incoming', block });
}
