/**
 * Asks Stripe whether the configured price ids are the ones we meant.
 *
 * The same check `syncCatalogue` runs before writing, available on its own because a deployment
 * that is already up is not re-seeded to change a price id — the ConfigMap
 * changes and the pods roll. Reads nothing but the catalogue and Stripe, and
 * writes nothing anywhere.
 *
 * Deliberately NOT part of pod start-up: it is a network call to a third
 * party, and a Stripe outage must not stop a deployment that is serving
 * correctly.
 *
 *   pnpm check:stripe-prices
 */
import { activeCataloguePriceIds, closeDb } from '@yuha/db';
import { ConfigError, loadConfig } from './config.js';
import { cataloguePrices } from './catalogue.js';
import { createContext } from './context.js';
import {
  blocksSelling,
  catalogueDrift,
  describePriceProblem,
  verifyStripeCatalogue,
} from './services/stripe-catalogue.js';

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
const rows = cataloguePrices(config);
const fromStripe = await verifyStripeCatalogue(ctx, rows);

/*
 * And the database, because that is what Checkout reads.
 *
 * `verifyStripeCatalogue` compares the environment variables against Stripe.
 * `createCheckout` compares nothing — it uses
 * `product_catalog.stripe_price_id`, which only `syncCatalogue` writes
 * (`sync-catalogue` in a deployment, `pnpm seed` locally). The documented
 * path for a price change moves the variable and rolls the pods, so without
 * this the command would have reported four ticks about ids no purchase uses.
 *
 * Read even when payments are simulated: there is no Stripe to ask then, but
 * an empty catalogue still means the pricing page has nothing to sell, and
 * "nothing to check" was the answer this command gave about exactly that.
 */
let problems = fromStripe ?? [];
let catalogueRead = false;
try {
  problems = [...problems, ...catalogueDrift(rows, await activeCataloguePriceIds())];
  catalogueRead = true;
} catch (err) {
  console.error(`• could not read product_catalog (${err instanceof Error ? err.message : String(err)}).`);
  if (fromStripe !== null) {
    console.error('  The ids below were compared against Stripe only, not against what this');
    console.error('  deployment will actually sell.');
  }
}

if (fromStripe === null) {
  console.log('• Stripe prices not checked: this deployment uses the simulated payments adapter');
  await closeDb();
  // No tick about a table nobody read: with no Stripe to ask, the catalogue
  // was the only thing left to check.
  if (!catalogueRead) process.exit(1);
  const blocking = problems.filter(blocksSelling);
  for (const p of blocking) console.error(`✗ ${describePriceProblem(p)}`);
  if (blocking.length > 0) process.exit(1);
  console.log(`✓ product_catalog has all ${rows.length} products`);
  process.exit(0);
}

/*
 * Grouped by the variable a person has to go and change — except for a
 * `duplicate`, which is ABOUT two variables and carries the others in
 * `sharedWith`. Keying the whole report on `envVar` would have hidden it from
 * every slot but the first one listed.
 */
const owners = (p: (typeof problems)[number]): string[] =>
  p.kind === 'duplicate' ? [p.envVar, ...p.sharedWith] : [p.envVar];

for (const row of rows) {
  const mine = problems.filter((p) => owners(p).includes(row.envVar));
  const mark = mine.length === 0 ? '✓' : mine.some(blocksSelling) ? '✗' : '•';
  console.log(
    `${mark} ${row.envVar}  →  ${row.displayName}  ` +
      `${row.amountMinor} ${row.currency}${row.interval ? ` / ${row.interval}` : ''}`,
  );
  for (const p of mine) console.log(`    ${describePriceProblem(p)}`);
}

await closeDb();

const blocking = problems.filter(blocksSelling);
if (blocking.length > 0) {
  console.error('\nNothing may be sold against these. docs/CONFIGURATION.md lists which');
  console.error('Stripe product belongs in which variable.');
  process.exit(1);
}
if (problems.length > 0) {
  // `missing` and `unavailable` only: an unset id for a product this
  // deployment does not sell, or Stripe not answering. Neither is a reason to
  // fail, and neither is a reason to print a tick either.
  console.log('\nNothing wrong with the ids that are set; the notes above are not failures.');
  process.exit(0);
}
console.log(
  `\n${rows.length} prices agree with the catalogue (amount, currency, interval, tax, active).`,
);
