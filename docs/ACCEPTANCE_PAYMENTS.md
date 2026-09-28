# Payments acceptance

Kept separate from `ACCEPTANCE.md` on purpose, and split again inside: what is
already proven by automated test, and what only a real Stripe sandbox can
prove. A green run of one is routinely read as covering the other, and it does
not.

Status at the top, so a sign-off cannot skim past it:

| | |
| --- | --- |
| Payment **logic** | proven — 39 automated tests, run 2026-09-27 |
| Payment **contract with Stripe** | **one-time path accepted** 2026-09-28 against the sandbox; the **subscription** half has never been run — part B |
| **Text model (TokenStars)** | **verified against the live API**, 2026-09-27 — see part E |
| Music generation | **mock**, and cannot be accepted here at all — see part D |

---

## Part A — proven by test, today

`pnpm vitest run tests/payments.test.ts tests/ledger.test.ts` — 39 passed.

Every item the acceptance brief asked for under "异常" already has a test, and
each runs against the same handler a Stripe webhook reaches:

| Asked for | Test that proves it |
| --- | --- |
| Payment fails | `a failed payment grants nothing`; `PAY-07: a failed renewal grants nothing and keeps existing entitlements` |
| Authentication not completed | `PAY-02: landing on the success page grants nothing until the payment is verified`; `checkout.session.expired` is handled |
| Page closed after paying | `PAY-11: an order paid but never granted is recovered by the sweep` |
| Webhook delivered twice | `PAY-05: the same event delivered twice grants once`; `PAY-05: two different events describing the same payment still grant once`; `a repeated refund event is idempotent` |
| Webhook late or out of order | `PAY-05: an out-of-order event does not overwrite newer subscription state` |
| Refund | `PAY-09: revokes unused units only, leaving delivered and in-flight work alone` |
| Credits never over-granted | `PAY-03: a verified payment grants exactly one 5-unit batch`; `PAY-05: granting twice with the same business reference grants once`; `the database constraint refuses an oversell even if application logic is bypassed` |
| Credits never under-granted | `PAY-11` sweep; `GEN-09: a late success after a release does not re-charge the user` |
| Concurrency | `grants the last unit to exactly one of two concurrent jobs`; `ten concurrent jobs against three credits reserve exactly three` |

Two structural defences sit under those, and both are enforced by the schema
rather than by care:

- `webhook_events (provider, event_id)` is UNIQUE, so the same delivery cannot
  be processed twice.
- Grants are keyed on `entitlement_batches (user, source, source_ref)`, so two
  *different* events describing one payment still grant once.

### What Part A does not cover, despite appearances

The tests drive the **simulated** payments adapter. Its webhook signature check
is an HMAC written for the test harness. `PAY-04: an invalid signature changes
nothing` and `PAY-04: a stale signature timestamp is refused` prove *that*
check rejects forgery and replay — they never execute
`stripe.webhooks.constructEvent`, which is the code a real webhook goes
through (`packages/providers/src/payments/stripe.ts:118`).

So the business logic is proven and the Stripe-specific verification is not.
That is the gap Part B exists to close, and it is the reason a sandbox pass is
worth doing rather than a formality.

---

## Part B — the sandbox pass: one-time and subscription both walked

No longer blocked. The credentials are in `.env`, the one-time path was walked
in `26e7799` and the subscription path in `a0d355d`, with every assertion read
out of the database. Two of the seven failure cases remain (B5, B7) and are
marked as such below.

The subscription pass did not confirm the design; it broke it. A paid ¥1,980
CREATOR subscription granted **nothing** — see *What the subscription pass
found* below. That is the reason to walk a path against the real provider even
when the suite is green, and the reason Part A opens with what a green suite
cannot tell you.

### What is needed

| Value | Where it comes from |
| --- | --- |
| `STRIPE_SECRET_KEY` | Dashboard → Developers → API keys → **Secret key**, must begin `sk_test_` |
| `STRIPE_PUBLISHABLE_KEY` | the same screen, `pk_test_` |
| `STRIPE_WEBHOOK_SECRET` | printed by `stripe listen`, begins `whsec_` |
| `STRIPE_PRICE_ID_DROP_5` | a Price in the same sandbox |
| `STRIPE_PRICE_ID_PRO_MONTHLY` | a recurring Price, monthly |
| `STRIPE_PRICE_ID_PREMIER_MONTHLY` | a recurring Price, monthly |

Paste them into `.env`, which is git-ignored, and set `RUN_MODE=integration`.
`pnpm preflight` then reports Stripe as **on** instead of off, and refuses a key
that does not begin `sk_test_`.

`RUN_MODE` is worth setting deliberately before an acceptance run, and not only
for preflight's label: under `RUN_MODE=demo` the API sets `isDemo`, and every
`analytics_events` row it writes carries `is_internal = 1`. The activation metric
excludes internal rows, so an acceptance pass run in demo mode is invisible to
it. The payments adapter itself is chosen by `PAYMENTS_ADAPTER`, not by
`RUN_MODE`, so Stripe is real either way.

The prices must match `apps/api/src/seed.ts` — ¥980, ¥1,980, ¥4,980,
tax-inclusive — or the confirmation screen states a price the buyer is not
charged, which is the 特定商取引法 problem this product has already had once.

### Forwarding

```bash
stripe login   # or skip it and pass the key you already have, below
stripe listen --forward-to localhost:4000/v1/webhooks/stripe
```

`stripe login` pairs through a browser. If the sandbox secret key is already in
`.env`, the listener can use it directly instead:

```bash
export $(grep '^STRIPE_SECRET_KEY=' .env | xargs)
stripe listen --api-key "$STRIPE_SECRET_KEY" --forward-to localhost:4000/v1/webhooks/stripe
```

Either way, compare the `whsec_` it prints against `STRIPE_WEBHOOK_SECRET` in
`.env`. If they differ, every forwarded event is rejected 400 for a bad
signature — which reads as a broken webhook handler rather than a mismatched
secret.

The CLI installs from npm (`npm install -g @stripe/cli`) or Homebrew
(`brew install stripe/stripe-cli/stripe`). It is not a dependency of this repo,
so a fresh machine will not have it.

Leave it running. Without it the payment succeeds at Stripe and no entitlement
is ever granted, which looks exactly like a product bug.

### The pass

**Happy path** — register → buy → pay with `4242 4242 4242 4242` → confirm in
the dashboard → credits increase → generate → play → download.

**Failures**, each checked against the ledger rather than the screen:

| # | Do | Expect | Run? |
| --- | --- | --- | --- |
| B1 | Pay with `4000 0000 0000 0002` (declined) | no order paid, no credits, message says so | **done** `26e7799` — the order stayed `pending` and nothing was granted |
| B2 | Pay with `4000 0025 0000 3155` (3DS) and abandon the challenge | no credits; the session expires | **done** — the PaymentIntent reached `requires_action` / `use_stripe_sdk`, so the challenge was genuinely raised rather than skipped. Leaving the page granted nothing and emitted **no webhook at all**; the order stayed `pending`. Expiring the session (`stripe checkout sessions expire`, rather than waiting 24h) delivered `checkout.session.expired`, which moved the order to `canceled` with the balance untouched. No code change was needed — `handleCheckoutFailed` already refuses to downgrade a paid order, and `tests/payments.test.ts` already covers the terminal state |
| B3 | Pay, then close the tab before returning | credits still arrive, from the webhook alone | **done** `26e7799`, the hard way: the return page had already stopped polling and the webhook landed 57s later, so the grant came from the webhook alone. That is B3, and it is also how the polling defect was found |
| B4 | `stripe events resend <id>` on a completed checkout | balance unchanged | **done** `26e7799` — returned `duplicate: true`, ledger unmoved |
| B5 | Stop `stripe listen`, pay, restart it, resend | credits arrive exactly once | **not run** |
| B6 | Refund in the dashboard | only unused credits are revoked | **done** `26e7799` — the 5 unused units revoked, order `refunded` |
| B7 | Refund the same charge twice | second refund changes nothing | **not run.** What was run is a different thing and should not be mistaken for it: `refund.created` and `charge.refunded` describing *one* refund produced one revoke between them. A second refund of the same charge has only a unit test |

### The subscription pass — run in `a0d355d`

Walked with CREATOR (¥1,980) on `4242 4242 4242 4242`.

| # | Do | Expect | Result |
| --- | --- | --- | --- |
| S1 | Subscribe to CREATOR or STUDIO and pay | one `subscriptions` row, `status = active`, `current_period_end` set | **pass, after the fix.** On the first attempt the row was written with `current_period_start` and `current_period_end` both null |
| S2 | Read `entitlement_batches` | a row with `source = 'subscription_period'`, `granted_units` equal to the tier's units — CREATOR 15, STUDIO 45 | **pass, after the fix.** On the first attempt there was no row at all |
| S3 | While subscribed, press the *other* tier's subscribe button | the API returns `SUBSCRIPTION_ALREADY_ACTIVE` (409) **and `orders` gains no row**. Count the rows; do not read the message. The first version of this guard sat below `insertOrder` and wrote an order before refusing, and only a row count caught it | **pass.** 409, `orders` stayed at 9. First time this guard has ever fired outside a unit test |
| S4 | Cancel, then use credits before the period ends | `cancel_at_period_end = 1`, and the granted units stay usable until `current_period_end` without carrying over past it | **pass.** Our row and Stripe agree on `cancel_at_period_end` and on the period end; the 15 units remain available |

### What the subscription pass found

Stripe accepted the card. `customer.subscription.created` and `invoice.paid`
were both delivered and both answered 200. The buyer's balance stayed at zero,
and every event was marked `processed` — because nothing failed. The handler
returned.

On API version `2026-08-26.dahlia` the Invoice object no longer carries a
top-level `subscription` or `metadata`, and the Subscription object no longer
carries `current_period_start` / `current_period_end`:

| Read | Actually at |
| --- | --- |
| `invoice.subscription` | `invoice.parent.subscription_details.subscription` |
| `invoice.metadata` | `invoice.parent.subscription_details.metadata` |
| `subscription.current_period_*` | `subscription.items.data[0].current_period_*` |

`handleInvoicePaid` opens with `if (typeof subscriptionId !== 'string') return`,
so every subscription invoice Stripe has ever sent was discarded on the first
line of the handler.

Two details worth carrying forward:

- **The period is not a detail.** A first invoice has `period_start ===
  period_end`. A batch dated from the invoice expires the instant it is granted,
  so reading the id correctly and the period carelessly still delivers nothing.
- **Delivery was not recorded.** `handleCheckoutCompleted` deliberately does not
  grant for subscriptions (PAY-06), and nothing else marked the order, so
  `entitlement_granted_at` stayed null for every subscriber. The billing page
  showed a delivered subscription as 「処理中」, and `listUngrantedPaidOrders` —
  which backs an alarm that fires above zero — would have counted every
  subscriber forever, going red the day someone published the metric.

None of this was visible to the test suite, and would not have become visible by
adding more of the same tests. See the caveat in Part A.

One-time packs are deliberately unaffected by S3 — buying credits while
subscribed is ordinary, and a guard that blocked it would be a regression.

After each, read the ledger directly — not the balance in the header:

```sql
SELECT entry_type, units, source, source_ref, created_at
  FROM ledger_entries ORDER BY created_at DESC LIMIT 20;
SELECT provider, event_id, status, error FROM webhook_events ORDER BY received_at DESC LIMIT 20;
```

---

## Part C — how to record the result

Write the outcome in two places that cannot be confused:

- **Payment**: accepted through the Stripe sandbox, with the date and the
  Stripe account's test-mode id.
- **Music generation**: see part D. It is not accepted by anything here.

A single "acceptance passed" covering both would be false.

---

## Part D — music generation is mock

`MUSIC_ADAPTER=demo`. Audio is assembled from fixtures in
`assets/fixtures/audio`; no external music service is called. Nothing in this
document, or in `ACCEPTANCE.md`, accepts music generation.

What a demo-mode pass does establish: the job pipeline, phases, credit
reservation and release, storage, licence records, export and download all work
end to end. What it does not: audio quality, provider latency, provider
failure modes, cost per request, or commercial delivery rights.

`MUSIC_COST_IS_ESTIMATE=true` and `FEATURE_COMMERCIAL_DELIVERY` is off,
deliberately: no agreement with a music provider is signed. Accepting music
generation needs a second pass against the real API once there is one, and the
API refuses to start in production mode with the demo adapter, so this cannot
be shipped by accident.

---

## Part E — TokenStars, verified against the live API

Unlike music, this one **was** exercised against the real service on
2026-09-27, with the account owner's key, through the real adapter.

| Claim | Result |
| --- | --- |
| Endpoint, auth, model id | `POST https://www.tokenstars.ai/v1/chat/completions`, `Authorization: Bearer` — works |
| Intent extraction | valid against our schema on the first attempt, no repair round trip |
| Usage accounting | `prompt_tokens` / `completion_tokens` / `total_tokens` returned as documented (353 / 136 / 489 on a representative call) |
| `response_format: {type:'json_object'}` | **accepted** — this was an undocumented assumption and is now confirmed. It also costs fewer completion tokens than letting the model wrap the object in prose |
| `finish_reason: 'length'` on truncation | **confirmed** — which is what the truncation handling keys on |
| Request id | an `x-request-id` header is returned; `TOKENSTARS_REQUEST_ID_HEADER=x-request-id` is now set and the id reaches our logs |

Two things the live call revealed that the documentation does not mention:

- **The gateway fronts Azure OpenAI.** Responses carry `x-ms-region`,
  `x-ms-served-model` and `x-ms-rai-invoked: true`. So an upstream content
  block arrives as `finish_reason: 'content_filter'`, **not** as the
  `message.refusal` field the adapter originally looked for — that branch
  would never have fired. It now keys on the real signal, and a policy block
  is reported as a refusal rather than a technical failure, which matters
  because a refusal must not be charged as though the system broke.
- **Text is served from `Japan East`**, and the rate limit on this key is 2500
  requests and 2,500,000 tokens per minute.

Still estimated, not measured: `costMinor` stays `costIsEstimate: true`. The
calls return token counts but no price, and no billing basis has been
confirmed, so the JPY figure remains modelled.
