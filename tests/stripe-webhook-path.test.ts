/**
 * The Stripe webhook's public path, and the four places that have to agree
 * about it.
 *
 * Operations configured the live endpoint as `POST /api/webhooks/stripe`; the
 * code served `/v1/webhooks/stripe`. That mismatch is not a 404 anybody sees.
 * In front of the api sits nginx with `location / { try_files $uri
 * /index.html; }`, so a POST to an unrouted path answers **200 with the page
 * shell** — and Stripe reads 200 as delivered and never retries. The outcome
 * is a customer charged, an event acknowledged, and no credits granted, with
 * nothing in either dashboard suggesting a problem. It is the same failure as
 * `/health` answering 200 from the SPA, which deploy/dgx/README.md already
 * records.
 *
 * So the path is served from one list, and the assertions below are mostly
 * scripted invariants over the files that carry it rather than opinions about
 * the code. Eyeballing has never caught this shape here.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STRIPE_WEBHOOK_PATHS, STRIPE_WEBHOOK_PRIMARY_PATH, keepsRawBody } from '@yuha/api';
import { ConfigError, loadConfig } from '../apps/api/src/config.js';
import { catalogue, cataloguePrices } from '../apps/api/src/catalogue.js';
import type { AppConfig } from '../apps/api/src/config.js';
import { query } from '@yuha/db';
import { SimulatedPaymentsAdapter } from '@yuha/providers';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const sh = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf8' });

describe('the webhook path is one decision, in one place', () => {
  it('every served path keeps its raw body', () => {
    /*
     * The signature is computed over the exact bytes. A path registered as a
     * route but missed by the content-type parser arrives parsed to an object,
     * `Buffer.isBuffer` fails, and every delivery to it is refused as
     * unsigned — indistinguishable from a wrong secret, which is a day of
     * looking in the wrong place.
     */
    expect(STRIPE_WEBHOOK_PATHS.length).toBeGreaterThan(0);
    for (const path of STRIPE_WEBHOOK_PATHS) {
      expect(keepsRawBody(path), `${path} must keep its raw body`).toBe(true);
      expect(keepsRawBody(`${path}?x=1`), `${path} with a query string`).toBe(true);
    }
    // And nothing else does, or a route that needs parsed JSON silently stops
    // receiving it.
    expect(keepsRawBody('/v1/checkout')).toBe(false);
    expect(keepsRawBody('/api/orders')).toBe(false);
  });

  it('the reverse proxy forwards every served path to the api, unrewritten', () => {
    const nginx = read('deploy/dgx/app/nginx.conf');
    /*
     * Parsed tolerantly on purpose. An earlier version of this matched only
     * `location <prefix> {` with exactly one space and a trailing slash, so
     * `location ^~ /api/ {` — the idiomatic way to make a prefix beat a regex
     * location — or `location /api {` would have reported the route missing
     * while nginx routed it perfectly.
     */
    /*
     * Brace-matched rather than `[^}]*`, and `^~` is a PREFIX modifier.
     *
     * Two misleading failures came out of the first version. `location ^~
     * /api/ {` — the idiomatic way to make a prefix beat a regex location —
     * was discarded by a `!modifier.includes('~')` filter, so the test
     * reported "nginx has no proxying location covering …" about a config
     * that routed it with HIGHER precedence. And `[^}]*` stops at the first
     * `}`, so any nested block (`if (...) { return 204; }`) hid the
     * `proxy_pass` below it and produced the same wrong message.
     */
    const blocks = [];
    const header = /location\s+(=|\^~|~\*|~)?\s*(\S+?)\s*\{/g;
    for (let m = header.exec(nginx); m; m = header.exec(nginx)) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < nginx.length && depth > 0; i += 1) {
        if (nginx[i] === '{') depth += 1;
        else if (nginx[i] === '}') depth -= 1;
      }
      blocks.push({ modifier: m[1] ?? '', prefix: m[2]!, body: nginx.slice(m.index + m[0].length, i - 1) });
    }
    // Only regex locations are excluded; `=` is exact and `^~` is a prefix.
    const proxied = blocks.filter(
      (b) => b.body.includes('proxy_pass') && b.modifier !== '~' && b.modifier !== '~*',
    );

    for (const path of STRIPE_WEBHOOK_PATHS) {
      const block = proxied.find((b) => path.startsWith(b.prefix));
      expect(block, `nginx has no proxying location covering ${path} (it would answer the SPA)`).toBeTruthy();
      /*
       * And the URI must not be rewritten. `proxy_pass` with a URI part —
       * `$api_upstream/` rather than `$api_upstream` — replaces the matched
       * prefix, so the api would be asked for `/webhooks/stripe`, a route it
       * does not register. The result is a 404 the proxy reports as reaching
       * the backend: routed, and still wrong.
       */
      const pass = /proxy_pass\s+([^;]+);/.exec(block!.body)?.[1]!.trim();
      expect(pass, `${block!.prefix} has no proxy_pass target`).toBeTruthy();
      expect(
        /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(pass!) || /^https?:\/\/[^/]+$/.test(pass!),
        `${block!.prefix} rewrites the URI (proxy_pass ${pass}) — the api would not see ${path}`,
      ).toBe(true);
      /*
       * And the variable it resolves to must itself carry no URI part.
       * Checking only the `proxy_pass $var` text left the rewrite reachable
       * one line up: `set $api_upstream http://api:4000/;` passes the
       * assertion above and makes nginx replace the request URI, which is the
       * breakage the comment claims to guard.
       */
      const variable = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(pass!)?.[1];
      if (variable) {
        const set = new RegExp(`set\\s+\\$${variable}\\s+([^;]+);`).exec(block!.body)?.[1]?.trim();
        expect(set, `${block!.prefix} uses $${variable} without setting it`).toBeTruthy();
        expect(
          /^https?:\/\/[^/]+$/.test(set!),
          `${block!.prefix}'s $${variable} is "${set}" — a URI part there rewrites the path the api sees`,
        ).toBe(true);
      }
    }
  });

  it('the ALB ingress covers every served path with a Prefix rule', () => {
    const chart = read('infra/helm/loopscene/templates/api.yaml');
    const ingress = chart.slice(chart.indexOf('kind: Ingress'));
    /*
     * `pathType` is checked and the ORDER is not, which is the opposite of
     * what this test asserted when it was written.
     *
     * The AWS Load Balancer Controller sorts an Ingress's paths before it
     * assigns ALB rule priorities — Exact first, then Prefix longest first —
     * and the Ingress spec says the same ("the longest matching path"). So
     * writing `/` first changes nothing, and an assertion about list order
     * would fail a chart that routes identically.
     *
     * What does change everything is `pathType: Exact` on `/api`: it matches
     * `/api` and sends `/api/webhooks/stripe` to the catch-all — the silent
     * failure this whole change exists to prevent, and invisible to a test
     * that reads only the path strings.
     */
    /*
     * Path, pathType AND the backend service, in any key order.
     *
     * Reading only `path` and `pathType` left the thing that matters most
     * unchecked: pointing the `/api` rule's backend at a web service would
     * send `/api/webhooks/stripe` somewhere that is not the API while every
     * assertion passed. And requiring `pathType` on the line immediately
     * after `- path:` made an identical YAML reordering fail with
     * "expected [] to contain '/'".
     */
    const rules = ingress
      // Split on the list markers rather than matched with a lookahead: `\Z`
      // is not a JavaScript anchor, and the pattern that used it silently
      // dropped the last rule — the `/` catch-all, which the assertion below
      // is about.
      .split(/^ {10}- (?=path:|pathType:|backend:)/m)
      .slice(1)
      .map((block) => ({
        path: /path:\s*"?([^"\s]+)"?/.exec(block)?.[1] ?? '',
        type: /pathType:\s*(\S+)/.exec(block)?.[1] ?? '',
        service: /name:\s*(.+)/.exec(block)?.[1]?.trim() ?? '',
      }));
    expect(rules.length, 'no ingress path rules were parsed at all').toBeGreaterThan(1);
    for (const rule of rules) {
      expect(rule.path, 'an ingress rule has no path').toBeTruthy();
      expect(rule.type, `${rule.path} has no pathType`).toBeTruthy();
      expect(rule.service, `${rule.path} has no backend service`).toContain('-api');
    }
    expect(rules.map((r) => r.path)).toContain('/');
    for (const served of STRIPE_WEBHOOK_PATHS) {
      const match = rules.find((r) => r.path !== '/' && served.startsWith(r.path));
      expect(match, `the ingress has no explicit rule covering ${served}`).toBeTruthy();
      expect(
        match!.type,
        `${match!.path} must be pathType: Prefix — Exact would route ${match!.path} and send ${served} to the catch-all`,
      ).toBe('Prefix');
    }
  });

  it('the forwarded event list is exactly what the processor handles', () => {
    /*
     * `refund.created` and `charge.dispute.closed` were handled in code and
     * absent from the forwarder, so the branch that revokes credits when a
     * dispute is LOST — the moment the money actually leaves — could not be
     * reached by any real delivery. A handler no event reaches is the same as
     * no handler, and it reads as protection.
     */
    const service = read('apps/api/src/services/webhooks.ts');
    const processor = service.slice(service.indexOf('export async function processWebhookEvent'));
    const body = processor.slice(0, processor.indexOf('\n}\n'));
    const handled = new Set([...body.matchAll(/case '([a-z_]+(?:\.[a-z_]+)+)':/g)].map((m) => m[1]!));

    /*
     * Every event list in the repository, not the one this test was written
     * against. There were four copies — the compose forwarder, `.env.example`,
     * and two deployment docs — and `charge.dispute.closed` was missing from
     * three of them. Checking one copy is how the other three drift.
     */
    const files = sh('git ls-files -z').split('\0').filter(Boolean);
    const lists: Array<{ file: string; events: string[] }> = [];
    for (const file of files) {
      if (file.startsWith('spec/') || file === 'PROJECT_TASK.md') continue; // frozen records of the brief
      if (file === 'tests/stripe-webhook-path.test.ts') continue;
      let text: string;
      try {
        text = read(file);
      } catch {
        continue; // binary or unreadable
      }
      if (!text.includes('--events')) continue;
      /*
       * Line continuations are joined first. `.env.example` writes the list
       * across six lines with a trailing backslash and a leading `#`, which no
       * single-line regex was ever going to see — the first version of this
       * check found one list out of two and reported "no --events list found
       * anywhere", which at least failed loudly rather than passing on one
       * file.
       */
      const joined = text.replace(/\\\r?\n\s*#?/g, '');
      // `-?\s*` for the YAML list form: compose writes `- --events` on one
      // line and `- checkout.session.completed,…` on the next, and a pattern
      // that demanded the list begin immediately after the whitespace saw
      // only the `.env.example` copy.
      for (const m of joined.matchAll(/--events[=\s]+-?\s*([a-z_.,]+)/g)) {
        const events = m[1]!.split(',').filter((e) => /^[a-z_]+(?:\.[a-z_]+)+$/.test(e));
        if (events.length) lists.push({ file, events });
      }
    }
    /*
     * And docs/STRIPE_WEBHOOK.md, which is the only copy an operator actually
     * uses — and was the only one no invariant covered.
     *
     * Three documents call that file "the list of record", and its
     * copy-pasteable block is what gets pasted into the Stripe dashboard. The
     * check recognised the literal string `--events`, so it held the two
     * incidental copies in step and left the authoritative one alone. Both
     * copies in that file are compared: the table and the block, because they
     * can disagree with each other.
     */
    const record = read('docs/STRIPE_WEBHOOK.md');
    const fenced = /```\n((?:[a-z_]+(?:\.[a-z_]+)+\n)+)```/.exec(record)?.[1];
    expect(fenced, 'docs/STRIPE_WEBHOOK.md has no copy-pasteable event block').toBeTruthy();
    lists.push({ file: 'docs/STRIPE_WEBHOOK.md (block)', events: fenced!.trim().split('\n') });
    const tabled = [...record.matchAll(/^\| `([a-z_]+(?:\.[a-z_]+)+)` \|/gm)].map((m) => m[1]!);
    expect(tabled.length, 'docs/STRIPE_WEBHOOK.md has no event table').toBeGreaterThan(0);
    lists.push({ file: 'docs/STRIPE_WEBHOOK.md (table)', events: tabled });

    expect(lists.length, 'no event list was found anywhere — this check found nothing to check').toBeGreaterThanOrEqual(4);
    for (const { file, events } of lists) {
      expect([...new Set(events)].sort(), `${file}'s --events list is not the handled set`).toEqual(
        [...handled].sort(),
      );
    }

    // The forwarder posts to the path the live endpoint uses, not the older one.
    expect(read('deploy/dgx/app/docker-compose.yml')).toContain(`api:4000${STRIPE_WEBHOOK_PRIMARY_PATH}`);
  });

  it('the test catalogue is the product catalogue', () => {
    /*
     * The harness seeded CREATOR with 100 credits and STUDIO with 400 —
     * leftovers from the "100 songs a month" pivot that the catalogue
     * re-priced away months ago. Every billing test therefore ran against two
     * products that do not exist, and nothing noticed because no test
     * asserted either number. The first one to assert a STUDIO grant would
     * have written 400 into itself and looked right.
     *
     * The product side is the real `catalogue()`; only the harness side is
     * parsed, because it is a literal with no export to call. Versions are
     * deliberately NOT compared: the harness seeds v1 and the catalogue has
     * re-priced past it, which is the mechanism that keeps an existing
     * subscriber on the price they agreed to.
     */
    const harness = read('tests/helpers/harness.ts');
    const fromHarness = (key: string) => {
      const at = harness.indexOf(`price_key: '${key}'`);
      expect(at, `${key} is missing from the harness`).toBeGreaterThan(-1);
      const block = harness.slice(at, harness.indexOf('});', at));
      const field = (name: string) => {
        const m = new RegExp(`(?:^|\\s)${name}: ('[^']*'|[^,\\n]+),`).exec(block);
        // Throws rather than returning undefined: `toEqual` is happy to
        // compare two undefineds, so a rename on both sides would make this
        // pass while comparing nothing at all.
        if (!m) throw new Error(`${key}: no ${name} in the harness`);
        return m[1]!;
      };
      return {
        display_name: field('display_name'),
        amount_minor: field('amount_minor'),
        units: field('units'),
        /*
         * `currency` especially, because it is the field the motivating bug
         * was about: the harness used to seed USD 499/999/2999 while the
         * catalogue seeds JPY, so a stablecoin quote inheriting the fixture
         * had its arithmetic verified against $4.99. The first version of this
         * invariant compared the three fields above and not this one, which
         * means setting `currency: 'usd'` back would have left it green.
         */
        currency: field('currency'),
        kind: field('kind'),
        tax_included: field('tax_included'),
        billing_interval: field('billing_interval'),
        validity_days: field('validity_days'),
      };
    };

    for (const row of catalogue({} as AppConfig)) {
      expect(fromHarness(row.price_key), `the harness's ${row.price_key} is not the catalogue's`).toEqual({
        display_name: `'${row.display_name}'`,
        amount_minor: String(row.amount_minor),
        units: String(row.units),
        currency: "'jpy'",
        kind: `'${row.kind}'`,
        tax_included: 'true',
        billing_interval: row.billing_interval === null ? 'null' : `'${row.billing_interval}'`,
        validity_days: row.validity_days === null ? 'null' : String(row.validity_days),
      });
    }
  });

  /*
   * Every product in the catalogue needs a price id, and the three places that
   * have to know about one are the catalogue, the start-up check and the
   * ConfigMap. `market_license` had the first and neither of the others, while
   * the product was on sale: `createCheckout` throws "product X has no Stripe
   * price id configured", so the failure was a 500 on the one page that takes
   * money, discovered by whoever tried to buy a licence first.
   *
   * The product list is derived from `catalogue.ts` rather than written here, so a
   * fifth product is covered the day it is added. Deriving it from the
   * `stripe_price_id: config.…` lines was the first attempt and was wrong: a
   * product seeded with `stripe_price_id: null` produces no such line, so the
   * one case the comment above names would have slipped straight through.
   */
  /*
   * Taken from the catalogue FUNCTION, not from a regex over the file that
   * happens to call it.
   *
   * This read `apps/api/src/seed.ts` until the rows moved into
   * `apps/api/src/catalogue.ts`, and it failed loudly when they did — which is
   * the behaviour you want from an invariant, and also the sign that it was
   * anchored to a filename rather than to the thing it cares about. Calling
   * the export cannot drift on indentation, a move, or a reformat.
   */
  const priceRows = cataloguePrices({} as AppConfig);
  const catalogueKeys = priceRows.map((r) => r.priceKey);
  const envKeyFor = (priceKey: string) => priceRows.find((r) => r.priceKey === priceKey)!.envVar;

  it('seeds a catalogue at all, so the loop below is not empty', () => {
    expect(catalogueKeys.sort()).toEqual(['drop_5', 'market_license', 'premier_monthly', 'pro_monthly']);
  });

  /*
   * Asserted by RUNNING `loadConfig`, not by grepping it.
   *
   * The grep version read `toContain('!e.KEY')`, which `if (false && !e.KEY)`
   * satisfies, and it could not see that two of the keys are only required
   * when subscriptions are on. Starting the configuration up and reading the
   * refusal is the behaviour the deployment actually depends on.
   */
  const stripeEnv = (omit?: string) => {
    const env: Record<string, string> = {
      RUN_MODE: 'integration',
      DATABASE_URL: 'mysql://u:p@localhost:3306/x',
      DEV_AUTH_SECRET: 'dev-secret',
      STORAGE_SIGNING_SECRET: 'storage-secret',
      PAYMENTS_ADAPTER: 'stripe',
      FEATURE_SUBSCRIPTIONS_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      STRIPE_API_VERSION: '2025-03-31.basil',
    };
    for (const key of catalogueKeys) env[envKeyFor(key)] = `price_${key}`;
    if (omit) delete env[omit];
    return env;
  };

  it('starts when every price id is present', () => {
    expect(() => loadConfig(stripeEnv() as never)).not.toThrow();
  });

  it.each(catalogueKeys)('refuses to start without a price id for %s', (priceKey) => {
    const key = envKeyFor(priceKey);
    try {
      loadConfig(stripeEnv(key) as never);
      throw new Error(`${key} is seeded into the catalogue and the API started without it`);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message, `the refusal must name ${key}`).toContain(key);
    }
  });

  it('refuses a signing secret that is not an endpoint secret, without printing it', () => {
    try {
      loadConfig({ ...stripeEnv(), STRIPE_WEBHOOK_SECRET: 'sk_test_pasted_the_wrong_one' } as never);
      throw new Error('a secret key was accepted as the endpoint signing secret');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain('STRIPE_WEBHOOK_SECRET');
      // The value never appears in the problem text — this is a message that
      // ends up in a pod log.
      expect(message).not.toContain('sk_test_pasted_the_wrong_one');
    }
  });

  it.each([
    ['', 'production needs it set explicitly'],
    ['basil', 'not a version at all'],
    ['2024-06-20', 'older than the floor'],
  ])('refuses STRIPE_API_VERSION %o (%s)', (value) => {
    const env = { ...stripeEnv(), RUN_MODE: 'production', STRIPE_SECRET_KEY: 'sk_live_x' };
    if (value === '') delete (env as Record<string, string>)['STRIPE_API_VERSION'];
    else (env as Record<string, string>)['STRIPE_API_VERSION'] = value;
    expect(() => loadConfig(env as never)).toThrow(/STRIPE_API_VERSION/);
  });

  it('puts every price id and the API version where a pod can read it', () => {
    const configmap = read('infra/helm/loopscene/templates/configmap.yaml');
    // Anchored, so a commented-out line does not satisfy it.
    const valueFor = (key: string) => new RegExp(`^  ${key}:\\s*(\\S.*)$`, 'm').exec(configmap)?.[1];
    for (const priceKey of catalogueKeys) {
      const key = envKeyFor(priceKey);
      const value = valueFor(key);
      expect(value, `${key} reaches no pod`).toBeTruthy();
      /*
       * And the value must be ITS OWN values-file key. Reading only the left
       * side let `STRIPE_PRICE_ID_PREMIER_MONTHLY:
       * {{ .Values.config.stripe.priceIdProMonthly }}` through — the exact
       * CREATOR/STUDIO swap this check exists to prevent, shipped by the
       * check that was supposed to prevent it.
       */
      const camel = priceKey.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
      expect(
        value!.toLowerCase(),
        `${key} is wired to the wrong values key: ${value}`,
      ).toContain(`priceid${camel.toLowerCase()}`);
    }
    expect(valueFor('STRIPE_API_VERSION')).toBeTruthy();
  });
});

describe('both served paths behave identically', () => {
  let h: Harness;
  let sim: SimulatedPaymentsAdapter;

  /** Where the storage-failure test parks `webhook_events` for one assertion. */
  const HIDDEN = 'webhook_events_hidden_by_test';

  async function unhideWebhookEvents(): Promise<void> {
    const parked = await query<Record<string, string>>(`SHOW TABLES LIKE '${HIDDEN}'`);
    if (parked.length === 0) return;
    // Only reachable after a run was killed mid-test. The live table, if one
    // exists, is whatever the interrupted run left behind.
    await query('DROP TABLE IF EXISTS webhook_events');
    await query(`RENAME TABLE ${HIDDEN} TO webhook_events`);
  }

  beforeAll(async () => {
    h = await createHarness({ FEATURE_SUBSCRIPTIONS_ENABLED: 'true' });
    sim = h.ctx.payments as SimulatedPaymentsAdapter;
    await unhideWebhookEvents();
  });
  beforeEach(async () => {
    await resetData();
  });
  afterAll(async () => {
    await h?.close();
    await teardown();
  });

  const event = (id: string) => ({
    id,
    type: 'customer.subscription.updated',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'sub_path_probe', object: 'subscription', status: 'active' } },
  });

  const post = (
    path: string,
    raw: Buffer,
    signature: string | undefined,
    contentType = 'application/json',
  ) =>
    h.app.inject({
      method: 'POST',
      url: path,
      headers: {
        'content-type': contentType,
        ...(signature ? { 'stripe-signature': signature } : {}),
      },
      payload: raw,
    });

  it('keeps the raw body on a percent-encoded spelling of the same route', async () => {
    /*
     * `find-my-way` matches the DECODED path and `req.url` keeps what the
     * client sent, so `POST /api/%77ebhooks/stripe` reached the webhook route
     * while a `req.url.startsWith('/api/webhooks/')` test said no. The body
     * arrived parsed, `Buffer.isBuffer` failed, and the handler answered 400
     * "raw body was not preserved" — BEFORE `recordWebhookEvent`, so the
     * "recorded for audit, flagged unverified" guarantee did not hold either,
     * and an unauthenticated caller could produce on demand the one message
     * the post-deploy check uses to tell a broken endpoint from a wrong
     * secret. Reproduced over a raw socket; `app.inject` normalises some of
     * these, so the encodings below are the ones it does not.
     *
     * Fixed by matching the route Fastify decided on rather than the target
     * the client typed.
     */
    for (const path of ['/api/%77ebhooks/stripe', '/%61pi/webhooks/stripe', '/v1/%77ebhooks/stripe']) {
      const raw = Buffer.from(JSON.stringify(event(`evt_encoded_${path.length}`)), 'utf8');
      const res = await h.app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/json', 'stripe-signature': sim.signPayload(raw) },
        payload: raw,
      });
      expect(res.statusCode, `${path} must be accepted like its plain spelling`).toBe(200);
      expect(res.json()).toMatchObject({ received: true });
    }
  });

  it('records an audit row even for a delivery it refuses', async () => {
    /*
     * The "recorded for audit, flagged unverified, never processed"
     * guarantee. An unsigned POST has to leave a row; the encoded-path bug
     * above bypassed it entirely by failing earlier.
     */
    const raw = Buffer.from(JSON.stringify(event('evt_audited')), 'utf8');
    const res = await post(STRIPE_WEBHOOK_PRIMARY_PATH, raw, undefined);
    expect(res.statusCode).toBe(400);
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM webhook_events WHERE event_type = 'unverified'`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('accepts the content type Stripe actually sends', async () => {
    /*
     * Stripe sends `application/json; charset=utf-8`, and the raw-body parser
     * is registered for bare `application/json`. Fastify matches on the media
     * type and so hands the charset variant to the same parser — which is a
     * Fastify internal, not a promise, and this is the one request shape that
     * matters most. Nothing else in the suite sends it.
     */
    const raw = Buffer.from(JSON.stringify(event('evt_charset')), 'utf8');
    const res = await post(
      STRIPE_WEBHOOK_PRIMARY_PATH,
      raw,
      sim.signPayload(raw),
      'application/json; charset=utf-8',
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, duplicate: false });
  });

  it('accepts a signed event on each, and answers directly rather than redirecting', async () => {
    for (const [i, path] of STRIPE_WEBHOOK_PATHS.entries()) {
      const raw = Buffer.from(JSON.stringify(event(`evt_path_${i}`)), 'utf8');
      const res = await post(path, raw, sim.signPayload(raw));
      expect(res.statusCode, `${path} must accept a signed event`).toBe(200);
      // A 3xx would be followed with the body re-sent, which Stripe's docs
      // rule out for an endpoint; and HTML here is the SPA answering instead.
      expect(res.headers['location']).toBeUndefined();
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json()).toMatchObject({ received: true, duplicate: false });
    }
  });

  it('dedupes across the two paths, not per path', async () => {
    /*
     * The point of two paths is one endpoint. If the dedupe were keyed on
     * anything per-route, moving the Stripe endpoint from /v1 to /api while
     * the CLI forwarder still posted to /v1 would process every event twice.
     */
    const raw = Buffer.from(JSON.stringify(event('evt_shared_identity')), 'utf8');
    const other = STRIPE_WEBHOOK_PATHS.find((p) => p !== STRIPE_WEBHOOK_PRIMARY_PATH)!;
    const first = await post(other, raw, sim.signPayload(raw));
    const second = await post(STRIPE_WEBHOOK_PRIMARY_PATH, raw, sim.signPayload(raw));

    expect(first.json()).toMatchObject({ duplicate: false });
    expect(second.json()).toMatchObject({ duplicate: true });

    const rows = await query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM webhook_events WHERE event_id = ?',
      ['evt_shared_identity'],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('refuses an unsigned or forged delivery on each with 400 and a JSON error', async () => {
    for (const path of STRIPE_WEBHOOK_PATHS) {
      const raw = Buffer.from(JSON.stringify(event('evt_forged')), 'utf8');

      const forged = await post(path, raw, 't=1,v1=deadbeef');
      expect(forged.statusCode, `${path} must refuse a forged signature`).toBe(400);
      expect(forged.headers['content-type']).toContain('application/json');
      expect(forged.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

      const unsigned = await post(path, raw, undefined);
      expect(unsigned.statusCode, `${path} must refuse an unsigned delivery`).toBe(400);
      expect(unsigned.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

      // Nothing was stored under the event's own id, so a later genuine
      // delivery of that id is not swallowed as a duplicate.
      const rows = await query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM webhook_events WHERE event_id = ?',
        ['evt_forged'],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    }
  });

  it('answers non-2xx when the event cannot be stored, so Stripe retries', async () => {
    /*
     * The acknowledgement has to mean "saved". `recordWebhookEvent` is the
     * only thing between the signature check and the 200, so a failure there
     * must surface as a 5xx: Stripe redelivers for three days, which is the
     * recovery. A 200 written before the insert would turn a transient
     * database error into a permanently lost payment.
     *
     * Injected by taking the table away, because nothing smaller works:
     * `recordWebhookEvent` uses `INSERT IGNORE`, which downgrades every data
     * error to a warning, so an over-long event type or id is silently
     * TRUNCATED and stored rather than refused. (Worth knowing on its own —
     * Stripe's ids and types are far shorter than the columns, but the
     * statement form means a malformed one would be accepted, not rejected.)
     * What `INSERT IGNORE` does not swallow is the table not being there, a
     * dead connection or a lock timeout, which is the class this is about.
     *
     * CLAUDE.md records that every session on the dev machine shares
     * `loopscene_test`, so this window is kept as small as possible and the
     * recovery is written down rather than assumed: `finally` puts the table
     * back, and `unhideWebhookEvents` also runs in `beforeAll`, so a run
     * killed between the two renames repairs itself next time instead of
     * leaving a schema `migrate()` will not rebuild — its checksum says it is
     * already applied.
     */
    await query(`RENAME TABLE webhook_events TO ${HIDDEN}`);
    try {
      const raw = Buffer.from(JSON.stringify(event('evt_unstorable')), 'utf8');
      const res = await post(STRIPE_WEBHOOK_PRIMARY_PATH, raw, sim.signPayload(raw));
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await unhideWebhookEvents();
    }

    // And nothing was stored, so the redelivery is not swallowed as duplicate.
    const rows = await query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM webhook_events WHERE event_id = ?',
      ['evt_unstorable'],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
