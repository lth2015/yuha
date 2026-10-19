import { upsertProduct } from '@yuha/db';
import type { AppConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { catalogue, cataloguePrices } from '../catalogue.js';
import { blocksSelling, describePriceProblem, verifyStripeCatalogue } from './stripe-catalogue.js';

/**
 * Writes the price catalogue into `product_catalog`, after asking Stripe
 * whether the configured price ids are the ones meant.
 *
 * Lifted out of `seed.ts` so it can run on its own. `seed` also creates the
 * development accounts (outside production) and the demo showcase songs,
 * which is right for a laptop and wrong for a live database — and until this
 * existed, `seed` was the only way to get a catalogue row written at all. The
 * deployed migration job writes the schema and no products, so a fresh
 * environment served an empty `/v1/products` and the pricing page said there
 * was nothing to buy. `sync-catalogue.ts` is the command for that: catalogue
 * and nothing else.
 *
 * Returns false when it refused to write (a configured price id that Stripe
 * says is wrong); nothing has been written in that case.
 */
export async function syncCatalogue(
  ctx: AppContext,
  config: AppConfig,
  log: (line: string) => void = (line) => console.log(line),
  fail: (line: string) => void = (line) => console.error(line),
): Promise<boolean> {

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
    log('• Stripe prices not checked: this deployment uses the simulated payments adapter');
  } else {
    const blocking = priceProblems.filter(blocksSelling);
    for (const problem of priceProblems.filter((p) => !blocksSelling(p))) {
      log(`• ${describePriceProblem(problem)}`);
    }
    if (blocking.length > 0) {
      fail('\n✗ the configured Stripe prices do not match the catalogue:\n');
      for (const problem of blocking) fail(`  - ${describePriceProblem(problem)}`);
      fail('\nNo catalogue row has been written (the migrations above have run).');
      fail('Fix the ids in the deployment configuration; docs/CONFIGURATION.md lists');
      fail('which Stripe product belongs in which variable.');
      return false;
    }
    /*
     * A tick only when a comparison actually happened.
     *
     * `blocking.length === 0` is also true when every row came back
     * `unavailable` — a 429, an expired key, an outage — and the old line then
     * printed "Stripe prices agree with the catalogue" about four values nothing
     * had looked at, in the script that goes on to make them sellable. The same
     * for `missing`: an unset id is reported and then seeded as NULL.
     */
    const compared = cataloguePrices(config).filter(
      (row) => !priceProblems.some((p) => p.envVar === row.envVar && (p.kind === 'unavailable' || p.kind === 'missing')),
    );
    if (compared.length === 0) {
      log('• no Stripe price was compared — nothing below is evidence that the ids are right');
    } else if (compared.length < 4) {
      log(`✓ ${compared.length} of 4 Stripe prices agree with the catalogue; the rest were not compared`);
    } else {
      log('✓ Stripe prices agree with the catalogue (amount, currency, interval, tax, active)');
    }
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

  log(
    `✓ product catalogue seeded (${CATALOGUE.map((r) => `${r.price_key} v${r.version}`).join(', ')} — JPY, tax-inclusive)`,
  );
  return true;
}
