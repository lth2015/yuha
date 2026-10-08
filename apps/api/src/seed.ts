/**
 * Seeds the price catalogue, the Explore showcase songs and demo accounts.
 *
 * Product rows are the launch pricing baseline for the YUHA product. They are
 * versioned, and must be re-derived from signed supplier rates and a legal
 * review before anything is actually sold — seeding them is not approval to
 * charge.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  closeDb,
  migrate,
  query,
  setRole,
  upsertProduct,
  upsertUser,
  confirmAgeAndTerms,
  grantUnits,
  newId,
  withTx,
} from '@yuha/db';
import { loadConfig } from './config.js';
import { resolveFromRoot } from './paths.js';
import { catalogue, cataloguePrices } from './catalogue.js';
import { createContext } from './context.js';
import {
  blocksSelling,
  describePriceProblem,
  verifyStripeCatalogue,
} from './services/stripe-catalogue.js';

const config = loadConfig();
const ctx = createContext(config);

await migrate();

// ---------------------------------------------------------------- catalogue

// ---------------------------------------------------------------------------
// Priced in JPY, the launch market's currency, tax-inclusive as Japanese
// consumer law expects. Version 2: version 1 sold songs below what they cost
// to make — the modelled provider cost is 46 minor units per generation, and
// the old subscriptions billed 10 and 7.5. Every tier here clears cost with
// room for the ~10% of generations that fail (which the provider bills and
// the product absorbs, because a failed generation never spends a credit).
//
// The one-off pack and the monthly plan are the numbers PROJECT_TASK set
// originally; those were cost-aware, and the 2026-09 pivot to "100 songs a
// month" is what broke the economics.
//
// Orders keep the catalogue version they were bought at, so re-pricing never
// rewrites an existing receipt.
/*
 * Ask Stripe whether those four ids are the ones we meant — BEFORE writing
 * them.
 *
 * This ran after the upsert loop, which made the refusal a statement about
 * rows the same script had just made sellable: `upsertProduct` overwrites
 * `stripe_price_id`, so a database that was correct a minute ago now carries
 * the swapped id, and an API serving it will build Checkout sessions against
 * it. "Nothing may be sold against these" was printed about exactly that.
 * The check needs only `config`, so there was never a reason for it to be
 * second.
 *
 * The mistake it catches is a quiet one: the variable names come from internal
 * price keys (`STRIPE_PRICE_ID_PRO_MONTHLY`) while the dashboard shows CREATOR
 * and STUDIO, and the two subscriptions differ only in price. Swap them and
 * Checkout charges what the Stripe Price says while the order row carries the
 * catalogue amount — so a STUDIO buyer is charged ¥1,980 and the webhook's
 * amount guard throws afterwards, with the card already charged.
 *
 * What is fatal and what is not:
 *
 *   - a wrong, archived, duplicated or unreadable id → fatal;
 *   - an id that is simply NOT SET → reported, not fatal. Two of the four are
 *     required only when `FEATURE_SUBSCRIPTIONS_ENABLED`, and `config.ts`
 *     already refuses the ones that matter with the feature flag in hand.
 *     Treating a missing id as fatal here made `pnpm seed` and `pnpm
 *     bootstrap` refuse the stripe-with-subscriptions-off configuration that
 *     docs/CONFIGURATION.md tells people to use;
 *   - Stripe not answering → reported, not fatal. A 429 or an outage says
 *     nothing about whether an id is right, and failing a seed with four
 *     accusations about correct values is worse than not checking.
 */
const priceProblems = await verifyStripeCatalogue(ctx, cataloguePrices(config));
if (priceProblems === null) {
  console.log('• Stripe prices not checked: this deployment uses the simulated payments adapter');
} else {
  const blocking = priceProblems.filter(blocksSelling);
  for (const problem of priceProblems.filter((p) => !blocksSelling(p))) {
    console.log(`• ${describePriceProblem(problem)}`);
  }
  if (blocking.length > 0) {
    console.error('\n✗ the configured Stripe prices do not match the catalogue:\n');
    for (const problem of blocking) console.error(`  - ${describePriceProblem(problem)}`);
    console.error('\nNothing has been written. Fix the ids in the deployment configuration;');
    console.error('docs/CONFIGURATION.md lists which Stripe product belongs in which variable.');
    await closeDb();
    process.exit(1);
  }
  console.log(`✓ Stripe prices agree with the catalogue (amount, currency, interval, tax, active)`);
}

const CATALOGUE = catalogue(config);

for (const row of CATALOGUE) {
  await upsertProduct({
    price_key: row.price_key,
    version: row.version,
    kind: row.kind,
    display_name: row.display_name,
    amount_minor: row.amount_minor,
    currency: 'jpy',
    tax_included: true,
    units: row.units,
    validity_days: row.validity_days,
    auto_renew: row.auto_renew,
    billing_interval: row.billing_interval,
    stripe_price_id: row.stripe_price_id,
    active: true,
  });
}

console.log('✓ product catalogue seeded v2 (DROP / CREATOR / STUDIO / licence — JPY, tax-inclusive)');

// ------------------------------------------------------ explore showcase

/**
 * Publishes a handful of fully-synthesised songs to the public Explore feed so
 * the product does not open onto an empty screen. Every row states exactly what
 * it is: demo-local provenance, preview licence, no commercial claim.
 */
const SHOWCASE: Array<{
  fixture: string;
  title: string;
  artist: string;
  styles: string[];
  vocalMode: 'instrumental' | 'with_vocals';
  durationSeconds: number;
  plays: number;
}> = [
  { fixture: 'night_walk_calm-120s.mp3', title: 'Neon Rain', artist: 'Aoi', styles: ['lofi', 'chill', 'night'], vocalMode: 'instrumental', durationSeconds: 120, plays: 184 },
  { fixture: 'outfit_confident-120s.mp3', title: 'Chrome Heart', artist: 'Rin', styles: ['trap', 'fashion', 'confident'], vocalMode: 'with_vocals', durationSeconds: 120, plays: 142 },
  { fixture: 'gaming_tense-120s.mp3', title: 'Night Signal', artist: 'Kite', styles: ['synthwave', 'arcade', 'epic'], vocalMode: 'instrumental', durationSeconds: 120, plays: 121 },
  { fixture: 'daily_log_warm-120s.mp3', title: 'Golden Hour', artist: 'Mei', styles: ['vlog', 'acoustic', 'warm'], vocalMode: 'with_vocals', durationSeconds: 120, plays: 98 },
  { fixture: 'night_walk_dreamy-120s.mp3', title: 'Paper Moon', artist: 'Aoi', styles: ['ambient', 'dreamy'], vocalMode: 'instrumental', durationSeconds: 120, plays: 76 },
  { fixture: 'gaming_tense-60s.mp3', title: 'Cold Wire', artist: 'Kite', styles: ['dnb', 'tense', 'battle'], vocalMode: 'instrumental', durationSeconds: 60, plays: 54 },
];

async function seedShowcase() {
  if (config.adapters.music !== 'demo') return;

  const existing = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks WHERE visibility = 'public'`);
  if (Number(existing[0]?.n ?? 0) > 0) {
    console.log('✓ showcase songs already present, skipping');
    return;
  }

  const dir = resolveFromRoot(config.DEMO_FIXTURES_DIR ?? './assets/fixtures/audio');
  const artistIds = new Map<string, string>();

  for (const song of SHOWCASE) {
    let body: Buffer;
    try {
      body = await readFile(join(dir, song.fixture));
    } catch {
      console.warn(`! fixture ${song.fixture} missing — run "pnpm fixtures:audio" first`);
      continue;
    }

    if (!artistIds.has(song.artist)) {
      const email = `${song.artist.toLowerCase()}@showcase.sonare.demo`;
      const externalId = `dev-${Buffer.from(email).toString('hex').slice(0, 24)}`;
      const user = await upsertUser({ authProvider: 'dev', externalId, email, displayName: song.artist });
      await confirmAgeAndTerms({ userId: user.id, marketingOptIn: false });
      artistIds.set(song.artist, user.id);
    }
    const ownerId = artistIds.get(song.artist)!;

    const projectId = newId();
    await query(
      `INSERT INTO projects (id, owner_id, title, scene) VALUES (?, ?, ?, 'daily_log')`,
      [projectId, ownerId, `${song.artist} · Showcase`],
    );

    const jobId = newId();
    const input = {
      mode: 'simple',
      title: song.title,
      prompt: `showcase ${song.styles.join(' ')}`,
      lyrics: null,
      styles: song.styles,
      instrumental: song.vocalMode === 'instrumental',
      energy: 0.5,
      durationSeconds: song.durationSeconds,
      vocalMode: song.vocalMode,
      visibility: 'public',
    };
    await query(
      `INSERT INTO generation_jobs
         (id, user_id, project_id, idempotency_key, request_hash, state, input,
          provider_id, provider_model, provider_contract_version, provider_request_key,
          delivered_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'DELIVERED', ?, 'demo-local', 'demo-synth-v2', 'demo-no-contract', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      [jobId, ownerId, projectId, `showcase-${jobId}`, createHash('sha256').update(jobId).digest('hex'),
       JSON.stringify(input), `showcase-${jobId}`],
    );

    const sha = createHash('sha256').update(body).digest('hex');
    const trackId = newId();
    const storageKey = `${ownerId}/${trackId}/master-${sha.slice(0, 12)}.mp3`;
    await ctx.storage.put({ zone: 'delivery', key: storageKey, body, contentType: 'audio/mpeg' });

    await query(
      `INSERT INTO tracks (id, owner_id, project_id, job_id, title, scene, mood, duration_ms, state,
                           styles, lyrics, vocal_mode, visibility, play_count, cover_seed)
       VALUES (?, ?, ?, ?, ?, 'daily_log', 'calm', ?, 'deliverable', ?, NULL, ?, 'public', ?, ?)`,
      [trackId, ownerId, projectId, jobId, song.title, song.durationSeconds * 1000,
       JSON.stringify(song.styles), song.vocalMode, song.plays,
       createHash('sha256').update(`cover:${trackId}`).digest().readUInt32BE(0) % 0x7fffffff],
    );
    await query(
      `UPDATE generation_jobs SET track_id = ? WHERE id = ?`,
      [trackId, jobId],
    );
    await query(
      `INSERT INTO asset_versions (id, track_id, owner_id, kind, format, storage_key, byte_size, duration_ms, sha256, params_hash)
       VALUES (?, ?, ?, 'master', 'mp3', ?, ?, ?, ?, 'master')`,
      [newId(), trackId, ownerId, storageKey, body.byteLength, song.durationSeconds * 1000, sha],
    );
    await query(
      `INSERT INTO license_snapshots (id, track_id, user_id, provider_id, provider_model, contract_version,
         license_version, territory, allowed_uses, prohibited_uses, source_sha256, generated_at, commercial_delivery, status)
       VALUES (?, ?, ?, 'demo-local', 'demo-synth-v2', 'demo-no-contract', 'demo-preview-only', 'JP',
               ?, ?, ?, UTC_TIMESTAMP(3), 0, 'active')`,
      [newId(), trackId, ownerId,
       JSON.stringify(['Internal demo and preview only']),
       JSON.stringify(['Commercial use', 'Public redistribution', 'Presenting as licensed for commercial delivery']),
       sha],
    );
  }
  console.log(`✓ showcase: ${SHOWCASE.length} public demo songs published to Explore`);
}

await seedShowcase();

// ------------------------------------------------------------ demo accounts

if (config.mode !== 'production') {
  const accounts = [
    { email: 'creator@example.jp', name: 'Creator', role: 'user' as const, credits: 10, label: 'a creator with 10 credits' },
    { email: 'empty@example.jp', name: 'Newcomer', role: 'user' as const, credits: 0, label: 'a creator with no credits' },
    { email: 'support@example.jp', name: 'Support', role: 'support' as const, credits: 0, label: 'support staff' },
    { email: 'admin@example.jp', name: 'Admin', role: 'admin' as const, credits: 0, label: 'an administrator' },
  ];

  for (const acct of accounts) {
    const externalId = `dev-${Buffer.from(acct.email).toString('hex').slice(0, 24)}`;
    const user = await upsertUser({ authProvider: 'dev', externalId, email: acct.email, displayName: acct.name });
    await confirmAgeAndTerms({ userId: user.id, marketingOptIn: false });
    if (acct.role !== 'user') await setRole({ userId: user.id, role: acct.role });
    if (acct.credits > 0) {
      await withTx(async (tx) => {
        await grantUnits(
          {
            userId: user.id,
            source: 'manual_adjustment',
            sourceRef: `seed:${user.id}`,
            units: acct.credits,
            productKey: 'drop_5',
            priceVersion: 1,
            expiresAt: new Date(Date.now() + 90 * 86400_000),
            reason: 'seed_demo_credits',
          },
          tx,
        );
      });
    }
    console.log(`✓ ${acct.email.padEnd(22)} ${acct.label}`);
  }
  console.log('\n  Sign in from the web app with any of the addresses above.');
  console.log('  These are development identities and exist only outside production.');
}

await closeDb();
