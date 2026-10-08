import type { RemotePrice } from '@yuha/providers';
import type { AppContext } from '../context.js';

/**
 * Checking that each configured Stripe Price is the one we meant.
 *
 * The environment variable names come from internal price keys —
 * `STRIPE_PRICE_ID_PRO_MONTHLY`, `STRIPE_PRICE_ID_PREMIER_MONTHLY` — and the
 * Stripe dashboard shows the marketing names, CREATOR and STUDIO. Nobody
 * filling those four lines in has anything on screen that says which is
 * which, and two of them are subscriptions of the same shape differing only
 * in price. Pairing them up wrongly is a quiet, plausible mistake.
 *
 * Renaming the internal keys to match was the other option and was not taken:
 * `price_key` is the primary key of `product_catalog` and a foreign key from
 * `orders` and `subscriptions`, so it is a data migration rather than a
 * rename, and it would still only make the mistake less likely.
 *
 * Be precise about what this buys, because the first version of this comment
 * was not. It runs in `pnpm seed` and in `pnpm check:stripe-prices`, and both
 * are commands a person runs. CI does not run it — it has no live Stripe key —
 * and `check-prices.ts` explains why it is deliberately not at pod start-up.
 * The deployment path for a price-id change is "the ConfigMap changes and the
 * pods roll", which touches neither. So this is a check that exists and will
 * catch a swap when somebody runs it, not a guarantee that a swap cannot
 * ship.
 *
 * What a swap would have cost without this: Checkout charges whatever the
 * Stripe Price says while the order row carries the catalogue amount, so a
 * customer buying STUDIO would be charged ¥1,980, and the webhook's
 * amount-mismatch guard would then throw — after the card was charged. The
 * money moves first and the error arrives second, which is the wrong order.
 */

export interface CataloguePrice {
  priceKey: string;
  displayName: string;
  amountMinor: number;
  currency: string;
  /** 'month' for a monthly subscription; null for a one-off purchase. */
  interval: string | null;
  envVar: string;
  priceId: string | null;
}

export type PriceField = 'amount' | 'currency' | 'interval' | 'every' | 'tax' | 'active';

export type PriceProblem =
  /** The variable is not set. NOT by itself a reason to refuse: two of the
   *  four ids are only required when subscriptions are enabled, which is the
   *  caller's business and not this function's. */
  | { kind: 'missing'; priceKey: string; envVar: string }
  /** Stripe says there is no such Price: wrong account, wrong mode, deleted. */
  | { kind: 'unreadable'; priceKey: string; envVar: string; priceId: string }
  /** Could not ask — a network error, a bad key, a 429, an outage. Different
   *  from every other kind, because it says nothing about the configuration. */
  | { kind: 'unavailable'; priceKey: string; envVar: string; priceId: string; detail: string }
  /** Two variables hold the same Price, or two Prices of one Stripe product.
   *  Its own kind: this used to be reported as a `mismatch` with
   *  `field: 'amount'`, which produced "the catalogue says amount its own
   *  Price" and reported the same variable twice with contradictory text. */
  | { kind: 'duplicate'; priceKey: string; envVar: string; priceId: string; sharedWith: string[]; what: 'price' | 'product' }
  | {
      kind: 'mismatch';
      priceKey: string;
      envVar: string;
      priceId: string;
      field: PriceField;
      catalogue: string;
      stripe: string;
      /** The Stripe product's own name, which is what makes a swap readable. */
      stripeProduct: string | null;
    };

/**
 * Compares one catalogue row against the Price that is configured for it.
 *
 * Pure, and returns every disagreement rather than the first: an operator who
 * pasted two ids the wrong way round should be told about both slots in one
 * go, not fix one and re-run.
 */
export function comparePrice(row: CataloguePrice, remote: RemotePrice | null): PriceProblem[] {
  if (!row.priceId) return [{ kind: 'missing', priceKey: row.priceKey, envVar: row.envVar }];
  if (!remote) {
    return [
      { kind: 'unreadable', priceKey: row.priceKey, envVar: row.envVar, priceId: row.priceId },
    ];
  }

  const problems: PriceProblem[] = [];
  const mismatch = (field: PriceField, catalogue: string, stripe: string): void => {
    problems.push({
      kind: 'mismatch',
      priceKey: row.priceKey,
      envVar: row.envVar,
      priceId: row.priceId!,
      field,
      catalogue,
      stripe,
      stripeProduct: remote.productName,
    });
  };

  /*
   * An archived Price still resolves and still reads correctly in every other
   * field, and Checkout refuses it. So the one failure that looks completely
   * fine on inspection is checked first.
   */
  if (!remote.active) mismatch('active', 'active', 'archived');

  // null covers a tiered or metered Price, which this catalogue cannot
  // express at all; reported as a mismatch, never skipped.
  if (remote.amountMinor !== row.amountMinor) {
    mismatch('amount', String(row.amountMinor), remote.amountMinor === null ? 'not a fixed amount' : String(remote.amountMinor));
  }
  if (remote.currency.toLowerCase() !== row.currency.toLowerCase()) {
    mismatch('currency', row.currency.toLowerCase(), remote.currency.toLowerCase());
  }
  /*
   * A one-off sold as a subscription bills the customer every month for ever;
   * a subscription sold as a one-off bills once and renews never, while our
   * side keeps granting periods against invoices that will not arrive. Both
   * are worse than a wrong amount.
   */
  if ((remote.interval ?? null) !== row.interval) {
    mismatch('interval', row.interval ?? 'one-off', remote.interval ?? 'one-off');
  }
  /*
   * And how MANY intervals, which is the other half of a billing cycle.
   *
   * `interval: 'month', interval_count: 2` agrees on amount, currency,
   * interval and active state, and bills STUDIO every second month while this
   * side grants forty-five credits per invoice. It passed clean until this
   * line existed.
   */
  if (row.interval !== null && (remote.intervalCount ?? 1) !== 1) {
    mismatch('every', '1 interval', `${remote.intervalCount} intervals`);
  }
  /*
   * Tax, because the catalogue is tax-INCLUSIVE and says so on the page.
   *
   * A Price with `tax_behavior: 'exclusive'` adds tax on top of the ¥980 the
   * pricing page promised, which in Japan is both a worse number than
   * advertised and a 特定商取引法 problem. `unspecified` is Stripe's default
   * when Tax is not configured on the account and means no tax is added, so
   * it is accepted; only `exclusive` is wrong.
   */
  if (remote.taxBehavior === 'exclusive') {
    mismatch('tax', 'included in the price', 'added on top');
  }
  return problems;
}

/** Human-readable, and deliberately naming the Stripe product. */
export function describePriceProblem(p: PriceProblem): string {
  if (p.kind === 'missing') return `${p.envVar} is not set, so ${p.priceKey} cannot be sold`;
  if (p.kind === 'unreadable') {
    return `${p.envVar} is set to ${p.priceId}, which this Stripe account says does not exist — wrong account, wrong mode, or a deleted Price`;
  }
  if (p.kind === 'unavailable') {
    return `${p.envVar} could not be checked: Stripe did not answer (${p.detail}). This says nothing about whether the id is right.`;
  }
  if (p.kind === 'duplicate') {
    const what = p.what === 'price' ? 'the same Price' : "two Prices of Stripe's same product";
    return `${p.envVar} and ${p.sharedWith.join(', ')} point at ${what} (${p.priceId}) — one of them is in the wrong slot`;
  }
  const who = p.stripeProduct ? ` (Stripe calls it "${p.stripeProduct}")` : '';
  return `${p.envVar} points at ${p.priceId}${who}: the catalogue says ${p.field} ${p.catalogue}, Stripe says ${p.stripe}`;
}

/**
 * Whether a problem is a reason to refuse, as opposed to a reason to say
 * something.
 *
 * `missing` is not: two of the four ids are required only when subscriptions
 * are enabled, and treating an unset one as fatal made `pnpm seed` refuse the
 * stripe-with-subscriptions-off configuration that `docs/CONFIGURATION.md`
 * tells people to use. `config.ts` already refuses the ones that matter, and
 * it knows about the feature flag.
 *
 * `unavailable` is not either: a Stripe outage must not stop a deployment or a
 * seed, and the whole point of separating that kind was to stop reporting an
 * outage as a wrong id.
 */
export function blocksSelling(p: PriceProblem): boolean {
  return p.kind === 'mismatch' || p.kind === 'unreadable' || p.kind === 'duplicate';
}

/**
 * Reads every configured Price and reports what disagrees.
 *
 * Not run at pod start-up, on purpose: it is a network call to a third party,
 * and a Stripe outage must not stop a deployment that is already serving. It
 * runs in `seed.ts`, which is where the catalogue is written and therefore the
 * last moment before anything can be sold, and from `pnpm check:stripe-prices`
 * for a deployment nobody is re-seeding.
 *
 * Returns `null` for "could not check", which is different from "nothing is
 * wrong" and is what the simulated adapter gets.
 */
export async function verifyStripeCatalogue(
  ctx: AppContext,
  rows: CataloguePrice[],
): Promise<PriceProblem[] | null> {
  const retrieve = ctx.payments.retrievePrice?.bind(ctx.payments);
  if (!retrieve) return null;

  const problems: PriceProblem[] = [];
  const fetched = new Map<string, RemotePrice>();

  for (const row of rows) {
    if (!row.priceId) {
      problems.push({ kind: 'missing', priceKey: row.priceKey, envVar: row.envVar });
      continue;
    }
    let remote: RemotePrice | null;
    try {
      remote = await retrieve(row.priceId);
    } catch (err) {
      // Stripe did not answer. Reported as its own kind, because saying "that
      // id is wrong" about a 429 sends an operator to change four correct
      // values.
      problems.push({
        kind: 'unavailable',
        priceKey: row.priceKey,
        envVar: row.envVar,
        priceId: row.priceId,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (remote) fetched.set(row.envVar, remote);
    problems.push(...comparePrice(row, remote));
  }

  /*
   * And two checks that are not per-row, because every row can agree with the
   * Price it names while two rows name the same thing.
   *
   * Paste the CREATOR id into both subscription slots and each comparison
   * passes for the one it matches and fails on amount for the other, which
   * reads as "somebody mistyped a price" and sends the operator to change the
   * amount instead of the id. The second check is the same mistake one level
   * up: two DIFFERENT Price ids created under one Stripe product, which is
   * what "I made a new Price for CREATOR and pasted it into the STUDIO slot"
   * actually looks like, and which comparing ids cannot see.
   */
  problems.push(...shared(rows, (row) => row.priceId, 'price'));
  /*
   * The product pass skips any group that is really the SAME Price, because
   * two variables holding one id necessarily hold one product too — reporting
   * both is the same double-report this kind was introduced to remove, one
   * level up.
   */
  problems.push(
    ...shared(rows, (row) => fetched.get(row.envVar)?.productId ?? null, 'product').filter(
      (p) => p.kind === 'duplicate' && !sameIdEverywhere(rows, [p.envVar, ...p.sharedWith]),
    ),
  );
  return problems;
}

function sameIdEverywhere(rows: CataloguePrice[], envVars: string[]): boolean {
  const ids = new Set(envVars.map((v) => rows.find((r) => r.envVar === v)?.priceId));
  return ids.size === 1;
}

function shared(
  rows: CataloguePrice[],
  keyOf: (row: CataloguePrice) => string | null,
  what: 'price' | 'product',
): PriceProblem[] {
  const groups = new Map<string, CataloguePrice[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out: PriceProblem[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    // One problem per group, not one per member: the earlier version pushed a
    // row for each variable and so reported the same slot twice, with
    // different text each time.
    out.push({
      kind: 'duplicate',
      priceKey: group[0]!.priceKey,
      envVar: group[0]!.envVar,
      priceId: key,
      sharedWith: group.slice(1).map((r) => r.envVar),
      what,
    });
  }
  return out;
}
