/**
 * Checking that each configured Stripe Price is the one we meant.
 *
 * The environment variable names come from internal price keys —
 * `STRIPE_PRICE_ID_PRO_MONTHLY`, `STRIPE_PRICE_ID_PREMIER_MONTHLY` — and the
 * Stripe dashboard shows CREATOR and STUDIO. Nobody filling those four lines
 * in has anything on screen saying which is which, and the two subscriptions
 * differ only in price.
 *
 * What a swap costs without this check: Checkout charges whatever the Stripe
 * Price says while the order row carries the catalogue amount, so a STUDIO
 * buyer is charged ¥1,980 and the webhook's amount guard throws — after the
 * card is charged. The money moves first and the error arrives second.
 *
 * Renaming `price_key` to match Stripe was the other option. It is the primary
 * key of `product_catalog` and a foreign key from `orders` and
 * `subscriptions`, so it is a migration rather than a rename, and it would
 * still only make the mistake less likely.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StripePaymentsAdapter, type RemotePrice } from '@yuha/providers';
import {
  blocksSelling,
  catalogueDrift,
  comparePrice,
  describePriceProblem,
  verifyStripeCatalogue,
  type CataloguePrice,
} from '../apps/api/src/services/stripe-catalogue.js';
import { catalogue, cataloguePrices } from '../apps/api/src/catalogue.js';
import type { AppConfig } from '../apps/api/src/config.js';

const root = resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const studio: CataloguePrice = {
  priceKey: 'premier_monthly',
  displayName: 'STUDIO — 45 songs / month',
  amountMinor: 3980,
  currency: 'jpy',
  interval: 'month',
  taxIncluded: true,
  envVar: 'STRIPE_PRICE_ID_PREMIER_MONTHLY',
  priceId: 'price_studio',
};

const remote = (over: Partial<RemotePrice> = {}): RemotePrice => ({
  id: 'price_studio',
  active: true,
  amountMinor: 3980,
  currency: 'jpy',
  interval: 'month',
  intervalCount: 1,
  taxBehavior: 'inclusive',
  billingScheme: 'per_unit',
  usageType: 'licensed',
  productId: 'prod_studio',
  productName: 'STUDIO — 45 songs / month',
  productActive: true,
  ...over,
});

describe('comparing one configured price against the catalogue', () => {
  it('says nothing when they agree', () => {
    expect(comparePrice(studio, remote())).toEqual([]);
  });

  it('catches the swap it exists for, and names the Stripe product', () => {
    // The CREATOR price id pasted into the STUDIO slot.
    const problems = comparePrice(
      studio,
      remote({ id: 'price_creator', amountMinor: 1980, productName: 'CREATOR — 15 songs / month' }),
    );
    expect(problems).toHaveLength(1);
    const described = describePriceProblem(problems[0]!);
    // The amount alone would read as "somebody mistyped a price". The product
    // name is what makes it read as "these two are the wrong way round".
    expect(described).toContain('CREATOR');
    expect(described).toContain('STRIPE_PRICE_ID_PREMIER_MONTHLY');
  });

  it('catches an archived price, which is otherwise identical', () => {
    /*
     * The one failure that looks completely fine on inspection: every field
     * agrees, and Checkout refuses the session. Without this the first symptom
     * is a customer who cannot buy.
     */
    const problems = comparePrice(studio, remote({ active: false }));
    expect(problems.map((p) => p.kind === 'mismatch' && p.field)).toContain('active');
  });

  it('catches a one-off sold as a subscription, and the reverse', () => {
    /*
     * Worse than a wrong amount in both directions. A one-off configured as
     * recurring bills the customer every month for ever; a subscription
     * configured as one-off bills once and renews never, while our side keeps
     * waiting for invoices that will not arrive.
     */
    const asOneOff = comparePrice(studio, remote({ interval: null }));
    expect(asOneOff.map((p) => p.kind === 'mismatch' && p.field)).toContain('interval');

    const drop: CataloguePrice = { ...studio, priceKey: 'drop_5', amountMinor: 980, interval: null };
    const asRecurring = comparePrice(drop, remote({ amountMinor: 980, interval: 'month' }));
    expect(asRecurring.map((p) => p.kind === 'mismatch' && p.field)).toContain('interval');
  });

  it('catches a price billed every second month', () => {
    /*
     * `interval: 'month', interval_count: 2` agrees on amount, currency,
     * interval and active state, and bills STUDIO every second month while
     * this side grants forty-five credits per invoice. Half the revenue for
     * the same cost, and nothing else notices.
     */
    const problems = comparePrice(studio, remote({ intervalCount: 2 }));
    expect(problems.map((p) => p.kind === 'mismatch' && p.field)).toContain('every');
    expect(describePriceProblem(problems[0]!)).toContain('2 intervals');

    // And a one-off has no interval count to be wrong about.
    const drop: CataloguePrice = { ...studio, priceKey: 'drop_5', amountMinor: 980, interval: null };
    expect(
      comparePrice(drop, remote({ amountMinor: 980, interval: null, intervalCount: null })),
    ).toEqual([]);
  });

  it('catches a price that adds tax on top of a tax-inclusive catalogue', () => {
    /*
     * The catalogue is tax-inclusive, as Japanese consumer law expects, and
     * the pricing page says ¥980. `tax_behavior: 'exclusive'` charges tax on
     * top of that — a worse number than advertised, and a 特定商取引法
     * problem rather than only an accounting one.
     */
    const problems = comparePrice(studio, remote({ taxBehavior: 'exclusive' }));
    expect(problems.map((p) => p.kind === 'mismatch' && p.field)).toContain('tax');

    /*
     * `unspecified` is Stripe's default when Tax is not configured on the
     * account, and means no tax is added — so it is accepted. Refusing it
     * would refuse every correctly-configured account that does not use
     * Stripe Tax.
     */
    expect(comparePrice(studio, remote({ taxBehavior: 'unspecified' }))).toEqual([]);
    expect(comparePrice(studio, remote({ taxBehavior: null }))).toEqual([]);
  });

  it('catches a metered price, which agrees on every other field and bills nothing', () => {
    /*
     * The gap the comment in the adapter denied. A `usage_type: 'metered'`
     * Price carries a non-null `unit_amount` — it is the rate per reported
     * unit — so amount, currency, interval and active all agreed. Stripe then
     * bills zero at each period because nothing reports usage, `invoice.paid`
     * arrives with `amount_paid: 0`, and the webhook grants a month of credits
     * against it. Free STUDIO, for ever, with the configuration check green.
     */
    const problems = comparePrice(studio, remote({ usageType: 'metered' }));
    expect(problems.map((p) => p.kind === 'mismatch' && p.field)).toContain('metered');
    expect(describePriceProblem(problems[0]!)).toContain('reported usage');
  });

  it('catches an archived Stripe product behind an active price', () => {
    /*
     * Every field on the Price agrees and Stripe refuses the Checkout Session
     * at purchase time, so without this the first symptom is every sale of
     * that SKU answering 500 while the check says the configuration is fine.
     */
    const problems = comparePrice(studio, remote({ productActive: false }));
    expect(problems.map((p) => p.kind === 'mismatch' && p.field)).toContain('product');

    // Unknown is not archived: a product that was not expanded says nothing.
    expect(comparePrice(studio, remote({ productActive: null }))).toEqual([]);
  });

  it('names a tiered price as tiered rather than only as a missing amount', () => {
    const problems = comparePrice(studio, remote({ billingScheme: 'tiered', amountMinor: null }));
    expect(problems.map((p) => p.kind === 'mismatch' && p.field)).toContain('tiered');
  });

  it('compares tax behaviour against the catalogue row, not a literal', () => {
    // The check compared Stripe against the hard-coded string 'exclusive', so
    // it was asserting "this catalogue is tax-inclusive" without asking the
    // catalogue. A tax-exclusive row would have been reported as wrong.
    expect(comparePrice(studio, remote({ taxBehavior: 'exclusive' })).length).toBe(1);
    const exclusiveRow: CataloguePrice = { ...studio, taxIncluded: false };
    expect(comparePrice(exclusiveRow, remote({ taxBehavior: 'exclusive' }))).toEqual([]);
    expect(comparePrice(exclusiveRow, remote({ taxBehavior: 'inclusive' })).length).toBe(1);
  });

  it('catches a currency change', () => {
    const problems = comparePrice(studio, remote({ currency: 'usd' }));
    expect(problems.map((p) => p.kind === 'mismatch' && p.field)).toContain('currency');
  });

  it('treats a tiered or metered price as a mismatch, not as nothing to check', () => {
    // `unit_amount` is null for a Price this catalogue cannot express. Skipping
    // it would report agreement about a price we cannot read.
    const problems = comparePrice(studio, remote({ amountMinor: null }));
    expect(problems).toHaveLength(1);
    expect(describePriceProblem(problems[0]!)).toContain('not a fixed amount');
  });

  it('reports every disagreement, not the first', () => {
    // An operator who pasted two ids the wrong way round should be told about
    // both fields at once rather than fixing one and re-running.
    const problems = comparePrice(studio, remote({ amountMinor: 980, currency: 'usd', interval: null }));
    expect(problems).toHaveLength(3);
  });

  it('separates "not configured" from "configured wrongly"', () => {
    const missing = comparePrice({ ...studio, priceId: null }, null);
    expect(missing[0]!.kind).toBe('missing');

    const unreadable = comparePrice(studio, null);
    expect(unreadable[0]!.kind).toBe('unreadable');
    // Wrong account or wrong mode is the usual cause, and the message says so:
    // a test-mode id in a live deployment resolves to nothing.
    expect(describePriceProblem(unreadable[0]!)).toContain('mode');
  });

  it('knows which problems are a reason to refuse and which are only worth saying', () => {
    /*
     * `missing` is not a refusal. Two of the four ids are required only when
     * subscriptions are enabled, and treating an unset one as fatal made
     * `pnpm seed` refuse the stripe-with-subscriptions-off configuration that
     * docs/CONFIGURATION.md tells people to use — `config.ts` already refuses
     * the ones that matter, with the feature flag in hand.
     *
     * `unavailable` is not either: a 429 or an outage says nothing about
     * whether an id is right, and failing a seed with four accusations about
     * correct values is worse than not checking.
     */
    expect(blocksSelling({ kind: 'missing', priceKey: 'x', envVar: 'X' })).toBe(false);
    expect(
      blocksSelling({ kind: 'unavailable', priceKey: 'x', envVar: 'X', priceId: 'p', detail: 'timeout' }),
    ).toBe(false);

    expect(blocksSelling(comparePrice(studio, remote({ amountMinor: 1 }))[0]!)).toBe(true);
    expect(blocksSelling(comparePrice(studio, null)[0]!)).toBe(true);
  });
});

describe('checking the whole catalogue', () => {
  const ctxFor = (prices: Record<string, RemotePrice | null | Error> | null) =>
    ({
      payments: prices
        ? {
            retrievePrice: async (id: string) => {
              const v = prices[id];
              // A throw is Stripe not answering; `null` is Stripe saying the
              // Price does not exist. The adapter draws that line too, and
              // conflating them is what produced four confident accusations
              // about correct ids during an outage.
              if (v instanceof Error) throw v;
              return v ?? null;
            },
          }
        : {},
    }) as never;

  const rows = (): CataloguePrice[] => [
    { ...studio, priceKey: 'pro_monthly', envVar: 'STRIPE_PRICE_ID_PRO_MONTHLY', displayName: 'CREATOR — 15 songs / month', amountMinor: 1980, priceId: 'price_creator' },
    studio,
  ];

  it('reports null when it cannot check, which is not the same as agreement', async () => {
    // The simulated adapter has no Prices to read. Returning [] would say
    // "everything agrees" about something never looked at.
    expect(await verifyStripeCatalogue(ctxFor(null), rows())).toBeNull();
  });

  it('passes a correctly configured catalogue', async () => {
    const problems = await verifyStripeCatalogue(
      ctxFor({
        // Its own Stripe product, which is what a correctly configured
        // catalogue looks like — the default fixture shares `productId`, and
        // leaving that in place made this test fail for the right reason.
        price_creator: remote({
          id: 'price_creator',
          amountMinor: 1980,
          productId: 'prod_creator',
          productName: 'CREATOR — 15 songs / month',
        }),
        price_studio: remote(),
      }),
      rows(),
    );
    expect(problems).toEqual([]);
  });

  it('says plainly when one id is used twice, once', async () => {
    /*
     * Paste the CREATOR id into both subscription slots and every per-row
     * comparison still does its job: one matches, the other reports a wrong
     * amount. That reads as "somebody mistyped a price" rather than "you used
     * one id twice", and the operator fixes the amount instead of the id.
     *
     * The first version of this reported it as a `mismatch` with
     * `field: 'amount'`, once per variable — so PREMIER_MONTHLY appeared twice
     * with contradictory text, and one of the lines read "the catalogue says
     * amount its own Price", which is not a sentence. Hence a kind of its own,
     * and ONE problem per group.
     */
    const creator = remote({ id: 'price_creator', amountMinor: 1980, productName: 'CREATOR — 15 songs / month' });
    const problems = await verifyStripeCatalogue(
      ctxFor({ price_creator: creator }),
      rows().map((r) => ({ ...r, priceId: 'price_creator' })),
    );

    const duplicates = problems.filter((p) => p.kind === 'duplicate');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ what: 'price', sharedWith: ['STRIPE_PRICE_ID_PREMIER_MONTHLY'] });
    const described = describePriceProblem(duplicates[0]!);
    expect(described).toContain('STRIPE_PRICE_ID_PRO_MONTHLY');
    expect(described).toContain('STRIPE_PRICE_ID_PREMIER_MONTHLY');
    expect(described).toContain('wrong slot');
    // And nothing claims a field is wrong when the field is not the problem.
    expect(described).not.toContain('amount its own Price');
    expect(blocksSelling(duplicates[0]!)).toBe(true);
  });

  it('catches two different ids that are two Prices of one Stripe product', async () => {
    /*
     * What "I made a new Price for CREATOR and pasted it into the STUDIO slot"
     * actually looks like: two distinct `price_…` ids, so comparing ids sees
     * nothing. The Stripe product id is what gives it away, and it was being
     * read from the API and then never looked at.
     */
    const problems = await verifyStripeCatalogue(
      ctxFor({
        price_creator: remote({ id: 'price_creator', amountMinor: 1980, productId: 'prod_creator', productName: 'CREATOR — 15 songs / month' }),
        price_creator_v2: remote({ id: 'price_creator_v2', amountMinor: 3980, productId: 'prod_creator', productName: 'CREATOR — 15 songs / month' }),
      }),
      [
        { ...rows()[0]!, priceId: 'price_creator' },
        { ...rows()[1]!, priceId: 'price_creator_v2' },
      ],
    );

    const duplicates = problems.filter((p) => p.kind === 'duplicate');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ what: 'product' });
    expect(describePriceProblem(duplicates[0]!)).toContain("two Prices of Stripe's same product");
  });

  it('reports Stripe not answering as its own thing, and does not block on it', async () => {
    /*
     * A bare `catch { return null }` in the adapter turned a network error, an
     * expired key, a 429 and an outage into "this Stripe account cannot read
     * that Price" — which the seed then exited on, telling an operator to fix
     * four ids that were perfectly correct, in the middle of an incident.
     */
    const problems = await verifyStripeCatalogue(
      ctxFor({ price_creator: new Error('Request aborted due to timeout'), price_studio: remote() }),
      rows(),
    );
    const unavailable = problems.filter((p) => p.kind === 'unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({ envVar: 'STRIPE_PRICE_ID_PRO_MONTHLY' });

    const described = describePriceProblem(unavailable[0]!);
    expect(described).toContain('timeout');
    // And it refuses to draw a conclusion about the id.
    expect(described).toContain('says nothing');
    expect(blocksSelling(unavailable[0]!)).toBe(false);
    // The other row was still checked rather than the whole run being lost.
    expect(problems.filter(blocksSelling)).toEqual([]);
  });

  it('reports an unset id without blocking, because the feature flag decides', async () => {
    const problems = await verifyStripeCatalogue(
      ctxFor({ price_studio: remote() }),
      [{ ...rows()[0]!, priceId: null }, rows()[1]!],
    );
    expect(problems.filter((p) => p.kind === 'missing')).toHaveLength(1);
    expect(problems.filter(blocksSelling)).toEqual([]);
  });
});

describe('what the database will actually sell', () => {
  /*
   * The check asked Stripe about the environment variables. Checkout reads
   * `product_catalog.stripe_price_id`, written only by `pnpm seed` — and the
   * documented release path for a price change is "edit the ConfigMap, roll
   * the pods". So a re-priced product left the column stale, every Checkout
   * session kept using the old Price, and `pnpm check:stripe-prices` printed
   * four ticks about ids no purchase touches. The customer is charged the old
   * amount and the webhook's amount guard throws afterwards.
   */
  const rows: CataloguePrice[] = [
    { ...studio, priceKey: 'drop_5', envVar: 'STRIPE_PRICE_ID_DROP_5', priceId: 'price_new' },
  ];

  it('reports a configured id the catalogue has not caught up with', () => {
    const problems = catalogueDrift(rows, [{ price_key: 'drop_5', stripe_price_id: 'price_old' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe('stale');
    const described = describePriceProblem(problems[0]!);
    expect(described).toContain('price_old');
    expect(described).toContain('pnpm seed');
    // It blocks: a deployment in this state sells against the wrong Price.
    expect(blocksSelling(problems[0]!)).toBe(true);
  });

  it('says nothing when the two agree', () => {
    expect(catalogueDrift(rows, [{ price_key: 'drop_5', stripe_price_id: 'price_new' }])).toEqual([]);
  });

  it('says nothing about a product the database does not have yet', () => {
    // A seed that has not run is not a drift, and reporting it would be noise
    // on every fresh environment.
    expect(catalogueDrift(rows, [])).toEqual([]);
  });

  it('notices an id removed from the configuration but still stored', () => {
    const problems = catalogueDrift(
      [{ ...rows[0]!, priceId: null }],
      [{ price_key: 'drop_5', stripe_price_id: 'price_old' }],
    );
    expect(problems).toHaveLength(1);
    expect(describePriceProblem(problems[0]!)).toContain('(unset)');
  });
});

describe('the adapter itself, where the classification lives', () => {
  /*
   * The tests above drive `verifyStripeCatalogue` with a fake that throws,
   * which exercises the CALLER. The decision that a thrown error is an outage
   * and a missing Price is a `null` is made in the adapter, and a mutation
   * that collapsed the two back into `catch { return null }` survived every
   * test in this file — so this reaches it directly.
   *
   * The adapter is built with a test key and its Stripe client replaced; no
   * request leaves the machine.
   */
  const adapterWith = (retrieve: () => Promise<unknown>) => {
    const adapter = new StripePaymentsAdapter({
      secretKey: 'sk_test_not_a_real_key',
      webhookSecret: 'whsec_not_a_real_secret',
      expectLiveMode: false,
    });
    (adapter as unknown as { stripe: unknown }).stripe = { prices: { retrieve } };
    return adapter;
  };

  it('returns null only when Stripe says the Price does not exist', async () => {
    const notFound = Object.assign(new Error('No such price: price_nope'), {
      type: 'StripeInvalidRequestError',
    });
    const adapter = adapterWith(() => Promise.reject(notFound));
    await expect(adapter.retrievePrice('price_nope')).resolves.toBeNull();
  });

  it('rethrows anything else, so an outage is not reported as a wrong id', async () => {
    for (const err of [
      Object.assign(new Error('Request aborted due to timeout'), { type: 'StripeConnectionError' }),
      Object.assign(new Error('Too many requests'), { type: 'StripeRateLimitError' }),
      Object.assign(new Error('Invalid API Key provided'), { type: 'StripeAuthenticationError' }),
      new Error('getaddrinfo ENOTFOUND api.stripe.com'),
    ]) {
      const adapter = adapterWith(() => Promise.reject(err));
      await expect(adapter.retrievePrice('price_fine')).rejects.toThrow(err.message);
    }
  });

  it('reads the fields a swap and a mis-set cycle turn on', async () => {
    const adapter = adapterWith(() =>
      Promise.resolve({
        id: 'price_x',
        active: true,
        unit_amount: 3980,
        currency: 'jpy',
        recurring: { interval: 'month', interval_count: 2, usage_type: 'metered' },
        tax_behavior: 'exclusive',
        billing_scheme: 'per_unit',
        product: { id: 'prod_x', name: 'STUDIO — 45 songs / month', active: false },
      }),
    );
    await expect(adapter.retrievePrice('price_x')).resolves.toEqual({
      id: 'price_x',
      active: true,
      amountMinor: 3980,
      currency: 'jpy',
      interval: 'month',
      intervalCount: 2,
      taxBehavior: 'exclusive',
      billingScheme: 'per_unit',
      usageType: 'metered',
      productId: 'prod_x',
      productName: 'STUDIO — 45 songs / month',
      productActive: false,
    });
  });
});

describe('the catalogue is one list', () => {
  const config = {
    STRIPE_PRICE_ID_DROP_5: 'price_a',
    STRIPE_PRICE_ID_PRO_MONTHLY: 'price_b',
    STRIPE_PRICE_ID_PREMIER_MONTHLY: 'price_c',
    STRIPE_PRICE_ID_MARKET_LICENSE: 'price_d',
  } as unknown as AppConfig;

  it('derives the price check from the rows that are seeded', () => {
    /*
     * There used to be two arrays: the `upsertProduct` calls and a second list
     * telling the check what to compare against. Two lists of the same four
     * products is the shape this repository has been bitten by five times —
     * the fifth product gets added to one of them, and the check that was
     * supposed to notice is the thing that stops looking.
     */
    const seeded = catalogue(config);
    const checked = cataloguePrices(config);
    expect(checked.map((c) => c.priceKey)).toEqual(seeded.map((r) => r.price_key));
    for (const [i, row] of seeded.entries()) {
      expect(checked[i]).toMatchObject({
        amountMinor: row.amount_minor,
        interval: row.billing_interval,
        priceId: row.stripe_price_id,
      });
    }
  });

  it('derives the environment variable name rather than mapping it by hand', () => {
    // A hand-written mapping is what the fifth product is missing from.
    for (const row of cataloguePrices(config)) {
      expect(row.envVar).toBe(`STRIPE_PRICE_ID_${row.priceKey.toUpperCase()}`);
    }
  });

  it('names, for every row, the Stripe product a human has to find in the dashboard', () => {
    /*
     * The whole point of the alignment. `displayName` here is the Stripe-side
     * name, so the mismatch report and the docs can say CREATOR and STUDIO
     * even though the keys say pro and premier.
     */
    const names = cataloguePrices(config).map((r) => r.displayName);
    expect(names).toContain('CREATOR — 15 songs / month');
    expect(names).toContain('STUDIO — 45 songs / month');
  });

  it('is the same four products the start-up check knows about', () => {
    /*
     * "refuses to start without" was the name of this test and it was wrong:
     * the two subscription ids are required only when
     * `FEATURE_SUBSCRIPTIONS_ENABLED`, because a deployment with subscriptions
     * closed cannot sell them. The substring check cannot tell the
     * unconditional form from the conditional one, so the per-key refusals in
     * `tests/stripe-webhook-path.test.ts` — which run `loadConfig` with
     * subscriptions on — are what actually prove the behaviour. This only
     * holds that no product is absent from that validation entirely, which is
     * the failure the licence id had.
     */
    const required = read('apps/api/src/config.ts');
    const validate = required.slice(required.indexOf("if (adapters.payments === 'stripe')"));
    const checked = validate.slice(0, validate.indexOf('\n  } else if'));
    for (const row of cataloguePrices(config)) {
      expect(checked, `${row.envVar} is seeded but named nowhere in the start-up check`).toContain(
        `!e.${row.envVar}`,
      );
    }
  });

  it('tells a human which Stripe product each variable wants, beside that variable', () => {
    /*
     * Positional, because `toContain` over a whole file proves nothing here.
     *
     * The first version asserted that the strings CREATOR and STUDIO appeared
     * SOMEWHERE in each file. Swapping the two comments — the precise mistake
     * this whole mechanism is about — left all five assertions green, and
     * DROP and the licence were not in the needle list at all. So each
     * product's Stripe name now has to sit within a few lines of its own
     * variable, and the list of products comes from the catalogue.
     */
    const stripeNameFor = (priceKey: string) =>
      catalogue(config).find((r) => r.price_key === priceKey)!.stripeProduct;

    for (const file of ['.env.example', 'infra/helm/loopscene/values.yaml'] as const) {
      const lines = read(file).split('\n');
      for (const row of cataloguePrices(config)) {
        // drop_5 → priceIdDrop5: the first segment is capitalised too.
        const camel = row.priceKey
          .split('_')
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join('');
        const key = file.endsWith('.yaml') ? `priceId${camel}` : row.envVar;
        const at = lines.findIndex((l) => l.trimStart().startsWith(`${key}:`) || l.startsWith(`${key}=`));
        expect(at, `${file} does not set ${key}`).toBeGreaterThan(-1);
        // The three lines above and the line itself: a comment directly over
        // the key, or an inline one.
        const near = lines.slice(Math.max(at - 3, 0), at + 1).join('\n');
        const name = stripeNameFor(row.priceKey).split('—')[0]!.trim();
        expect(near, `${file} does not say "${name}" next to ${key}`).toContain(name);
      }
    }
    // The documentation names all four too, in its own table.
    const configuration = read('docs/CONFIGURATION.md');
    for (const row of cataloguePrices(config)) {
      expect(configuration, `docs/CONFIGURATION.md has no row for ${row.envVar}`).toContain(row.envVar);
    }
  });
});
