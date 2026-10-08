import type { AppConfig } from './config.js';
import type { CataloguePrice } from './services/stripe-catalogue.js';

/*
 * One list, because there used to be two.
 *
 * The four `upsertProduct` calls wrote the catalogue, and a second array
 * written beside them told the Stripe check what to compare against. Two
 * lists of the same four products is the shape this repository has been bitten
 * by five times: the fifth product gets added to one of them, and the check
 * that was supposed to notice is the thing that stops looking.
 *
 * So the rows are the single source, and everything else is derived from them
 * — including the environment variable name, which is mechanically
 * `STRIPE_PRICE_ID_<PRICE_KEY>`. That derivation is why the internal keys can
 * stay as they are while the Stripe-facing names (CREATOR, STUDIO) live in
 * `stripeProduct` below, where a human filling in the configuration can read
 * them.
 */
export function catalogue(config: AppConfig) {
  return [
    {
      price_key: 'drop_5',
      version: 2,
      kind: 'one_time' as const,
      display_name: 'DROP — 5 songs',
      amount_minor: 980,
      units: 5,
      validity_days: 90,
      auto_renew: false,
      billing_interval: null,
      /** What this is called in the Stripe dashboard. */
      stripeProduct: 'DROP — 5 songs',
      stripe_price_id: config.STRIPE_PRICE_ID_DROP_5 ?? null,
    },
    {
      price_key: 'pro_monthly',
      version: 2,
      kind: 'subscription' as const,
      display_name: 'CREATOR — 15 songs / month',
      amount_minor: 1980,
      // 15, not the 20 the original spec named: the difference absorbs billable
      // failures without pushing the margin under 60%.
      units: 15,
      validity_days: null,
      auto_renew: true,
      billing_interval: 'month' as const,
      stripeProduct: 'CREATOR — 15 songs / month',
      stripe_price_id: config.STRIPE_PRICE_ID_PRO_MONTHLY ?? null,
    },
    {
      /*
       * PREMIER moved to 3,980 as catalogue v3.
       *
       * A new version rather than an edit: `subscriptions` and `orders` carry
       * the `price_version` they were sold at, and `getProductVersion` resolves
       * by (price_key, version) without filtering on `active`. So a subscriber
       * on v2 keeps renewing at the price they agreed to, while v2 is no longer
       * offered. Editing the v2 row in place would silently reprice existing
       * subscriptions.
       *
       * Stripe Prices are immutable for the same reason; the v3 row carries a
       * new price id and the old Price is left alone.
       */
      price_key: 'premier_monthly',
      version: 3,
      kind: 'subscription' as const,
      display_name: 'STUDIO — 45 songs / month',
      amount_minor: 3980,
      units: 45,
      validity_days: null,
      auto_renew: true,
      billing_interval: 'month' as const,
      stripeProduct: 'STUDIO — 45 songs / month',
      stripe_price_id: config.STRIPE_PRICE_ID_PREMIER_MONTHLY ?? null,
    },
    {
      price_key: 'market_license',
      version: 2,
      kind: 'one_time' as const,
      display_name: 'Licence — one song',
      amount_minor: 980,
      units: 1,
      validity_days: null,
      auto_renew: false,
      billing_interval: null,
      stripeProduct: 'Licence — one song',
      stripe_price_id: config.STRIPE_PRICE_ID_MARKET_LICENSE ?? null,
    },
  ] as const;
}

/**
 * The same rows, shaped for the Stripe price check.
 *
 * The environment variable name is DERIVED rather than written down:
 * `STRIPE_PRICE_ID_<PRICE_KEY>`. A hand-written mapping is the thing the fifth
 * product is missing from, and a check that silently stops covering a product
 * is worse than no check — `tests/stripe-catalogue.test.ts` holds the
 * derivation against `config.ts`'s start-up requirements.
 */
export function cataloguePrices(config: AppConfig): CataloguePrice[] {
  return catalogue(config).map((row) => ({
    priceKey: row.price_key,
    // The Stripe-facing name, so a mismatch report can say "Stripe calls this
    // CREATOR" instead of only comparing numbers.
    displayName: row.stripeProduct,
    amountMinor: row.amount_minor,
    currency: 'jpy',
    interval: row.billing_interval,
    // Every row is tax-inclusive, as Japanese consumer law expects, and the
    // comparison reads it from here rather than assuming it.
    taxIncluded: true,
    envVar: `STRIPE_PRICE_ID_${row.price_key.toUpperCase()}`,
    priceId: row.stripe_price_id,
  }));
}
