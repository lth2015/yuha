# Payments acceptance

Kept separate from `ACCEPTANCE.md` on purpose, and split again inside: what is
already proven by automated test, and what only a real Stripe sandbox can
prove. A green run of one is routinely read as covering the other, and it does
not.

Status at the top, so a sign-off cannot skim past it:

| | |
| --- | --- |
| Payment **logic** | proven — 39 automated tests, run 2026-09-27 |
| Payment **contract with Stripe** | **partly done** — sandbox keys in, catalogue created, webhook not yet wired |
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

## Part B — the sandbox pass, not started

Blocked on credentials. These cannot be obtained from this repository: they
require signing in to the Stripe account, which is the account owner's to do.

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

The prices must match `apps/api/src/seed.ts` — ¥980, ¥1,980, ¥4,980,
tax-inclusive — or the confirmation screen states a price the buyer is not
charged, which is the 特定商取引法 problem this product has already had once.

### Forwarding

```bash
stripe login
stripe listen --forward-to localhost:4000/v1/webhooks/stripe
```

Leave it running. Without it the payment succeeds at Stripe and no entitlement
is ever granted, which looks exactly like a product bug.

### The pass

**Happy path** — register → buy → pay with `4242 4242 4242 4242` → confirm in
the dashboard → credits increase → generate → play → download.

**Failures**, each checked against the ledger rather than the screen:

| # | Do | Expect |
| --- | --- | --- |
| B1 | Pay with `4000 0000 0000 0002` (declined) | no order paid, no credits, message says so |
| B2 | Pay with `4000 0025 0000 3155` (3DS) and abandon the challenge | no credits; the session expires |
| B3 | Pay, then close the tab before returning | credits still arrive, from the webhook alone |
| B4 | `stripe events resend <id>` on a completed checkout | balance unchanged |
| B5 | Stop `stripe listen`, pay, restart it, resend | credits arrive exactly once |
| B6 | Refund in the dashboard | only unused credits are revoked |
| B7 | Refund the same charge twice | second refund changes nothing |

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
