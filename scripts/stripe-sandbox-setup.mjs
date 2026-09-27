#!/usr/bin/env node
/**
 * Create this product's catalogue in a Stripe **test** sandbox.
 *
 * Doing it by hand in the dashboard is how the amounts drift. The prices a
 * buyer is shown come from `product_catalog`; the amount actually charged
 * comes from the Stripe Price. If those two disagree, the 最終確認画面 states
 * a figure the buyer is not charged, which is a 特定商取引法 problem and one
 * this product has already had once — it rendered ¥980 as $9.80.
 *
 * So the amounts are read from the database and never typed here.
 *
 *   node scripts/stripe-sandbox-setup.mjs            # show what it would do
 *   node scripts/stripe-sandbox-setup.mjs --apply    # create, then print the ids
 *
 * Safe to re-run: a Price is reused when one already exists with the same
 * lookup key, currency, amount and interval. Stripe Prices are immutable, so a
 * changed amount creates a new Price and the old one is reported, not edited.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

// ---- key, and a hard refusal on anything that is not a sandbox -------------
const env = {};
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
}
const key = process.env.STRIPE_SECRET_KEY || env.STRIPE_SECRET_KEY || '';
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set (put it in .env, which is git-ignored).');
  process.exit(1);
}
if (!key.startsWith('sk_test_')) {
  // Never negotiable. A live key here would create real products on a real
  // account from a script written for a sandbox.
  console.error(`refusing to run: the key starts "${key.slice(0, 8)}…" and must start "sk_test_".`);
  process.exit(1);
}

// ---- the catalogue is the database, not this file -------------------------
const require = createRequire(join(ROOT, 'packages/db/package.json'));
const mysql = require('mysql2/promise');
const dbUrl = process.env.DATABASE_URL || env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const conn = await mysql.createConnection(dbUrl);
/*
 * `active`, not `available`: the API's ProductView carries an `available`
 * field computed in `toProductView`, and there is no such column.
 *
 * Newest active version **per price key**, matching `listProducts`. A global
 * MAX(version) was wrong and would have quietly dropped every other product
 * the moment one of them was versioned up — which is exactly what happened
 * when PREMIER moved to v3.
 */
const [rows] = await conn.execute(
  `SELECT price_key, kind, amount_minor, currency, units, display_name
     FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY price_key ORDER BY version DESC) AS rn
         FROM product_catalog WHERE active = 1
     ) ranked WHERE rn = 1
      ORDER BY amount_minor`,
);
await conn.end();

if (!rows.length) {
  console.error('product_catalog is empty — run `pnpm seed` first.');
  process.exit(1);
}

const stripeRequire = createRequire(join(ROOT, 'packages/providers/package.json'));
const Stripe = stripeRequire('stripe');
const stripe = new Stripe(key, { apiVersion: '2024-12-18.acacia' });

/**
 * Stripe's `unit_amount` is in the currency's smallest unit, and so is
 * `amount_minor`. For JPY the smallest unit is the yen itself, so 980 means
 * ¥980 on both sides and there is no conversion. Asserted rather than assumed,
 * because assuming it is how this codebase produced "$9.80" for a ¥980 pack.
 */
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd']);
function unitAmountFor(row) {
  const cur = String(row.currency).toLowerCase();
  if (!ZERO_DECIMAL.has(cur) && row.amount_minor % 1 !== 0) {
    throw new Error(`amount_minor for ${row.price_key} is not an integer`);
  }
  return Number(row.amount_minor);
}

/*
 * Stripe refuses a Checkout Session whose line item has no product tax code:
 *
 *   "Invalid line_items[0]: the product tax code is missing."
 *
 * Only a live call surfaces that. `txcd_10000000` — "General - Electronically
 * Supplied Services" — is Stripe's documented catch-all for a digital service
 * and is used so the sandbox works. **Which code is correct is a tax
 * determination, not an engineering one**: a music service might belong under
 * a digital-audio or SaaS code instead, and that changes what is charged in
 * some jurisdictions. Override it once someone qualified has decided.
 */
const TAX_CODE = process.env.STRIPE_TAX_CODE || env.STRIPE_TAX_CODE || 'txcd_10000000';

const results = [];
for (const row of rows) {
  const cur = String(row.currency).toLowerCase();
  const amount = unitAmountFor(row);
  const recurring = row.kind === 'subscription' ? { interval: 'month' } : undefined;
  const lookup = `yuha_${row.price_key}`;
  const human = `${row.display_name} — ${cur.toUpperCase()} ${amount}${recurring ? '/month' : ''}`;

  if (!APPLY) {
    results.push({ price_key: row.price_key, would_create: human, lookup_key: lookup });
    continue;
  }

  // Reuse a Price that already matches exactly; Prices cannot be edited.
  const existing = await stripe.prices.list({ lookup_keys: [lookup], expand: ['data.product'], limit: 1 });
  let price = existing.data[0];
  const matches =
    price &&
    price.active &&
    price.currency === cur &&
    price.unit_amount === amount &&
    Boolean(price.recurring) === Boolean(recurring) &&
    (!recurring || price.recurring.interval === 'month');

  if (!matches) {
    if (price) {
      // Free the lookup key so the new Price can take it, and say so.
      await stripe.prices.update(price.id, { lookup_key: null });
      console.log(`  note: ${row.price_key} changed; the old Price ${price.id} is left inactive-by-replacement`);
    }
    const product = await stripe.products.create({
      name: row.display_name,
      tax_code: TAX_CODE,
      metadata: { price_key: row.price_key, units: String(row.units), source: 'yuha catalogue' },
    });
    price = await stripe.prices.create({
      product: product.id,
      currency: cur,
      unit_amount: amount,
      lookup_key: lookup,
      transfer_lookup_key: true,
      ...(recurring ? { recurring } : {}),
      // 税込: the catalogue stores tax-inclusive amounts, so Stripe must not
      // add tax on top of the figure the confirmation screen already showed.
      tax_behavior: 'inclusive',
      metadata: { price_key: row.price_key },
    });
  }

  // A reused Price may hang off a Product created before the tax code was
  // required. Products, unlike Prices, can be updated.
  const productId = typeof price.product === 'string' ? price.product : price.product?.id;
  if (productId) {
    const prod = await stripe.products.retrieve(productId);
    if (prod.tax_code !== TAX_CODE) {
      await stripe.products.update(productId, { tax_code: TAX_CODE });
      console.log(`  set tax_code ${TAX_CODE} on ${row.price_key}`);
    }
  }

  results.push({ price_key: row.price_key, price_id: price.id, amount: `${cur.toUpperCase()} ${amount}`, reused: Boolean(matches) });
}

if (!APPLY) {
  console.log('\ndry run — nothing was created. What it would make:\n');
  for (const r of results) console.log(`  ${r.price_key.padEnd(18)} ${r.would_create}`);
  console.log('\nRe-run with --apply to create them.');
  process.exit(0);
}

const ENV_NAME = {
  drop_5: 'STRIPE_PRICE_ID_DROP_5',
  pro_monthly: 'STRIPE_PRICE_ID_PRO_MONTHLY',
  premier_monthly: 'STRIPE_PRICE_ID_PREMIER_MONTHLY',
  market_license: 'STRIPE_PRICE_ID_MARKET_LICENSE',
};

console.log('\ncreated / reused:\n');
for (const r of results) {
  console.log(`  ${r.price_key.padEnd(18)} ${r.price_id}  ${r.amount}${r.reused ? '  (reused)' : ''}`);
}
console.log('\nPaste into .env:\n');
for (const r of results) {
  if (ENV_NAME[r.price_key]) console.log(`${ENV_NAME[r.price_key]}=${r.price_id}`);
}
console.log('\nRe-run `pnpm seed` afterwards: seed.ts copies these into product_catalog.stripe_price_id,');
console.log('which is the column checkout actually reads.');
