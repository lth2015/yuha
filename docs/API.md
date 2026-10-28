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
The web app maps every code to text in Chinese, Japanese and English **and a
concrete next step** (UI-12); the mapping is typed over the full union, so
adding a code without adding copy is a compile error. Messages never contain
secrets, stack traces or raw prompts.

The table lists the codes a client meets most often; `errors.ts` is the
complete list and the source of truth for each status.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing, malformed or expired token |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `ACCOUNT_SUSPENDED` | 403 | An operator suspended the account. Returned by every authenticated route **and at sign-in** (dev login, the Google exchange, MFA verify), so no session is minted; the web client drops its token on it and the sign-in page says why |
| `MFA_REQUIRED` | 403 | A staff route, and the account has no second factor enrolled yet |
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
| `SUBSCRIPTION_NOT_FOUND` | 404 | Absent, or someone else's subscription |
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
`paymentMethods` lists how each product can be paid — `card`, and each enabled
stablecoin (`jpyc`, `usdc`) — with `available` and, when unavailable, a
`reason` (`card_closed`, `no_auto_renewal`). This is the only source the web
app uses to offer a payment method; see docs/PAYMENTS_DESIGN.md.

### `GET /v1/samples`
Landing-page samples with a `provenance` string stating where the audio came
from (UI-01). With a real provider this returns an empty list until pre-cleared
assets are configured — arbitrary generations are not used as samples.

### `GET /v1/legal/business-disclosure`
特定商取引法 details: `entityName`, `representative`, `contact`, `phone`.
`isPlaceholder: true` in demo; production refuses to boot without real values.
There is no address field: the operator's address is withheld and provided on
request (the 特商法 page says so), and config has no variable for it.

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

Optional `dedication` — a song for somebody (docs/GIFT_AND_SHARE_SPEC.md):
`{ "to": "小林", "occasion": "birthday", "note": "谢谢你一直都在", "lang": "zh" }`.
`to` ≤ 20 and `note` ≤ 120 code points; `occasion` is one of `birthday thanks
sorry love miss farewell cheer other`; `lang` is the creator's interface
language, which the brief to the lyric writer is phrased in. Both texts are
screened (`PROMPT_BLOCKED` with `field: dedication.to | dedication.note`)
before anything is reserved. With a dedication, simple mode needs no `prompt`.
The track view carries it back as `dedication` (null for every other song).

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

### `POST /v1/lyrics/draft` → `200`
Lyrics written before generation, for the creator to read and edit: /create
calls it when a sung sketch arrives from Air composition. Body: `prompt`
(required), `styles`, `durationSeconds` (as in `POST /v1/generations`).
Returns `{ lyrics, remaining }`.

No credit pays for it, so each account gets `LYRIC_DRAFTS_PER_DAY` (default 10)
in any 24 hours; the next is `429 RATE_LIMITED`. The count is race-safe and is
all that is stored (`lyric_drafts` has no text column). The prompt is screened
like a generation prompt (`422 PROMPT_BLOCKED`, not counted); the daily upstream
budget applies (`429 BUDGET_EXCEEDED`). Once the model is called the draft
counts whatever comes back, because it was paid for: a model failure is
`503 UPSTREAM_UNAVAILABLE`, and a refusal, or lyrics the lyrics screen blocks,
is `422 UPSTREAM_REJECTED`. Every call is a `provider_cost_events` row with no
job and `usage_data.purpose = "lyric_draft"`.

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

### `PUT /v1/tracks/:id/share-card`
Owner only. `{ "png": "<base64>" }` — the 1200×630 link-preview image the
owner's browser drew (`apps/web/src/lib/share-art.ts`). Must be a PNG of
exactly that size, ≤ 1.5 MB. Replaces the previous card; removed with the
account.

### `POST /v1/tracks/:id/share-video` → `video/mp4`
Owner only. `{ "start": 38.5, "duration": 20, "frames": [{ "at": 0, "jpeg": "<base64>" }, …] }`:
up to 24 JPEG frames (720×1280), each shown from `at` seconds into the clip
until the next. The response is the MP4 itself — the frames on the song's own
audio with a waveform — and is not stored. One encode at a time per API
process: a second gets `RATE_LIMITED` (try again in ~15 s).

### `GET /v1/share/songs/:id` · `GET /v1/share/songs/:id/card.png`
The link a share posts. A link-preview crawler (X, Facebook, LINE, Slack…, by
User-Agent) gets a page of Open Graph / Twitter Card tags describing the song —
title, who it was written for, its card — with `og:url` pointing back at this
address; anybody else gets `302` to the song page. Only a public, playable
song is described; any other id gets the site's own tags, so a private title
never reaches a crawler. `Cache-Control: private, no-store` and `Vary:
User-Agent`, because the answer depends on who asks. `card.png` serves the
uploaded card while the song is public, and redirects to `/brand/og-card.png`
otherwise.

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

`receiptUrl` is the Charge's receipt for a one-time card payment and the first
invoice's hosted page for a subscription, recorded when the order is paid (a
Checkout Session has no receipt of its own). For a card order paid before that
was recorded, `GET /v1/orders` fetches up to three missing links from Stripe
**after** answering, so the list is never held up by Stripe and the next call
shows them. Stablecoin orders have none.

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

### `POST /v1/subscription/portal`

```json
{ "subscriptionId": "…" }
```

Returns `{ "url": "…" }`, a one-time link into Stripe's Customer Portal for
the customer this subscription bills: change the card, download invoices. The
caller's own subscription only (`SUBSCRIPTION_NOT_FOUND` otherwise). The
return address is built server-side from `PUBLIC_WEB_URL` (`/settings/billing`);
nothing in the request becomes part of a URL. Until the portal has been
configured in the Stripe dashboard, Stripe refuses and this answers
`SERVICE_DISABLED`; Stripe's reason goes to the log, not the response. 10 per
minute.

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
| `POST /v1/payments/stablecoin/quote` | Creates or reuses the order and issues a priced quote, valid for `STABLECOIN_QUOTE_TTL_SECONDS`. Carries `amountAtomic` as a **string**, with `tokenDecimals`. USDC quotes also carry `rateText` (USD/JPY as the source wrote it) and `rateBufferBps`; both are `null` for JPYC. A USDC quote is refused with `SERVICE_DISABLED` (and `details.reason`: `unconfirmed` / `stale` / `divergent`) when the rate cannot be trusted — see docs/PAYMENTS_DESIGN.md §4 |
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
| `GET /v1/admin/netx-payments` | support | NETX configuration, acceptance state and fixed yen price |
| `PUT /v1/admin/netx-payments` | **admin** | `{ accepting, reason }`; pause/resume new NETX quotes. Existing quotes and scanning continue. Uses the separate `netx_payments` setting |
| `GET /v1/admin/reconciliation` | support | Ledger discrepancies |
| `GET /v1/admin/deletions` | support | Account deletion queue (SEC-11) |
| `POST /v1/admin/deletions/:id/verify` | **admin** | Confirm the requester owns the account |
| `POST /v1/admin/deletions/:id/execute` | **admin** | Carry out the erasure |
| `GET /v1/admin/audit-logs` | support | Audit trail (raw rows) |
| `GET /v1/admin/stats?granularity=&from=&to=` | support | The dashboard: page views and visitors, signups, generations (delivered / failed / in progress), paid orders and revenue by card / JPYC / USDC, card refunds, credits granted by source and consumed. `granularity` is `day` (default) · `week` (ISO, keyed by its Monday) · `month` · `year`; buckets are Japan-time and zero-filled, with `previous` totals for the same-length span before. Default span ends today (JST): 30 days, 12 weeks, 12 months or 5 years. More than 400 buckets is refused. Stablecoin refunds are settled by hand and are not in `refunds` |
| `GET /v1/admin/orders?status=&method=&email=&from=&to=&before=&limit=` | support | Orders across every account, newest first. `method` is `card` · `jpyc` · `usdc`; `email` is a prefix; `from`/`to` are JST days; `before` (ISO time) pages, and `more` says there is another page. Each row says whether delivery is held for review and carries the Stripe payment intent |
| `GET /v1/admin/audit?action=&email=&before=&limit=` | support | The audit log with actor and subject emails resolved. `action` is a prefix (`user.` for suspensions and role changes); `email` matches actor or subject |
| `GET /v1/admin/order-reviews` | support | Card orders whose delivery is held pending a person (⑥) |
| `GET /v1/admin/users?email=…` | support / admin | Accounts matching an email. **Prefix only**, three characters minimum, deleted accounts excluded — see `findUsersByEmail` for why it is not a substring search |
| `GET /v1/admin/users/:id` | support / admin | One account: balance, its credit batches with source and expiry, orders, its last 20 generations, and what operators have done to it (from `audit_logs`, lookups excluded). The batch and order lists are capped and carry `creditsTruncated` / `ordersTruncated`. Reads are written to `audit_logs` |
| `POST /v1/admin/users/:id/suspend` · `/reactivate` | **admin** | Suspend or lift a suspension — reason required. Takes effect on the account's next request and refuses its next sign-in (`ACCOUNT_SUSPENDED`). Never yourself, never another administrator, never a deleted account; a repeat answers `changed: false` and writes no second audit row. Does not cancel subscriptions or refund — that is done in Stripe |
| `POST /v1/admin/users/:id/role` | **admin** | `{ "role": "user" \| "support" \| "admin", "reason": "…" }`. Not your own role, and only on an active account |
| `POST /v1/admin/users/:id/grant` | **admin** | Gives credits away. Reason required (≤200 — it also lands in `ledger_entries.reason`, which is VARCHAR(255)). Optional `idempotencyKey` makes a retry a retry rather than a second gift, answering `replayed: true`. Capped per gift and per operator per rolling day (`ADMIN_GRANT_MAX_UNITS`, `ADMIN_GRANT_MAX_UNITS_PER_DAY`); recorded as `operator_gift`, never as `compensation`. Refuses a deleted or suspended account |
| `GET /v1/admin/credit-resets` | **admin** | What a credit reset started now would give (`preview`: accounts, topped accounts/units, bonus accounts/units, floor, bonus, payment window start) and the last 10 resets. [CREDIT_RESET.md](CREDIT_RESET.md) |
| `POST /v1/admin/credit-resets` | **admin** | Starts a credit reset, or continues the one its `idempotencyKey` started; reason required (audited). `202` at once; it runs in the background. `409 CONFLICT` while another is unfinished |
| `GET /v1/admin/credit-resets/:id` | **admin** | One reset's progress and totals |
| `POST /v1/admin/users/:id/compensate` | support / admin | A make-good for a failure of ours. Capped at 20 per call and at `ADMIN_COMPENSATION_MAX_UNITS_PER_DAY` per operator per rolling day, recorded as `compensation`. Refuses a deleted or suspended account. Deliberately open to support where `grant` is not |
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

## Telemetry

First-party only: rows go to `analytics_events` in our own database, and no
third-party collector is involved. All three answer `202` with an empty body,
and a failure to record is logged, never returned.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/client-errors` | none | A browser crash caught by the error boundary. Unauthenticated on purpose: a crash on the sign-in screen is the one most worth hearing about |
| `POST /v1/previews` | optional | Ten seconds of a song were actually heard — the day-one activation metric |
| `POST /v1/visits` | optional | A page was shown; the dashboard's visit numbers. Body `{ visitorId, path, refHost? }`: `visitorId` is a random UUID the browser made and keeps in localStorage (not the account, not an IP); `path` is stored without query string or fragment and with identifier-like segments collapsed to `:id`, because a link-shared song's id is the key to it; `refHost` is only the referring site's host. Staff and demo traffic are marked internal and not counted. 120 per minute |

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


### Generation waiting line

`POST /v1/generations`, `GET /v1/jobs/:id` and `GET /v1/jobs` include
`queuePosition: number | null`. It is a snapshot of the owner's position among
unfinished jobs on the same provider, not a promised wait time. During an
active dispatch the phase is `generating` and the position is null, even if
the provider has not acknowledged submission yet. Lists batch the position
query and never return other users' job data.

`POST /v1/jobs/:id/cancel` returns `cancelled: true` only after cancellation
and credit release commit. An active dispatch may return false while the
worker checks the cancellation before its music call; an already submitted
job remains governed by the provider's real outcome.

`GET /v1/admin/overview` includes `operations.generationFailures`, a seven-day
aggregate of `{code, state, count}` for FAILED/REJECTED jobs. The adjacent
technical success rate uses finished jobs only; the dashboard's submission
cohort delivery share also contains jobs still in progress and is labelled
separately. No historical success-rate improvement is inferred from a local
fixture or a current `/healthz` snapshot.
