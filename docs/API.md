# API

Base URL: `http://localhost:4000` in development. All bodies are JSON except the
Stripe webhook, which is read as raw bytes.

Authentication is `Authorization: Bearer <token>`. In demo mode the token comes
from `POST /v1/auth/dev-login`; in integration and production it is a **Cognito
id token** (not an access token — the API rejects the wrong `token_use`).

---

## Conventions

### Errors

Every failure returns the same shape:

```json
{ "error": { "code": "INSUFFICIENT_CREDITS", "message": "…", "details": {}, "requestId": "req-42" } }
```

`code` is a stable machine-readable value from `packages/contracts/src/errors.ts`.
The web app maps every code to Japanese text **and a concrete next step**
(UI-12); the mapping is typed over the full union, so adding a code without
adding copy is a compile error. Messages never contain secrets, stack traces or
raw prompts.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing, malformed or expired token |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `AGE_NOT_CONFIRMED` | 403 | 18+ confirmation required before generating or buying |
| `VALIDATION_FAILED` | 400 | Request body or query failed schema validation |
| `PROMPT_BLOCKED` | 422 | Input outside accepted scope; `details.appealable` is always true |
| `UNSUPPORTED_CAPABILITY` | 422 | The configured provider cannot honour this request |
| `NOT_FOUND` | 404 | Absent, or owned by someone else (deliberately indistinguishable) |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same key, different body |
| `CONFLICT` | 409 | State changed underneath the request |
| `RATE_LIMITED` | 429 | Rate limit or per-user concurrency cap |
| `INSUFFICIENT_CREDITS` | 402 | Not enough credits to reserve |
| `JOB_NOT_CANCELLABLE` | 409 | Already finished, or already submitted upstream |
| `TRACK_SUSPENDED` | 423 | Paused pending a rights review |
| `SUBSCRIPTIONS_DISABLED` | 403 | Subscriptions built but not yet open |
| `WEBHOOK_SIGNATURE_INVALID` | 400 | Signature verification failed; nothing changed |
| `SERVICE_DISABLED` | 503 | Operator paused the feature |
| `INTERNAL_ERROR` | 500 | Unexpected; logged server-side with the request id |

### Idempotency

`POST /v1/generations` requires an `Idempotency-Key` header (8–128 chars,
`[A-Za-z0-9._:-]`). `POST /v1/checkout` and `POST /v1/subscription/cancel` take
`idempotencyKey` in the body.

Keys are scoped per user, so replay cannot cross accounts. Behaviour:

- **same key + same body** → the original job, `deduplicated: true`, one reservation;
- **same key + different body** → `409 IDEMPOTENCY_KEY_REUSED`, original untouched, no extra charge.

The web client generates one key when the form is composed and reuses it for
every retry of that submission, so a double tap or a flaky connection cannot
produce two jobs.

### Ownership

Ownership is enforced **in the query**, not by a separate check. Knowing another
account's job, track, order, export or licence id yields `404` — including for
mutations. Verified in `tests/security.test.ts`.

---

## Public

### `GET /health` · `GET /ready`
Liveness and readiness. `/ready` checks the database; `/health` deliberately
does not, so a brief database blip drains traffic rather than restarting pods.

### `GET /v1/runtime`
What this deployment actually is. The web app renders the demo banner and
enables or disables features from this, so the interface can never claim a
capability the running configuration lacks.

```json
{
  "mode": "demo",
  "demo": true,
  "features": {
    "subscriptionsEnabled": false, "freeTrialEnabled": false,
    "wavExportEnabled": false, "commercialDeliveryEnabled": false,
    "realPaymentsEnabled": false
  },
  "adapters": { "auth": "dev", "text": "local-rules", "music": "demo-local",
                "storage": "local-fs", "queue": "local-mysql", "payments": "simulated" },
  "stripePublishableKey": null,
  "legalEntityConfigured": false
}
```

Publishable configuration only — no secret is ever exposed here.

### `GET /v1/products`
Price catalogue: tax-inclusive JPY, unit count, validity, renewal behaviour.
`available: false` for products that exist but are not open (subscriptions).

### `GET /v1/samples`
Landing-page samples with a `provenance` string stating where the audio came
from (UI-01). With a real provider this returns an empty list until pre-cleared
assets are configured — arbitrary generations are not used as samples.

### `GET /v1/legal/business-disclosure`
特定商取引法 details. `isPlaceholder: true` in demo; production refuses to boot
without real values.

### `POST /v1/rights-cases`
**Unauthenticated and free by design** (SEC-10) — a rights holder must never
need an account or a payment to file a complaint. Rate-limited to 5/hour.

A credible track-identified claim suspends distribution while it is reviewed.
The response states plainly that a suspension is **not** a finding of
infringement, and that files already downloaded elsewhere cannot be recalled.

### `GET /v1/rights-cases/:caseNumber`
Status lookup. Deliberately minimal — no reporter details, no track owner, no
evidence.

---

## Generation

### `POST /v1/generations` → `202`

Headers: `Idempotency-Key` (required).

```json
{ "scene": "night_walk", "prompt": "静かな夜の帰り道", "energy": 0.3,
  "durationSeconds": 30, "vocalMode": "instrumental" }
```

`prompt` is capped at 300 **Unicode code points** (counted by code point, not
UTF-16 unit). `durationSeconds` and `vocalMode` are fixed at launch and
re-imposed server-side regardless of what the client or the text model says.

Returns the full job view plus `deduplicated`. In one transaction the API
creates the job, reserves exactly one credit and writes the outbox row.

Failure modes that cost **nothing**: `PROMPT_BLOCKED`, `VALIDATION_FAILED`,
`INSUFFICIENT_CREDITS`, `RATE_LIMITED`. A rejected reservation leaves no job row
at all.

### `GET /v1/jobs/:id`

```json
{ "jobId": "…", "state": "PROCESSING", "phase": "processing",
  "trackId": null, "errorCode": null,
  "estimate": { "minSeconds": 30, "maxSeconds": 120, "delayed": false },
  "demo": true }
```

`estimate` is a **range**, never a percentage — UI-04 forbids a fabricated
precise progress figure. `delayed` flips after `JOB_DELAY_WARNING_SECONDS`
(default 180) so the UI stops promising an imminent result.

Poll with backoff. The client escalates 1.5s → 8s.

### `GET /v1/jobs`
Unfinished jobs for the caller, so the studio restores in-flight work after a
reload or re-login (GEN-10).

### `POST /v1/jobs/:id/cancel`

```json
{ "jobId": "…", "state": "CANCELLED", "cancelled": true, "reason": null }
```

Records the intent; whether it takes effect is decided under the version guard.
A job already submitted upstream returns `cancelled: false` with
`reason: "already_submitted_to_provider"` — the UI must not claim a cancellation
that did not happen (GEN-12). Cancelling before submission releases the credit.

### `GET /v1/entitlements/summary`
`availableUnits`, `reservedUnits`, `costOfNextGeneration` — what UI-03 shows
before submission.

---

## Tracks

### `GET /v1/tracks`
Query: `state`, `q`, `projectId`, `cursor`, `limit` (≤50). Caller's tracks only.
`previewUrl` is short-lived and re-issued per read; a suspended track gets none.

### `GET /v1/tracks/:id`
Track plus its export history.

### `POST /v1/tracks/:id/exports`

```json
{ "clipStartSeconds": 5, "clipDurationSeconds": 15, "fadeOut": true, "format": "mp3" }
```

`clipDurationSeconds` is 15 or 30. A 30s export must start at 0. The range is
validated against the real master duration. **No credit is consumed** — trimming
and re-downloading are free. The master is never overwritten; each export is a
new asset version, and an identical request reuses the existing object
(`reused: true`).

`format: "wav"` requires both `wavExportEnabled` **and** a lossless master.
Transcoding MP3 to WAV is refused rather than sold as a quality upgrade (UI-07).

### `POST /v1/exports/:exportId/download-url`
Re-issues a short-lived link. Ownership is re-checked every time — knowing an
asset id is not authorisation.

### `GET /v1/tracks/:id/license`
The terms frozen at generation time: provider, model, territory, allowed and
prohibited uses, audio SHA-256, derived versions, and a disclaimer stating this
is **not** a copyright certificate. Provider commercial terms are not exposed.

### `DELETE /v1/tracks/:id`
Soft delete. Returns `423 TRACK_SUSPENDED` if the track is evidence in an open
rights case — preservation beats a user-initiated wipe.

### `POST /v1/tracks/:id/title`
Rename. Owner only; a song that is not yours and a song that does not exist
both answer `404`, so an id cannot be tested for existence. Body `{ title }`.

The name is screened exactly as the title given at generation is — same rules,
same `PROMPT_BLOCKED` shape, `details.field: "title"` — because the title is
rendered on the song page, in the browser tab, in the share sheet and in the
link preview of a song anyone holding the link can open. Whitespace is
collapsed to single spaces and the result must be 1–120 code points; the
response returns the stored value, which is what the client should display
rather than what it sent.

No credit is spent and no audio is touched. Allowed in any state: a failed or
still-generating song is still the writer's to name.

### `POST /v1/tracks/:id/adopted`
Self-reported "I used this in real content". Deliberately distinct from a
download, so cost-per-adopted-result is not inflated by curiosity downloads
(§11.2).

---

## Billing

### `POST /v1/checkout`

```json
{ "priceKey": "drop_5", "idempotencyKey": "checkout-…" }
```

There is **no amount field** — price, currency and Stripe price id are resolved
from the versioned server catalogue, so there is nothing for a client to tamper
with (PAY-01). Card entry happens on the provider's hosted page.

### `GET /v1/orders/:id` · `GET /v1/orders`
Server-verified state. `entitlementGranted` is driven by the verified payment,
never by the browser reaching the success URL (PAY-02).

### `GET /v1/orders/:id/payments`
Payment, fee, refund and net amounts for reconciliation (PAY-11).

### `GET /v1/entitlements`
Balance, per-batch detail with expiry, and subscription state including
`endsAtJst` — the exact JST instant UI-11 requires.

### `POST /v1/subscription/cancel`

```json
{ "subscriptionId": "…", "idempotencyKey": "cancel-…" }
```

Sets cancel-at-period-end **server-side first**; success is reported only after
the provider confirms. Idempotent. A failure leaves the subscription untouched
and returns an error rather than an optimistic success (PAY-08).

### `POST /api/webhooks/stripe` (also `POST /v1/webhooks/stripe`)
Signature verified over the **raw body** with the endpoint's own secret. Verified
events are persisted and acknowledged immediately; the worker processes them
asynchronously. A forged, stale or malformed signature is recorded as unverified
and never processed, and answered **400**.

Two paths, one handler, one `webhook_events` table — so an event forwarded to
one and delivered to the other is stored and processed once. `/api/...` is what
the live endpoint posts to; `/v1/...` stays because the Stripe CLI forwarder and
any endpoint registered earlier still use it. Neither redirects to the other.

Both are unauthenticated by design: the signature is the authentication. There
is nothing to exempt them from — authentication in this API is a `Bearer` token
in the `Authorization` header, there is no cookie session (`@fastify/cookie` is
not a dependency) and so no CSRF middleware exists to make an exception in.

See [STRIPE_WEBHOOK.md](STRIPE_WEBHOOK.md) for the exact event list to tick in
the dashboard, the payload format and API version, and where the signing secret
is configured.

---

## Paying from a wallet (stablecoin)

Off by default, on every deployment, until the business conclusions in
[STABLECOIN_V1_PLAN.md](STABLECOIN_V1_PLAN.md) are in hand. `GET /v1/runtime`
carries a `stablecoin` block — `enabled`, `chainId`, and the currencies
actually switched on — and the web app renders nothing for this channel unless
that block says so.

There is no receiving contract, no allowance, and no server-held key: the only
thing that moves money is the customer's own wallet signing a plain ERC-20
`transfer`. Every endpoint below therefore either records what the customer
told us or reports what we have seen on the chain.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/payments/stablecoin/wallets` | The caller's own verified wallets, so the interface knows whether to ask for a signature |
| `POST /v1/payments/stablecoin/wallet-challenge` | A SIWE-style message to sign; single-use nonce, short expiry |
| `POST /v1/payments/stablecoin/wallet-verify` | Recovers the address from the signature and records the wallet. One wallet belongs to one account per chain |
| `POST /v1/payments/stablecoin/quote` | Creates or reuses the order and issues a priced quote, valid for `STABLECOIN_QUOTE_TTL_SECONDS`. Carries `amountAtomic` as a **string**, with `tokenDecimals` |
| `POST /v1/orders/:id/stablecoin-prepare` | The `transfer` calldata, built from the stored quote. The amount, token and receiver are the server's |
| `POST /v1/orders/:id/stablecoin-transaction` | A reported hash. A hint about **where to look**, never an instruction: attribution comes from the open intent of the transaction's own sender, so a hash copied from a block explorer resolves to that sender's order or to nothing. 202 means "we looked and there is nothing to act on yet" |
| `GET /v1/orders/:id/payment-status` | The order's status, the intent's state, and `entitlementGranted` — which is what "paid" means to a customer |

Two properties worth stating because a client could otherwise assume
otherwise:

- **`amountAtomic` is a decimal string and never a number.** 980 JPYC is
  980000000000000000000 atomic units, which a double cannot hold. Render it
  with the `tokenDecimals` on the same quote.
- **`orderStatus: 'paid'` is not delivery.** Marking the order paid and handing
  over what it bought are deliberately separate transactions, so a crash
  between them leaves a paid order waiting rather than an unpaid order holding
  delivered goods. Poll `entitlementGranted`.

---

## Operations console

`GET /v1/admin/*` requires `support` or `admin`; mutations that change licence
status or feature switches require `admin`. Roles come from our own users table,
never from a token claim.

| Endpoint | Role | Purpose |
| --- | --- | --- |
| `GET /v1/admin/overview` | support | Operations, cost, revenue, funnel |
| `GET /v1/admin/jobs` | support | Job search |
| `GET /v1/admin/jobs/:id/costs` | support | Per-job upstream cost trail |
| `GET /v1/admin/rights-cases` | support | Case queue (reporter email masked below admin) |
| `POST /v1/admin/rights-cases/:id/resolve` | **admin** | Dismiss / uphold / restore |
| `GET /v1/admin/settings` · `PUT /v1/admin/settings/:key` | **admin** | Runtime switches |
| `GET /v1/admin/reconciliation` | support | Ledger discrepancies |
| `GET /v1/admin/deletions` | support | Account deletion queue (SEC-11) |
| `POST /v1/admin/deletions/:id/verify` | **admin** | Confirm the requester owns the account |
| `POST /v1/admin/deletions/:id/execute` | **admin** | Carry out the erasure |
| `GET /v1/admin/audit-logs` | support | Audit trail |
| `GET /v1/admin/order-reviews` | support | Card orders whose delivery is held pending a person (⑥) |
| `GET /v1/admin/users?email=…` | support / admin | Accounts matching an email. **Prefix only**, three characters minimum, deleted accounts excluded — see `findUsersByEmail` for why it is not a substring search |
| `GET /v1/admin/users/:id` | support / admin | One account: balance, every batch of credits with its source and expiry, and orders |
| `POST /v1/admin/users/:id/grant` | **admin** | Gives credits away. Reason required. Capped per gift and per operator per rolling day (`ADMIN_GRANT_MAX_UNITS`, `ADMIN_GRANT_MAX_UNITS_PER_DAY`); recorded as `operator_gift`, never as `compensation` |
| `POST /v1/admin/users/:id/compensate` | support / admin | A make-good for a failure of ours. Capped at 20, recorded as `compensation`. Unchanged, and deliberately open to support where `grant` is not |
| `POST /v1/admin/order-reviews/:id/decide` | **admin** | Release and deliver, or refuse — reason required. Refusing does not refund; that happens in Stripe |
| `GET /v1/admin/stablecoin-payments` | support | Payments in review, money with no order to attach it to, and refunds owed |
| `POST /v1/admin/stablecoin-payments/:id/review` | **admin** | Accept a short, over or late payment, or reject it — reason required |
| `POST /v1/admin/stablecoin-transfers/:id/decide` | **admin** | Attach an unattributed transfer to an order, or write it off — reason required |
| `GET /v1/admin/accounting/stablecoin-export` | support | Monthly reconciliation CSV; payment and delivery dates kept apart |

Deletion is two steps on purpose. Verification is a human stating that the
person asking owns the account, and only a verified request can be executed:
"delete my account" arriving on a stolen session must not be self-executing.
Execution is synchronous and answers with what it did — songs erased, objects
removed, and the ones it would not touch. It keeps three things: orders and
payments for the statutory period (which is why the user row is anonymised
rather than deleted), songs under an open rights case, and songs other people
have licensed, because a buyer paid for the right to download those.

On S3 the delivery bucket is versioned, so removing an object makes it a
noncurrent version; the bucket's lifecycle rule expires those after 30 days.
The request response states that as `audioErasureDays`.

Every mutation requires a `reason` of at least 5 characters, written to
`audit_logs` with actor, timestamp and before/after state. The column is
`NOT NULL`, so an unexplained privileged action cannot be recorded — and
therefore cannot happen.

Runtime switches can only **narrow** what configuration already permits. An
operator cannot enable commercial delivery from the console.

---

## Development only

Registered only when the corresponding adapter is active, and `loadConfig`
refuses those adapters in production.

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/auth/dev-login` | Issues a real signed bearer token for a demo account |
| `POST /v1/dev/simulate-payment` | Drives a simulated checkout through the real webhook pipeline |
| `GET /v1/files` | Serves local storage objects; verifies the HMAC signature in constant time |

`GET /v1/files` refuses the quarantine zone outright, even with a valid
signature.

---

## Rate limits

| Route | Limit |
| --- | --- |
| `POST /v1/generations` | `GENERATION_RATE_LIMIT_PER_HOUR` (default 30/user/hour) |
| `POST /v1/tracks/:id/exports` | `EXPORT_RATE_LIMIT_PER_HOUR` (default 60/user/hour) |
| `POST /v1/rights-cases` | 5/hour per IP |
| Global | 300/minute |

Separately, `MAX_CONCURRENT_JOBS_PER_USER` (default 2) caps unfinished jobs and
returns `RATE_LIMITED` before any reservation is attempted.
