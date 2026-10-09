# Architecture

Implementation of `PROJECT_TASK.md` §4, §6 and §10. This document explains what
was built and, where a decision was contested, why it went the way it did.

---

## 1. Modules

| Location | Responsibility |
| --- | --- |
| `apps/web` | Japanese SPA: landing, studio, results, export, library, billing, admin |
| `apps/api` | Fastify modular monolith: auth, projects, jobs, entitlements, orders, licences, ops |
| `apps/worker` | Outbox dispatch, provider calls, status polling, audio processing, webhook consumption |
| `packages/contracts` | Request/response schemas, error codes, business enums, the state machine |
| `packages/providers` | TokenStars, music, storage, queue and payments adapters |
| `packages/db` | Schema migrations, repositories, the credit ledger, reporting queries |
| `infra/terraform` | AWS resources (Tokyo) |
| `infra/helm` | API and worker deployment |

The API and the worker are built as **separate images** from
`Dockerfile.api` and `Dockerfile.worker`. They still build from the same commit
and share the same workspace packages, but each runtime image contains only
the process it starts. This keeps image size, scanning, rollback and runtime
ownership independent while preserving one source of truth for the ledger and
state machine.

---

## 2. Request flow

```
Browser ──► ALB ──► API (EKS, private subnet)
                     │
                     │  ONE transaction:
                     │    • generation_jobs row
                     │    • entitlement reservation (1 credit)
                     │    • outbox row
                     ▼
                   RDS MySQL
                     │
      worker polls outbox ──► SQS ──► worker claims job (lease + SKIP LOCKED)
                                        │
                                        ├─► TokenStars: text → structured intent
                                        ├─► music provider: submit / poll
                                        ├─► S3 quarantine: raw output
                                        ├─► ffmpeg: duration, loudness, integrity
                                        └─► ONE transaction:
                                              • job → DELIVERED
                                              • reservation → consumption
                                              • track + licence snapshot
                                        ▼
                                   S3 delivery zone
Browser polls GET /v1/jobs/:id with backoff (never a held-open request)
```

### Why an outbox

A credit reservation and "work was queued" must both happen or neither.
Reserving in the database and then calling SQS leaves a window where a crash
charges the user for a job that never runs. The outbox row is written in the
same transaction as the reservation, and a separate dispatcher moves it to SQS.
A dispatch failure only delays work; it never loses a credit.

### Why polling rather than a held connection

An ALB is an entry point, not a place to wait for 90 seconds of upstream
generation. The client receives a job id immediately and polls with exponential
backoff up to 8 seconds. This is also what makes GEN-10 work: a user who closes
the tab, refreshes or re-logs in resumes from persisted state, because the state
was never in the connection.

---

## 3. Generation state machine

Defined once in `packages/contracts/src/enums.ts` and enforced by
`transitionJob`, which rejects any transition not in the table.

| State | Meaning | Credits |
| --- | --- | --- |
| `VALIDATING` | Checking identity, input, capability, availability | none |
| `RESERVED` | Job row created, one credit reserved | reserve 1 |
| `QUEUED` | Handed to the dispatcher | held |
| `SUBMITTED` | Provider acknowledged the request | no further charge |
| `UNKNOWN` | The request may or may not have reached the provider | held; **verify, never resubmit** |
| `PROCESSING` | Audio fetched; checking and quarantining | no further charge |
| `DELIVERED` | Audio and licence record available | reservation → consumption |
| `FAILED` / `REJECTED` | Terminal failure or undeliverable output | release; compensate if the batch expired |
| `CANCELLED` | Cancelled before reaching the provider | release |

Two guards make concurrent progress safe:

- **Optimistic version.** Every write is `WHERE id = ? AND version = ? AND state = ?`.
  A worker that read stale state simply loses and stops. This is how a duplicated
  SQS message (GEN-04), a repeated success callback (GEN-08) and a cancel racing
  a submit (GEN-12) all converge without either side double-charging.
- **Time-limited lease.** A worker claims a job with `FOR UPDATE SKIP LOCKED` and
  a lease expiry. If it dies mid-request (GEN-05) the lease expires and another
  worker re-claims it — without holding a database transaction open across the
  network call.

### UNKNOWN is not a failure

When a submission times out, the provider may well have accepted and started
billing. Treating that as a failure and retrying would produce a second billable
request; treating it as a success would charge for something that may not exist.
So the job moves to `UNKNOWN` and the worker **queries** by the job's stable
`provider_request_key`. Only evidence resolves it:

- provider has no record → fail, release the credit (GEN-06);
- provider has a result → deliver normally;
- no answer within `JOB_VERIFY_DEADLINE_SECONDS` (default 15 min, §12.3) → fail,
  release the credit, and record the upstream cost as one the platform carries.

If the result then arrives late (GEN-09), the worker sees a `release` entry
already exists, does **not** re-charge, records a `late_success` cost event, and
parks the track as `suspended` for an operator to decide.

---

## 4. The credit ledger

`PROJECT_TASK.md` §6.2 forbids maintaining a single overwritable `credits`
integer. The design has three layers, each of which independently prevents an
oversell:

**1. Append-only ledger** — `ledger_entries` records `grant`, `reserve`,
`consume`, `release`, `revoke`, `compensate`, `adjust`. Nothing is ever updated
or deleted. A correction is a new entry, never an edit.

**2. Derived counters with CHECK constraints** — `entitlement_batches` carries
`granted_units`, `reserved_units`, `consumed_units` under:

```sql
CHECK (reserved_units + consumed_units <= granted_units)
CHECK (granted_units >= 0 AND reserved_units >= 0 AND consumed_units >= 0)
```

An oversell is a database error, not a negative balance. `tests/ledger.test.ts`
asserts this holds even when application logic is bypassed entirely.

**3. Serialised mutation per user** — every entitlement transaction begins with
`SELECT id FROM users WHERE id = ? FOR UPDATE`. Concurrent reservations queue
instead of racing over batch selection.

### Exactly-once, expressed in the schema

PostgreSQL would use a partial unique index. MySQL has none, so a stored
generated column carries the same guarantee — a unique index ignores NULLs:

```sql
job_entry_uk CHAR(60) GENERATED ALWAYS AS (
  CASE WHEN job_id IS NOT NULL
        AND entry_type IN ('reserve','consume','release','compensate')
       THEN CONCAT(job_id, ':', entry_type) END
) STORED,
UNIQUE KEY ledger_entries_job_type_uk (job_entry_uk)
```

A job therefore reserves at most once, consumes at most once and releases at
most once. A duplicated message or repeated callback hits a duplicate-key error
rather than double-charging.

### Lock ordering

Inserting a job takes a **shared** FK lock on `users(id)`; reserving then wants
an **exclusive** lock on the same row. Two concurrent requests would each hold
the shared lock and wait for the other — a textbook deadlock, which showed up
immediately under the GEN-03 test. `createGeneration` therefore takes the
exclusive lock **first**, giving every path one lock order. `withTxRetry`
retries genuine deadlocks so a transient InnoDB victim is never reported to the
user as "out of credits".

### Batch selection

The batch expiring soonest is consumed first, and a batch whose `effective_from`
is in the future is never drawn on — §6.2 forbids borrowing against a later
billing period. If a batch expires while a job is still running (GEN-11), the
release restores the units to it and, because it is expired, a fresh
compensation batch is issued so the credit is not silently lost.

### Reconciliation

`reconcileBalances()` re-aggregates the ledger and compares it against the
counters. Any discrepancy is **reported and alerted, never auto-corrected** —
silently "fixing" it would destroy the evidence of the bug that caused it. The
worker runs this every minute.

---

## 5. Payments

Two independent idempotency layers, as PAY-05 requires:

1. `webhook_events (provider, event_id)` — the same event delivered twice is
   stored once.
2. Business keys — `entitlement_batches (user_id, source, source_ref)` — so two
   *different* events describing the same payment still grant only once. A
   one-time order keys on the order id; a subscription period keys on
   `<subscription>:<invoice>`.

The HTTP handler only **verifies and stores**; the worker processes
asynchronously. A slow grant therefore cannot make Stripe time out and retry.
Signature verification runs over the **raw request body** — the JSON parser is
bypassed for `/v1/webhooks/*` specifically, because parsing and re-serialising
would break the signature.

Ordering is not assumed. Where an event could be stale, the current object is
re-read from Stripe and `subscriptions.last_event_at` acts as a monotonic guard,
so an out-of-order `customer.subscription.updated` cannot resurrect a cancelled
subscription.

**Refunds** revoke only units that are neither reserved nor consumed. Work
already delivered is not clawed back and an in-flight job still finishes; what
remains is reported for manual handling rather than force-revoked.

---

## 6. Audio pipeline and rights

Raw provider output lands in the **quarantine** bucket, which the delivery path
cannot read. Before anything becomes downloadable, ffmpeg verifies that the file
is decodable, non-empty, within the configured duration tolerance, and not
silent. A file that fails never becomes downloadable and never consumes a credit.

What that check is **not**: it is not a copyright check, and it is not a vocal
detector. A real unintended-vocal check needs a dedicated classifier and, per
AI-07, human review. `docs/OPEN_ITEMS.md` records that as outstanding rather
than claiming it passes.

Delivery uses short-lived presigned URLs issued only after an ownership check.
Storage keys embed the owner id plus a hash, so they are not guessable from a
track id. The quarantine zone is not downloadable even with a valid signature.

**Licence snapshots** freeze the terms in force at generation time — provider,
model, contract version, territory, allowed and prohibited uses, and the audio
SHA-256. A database trigger rejects any update to those columns; only `status`
may change. A later commercial agreement therefore cannot retroactively rewrite
what a user generated under (SEC-08).

The record is called a **利用条件記録 (usage-terms record)**, never a copyright
certificate, and every view of it carries a disclaimer saying so.

---

## 7. Provider adapters

`PROJECT_TASK.md` §3.2 forbids inventing a vendor's endpoint paths, model ids or
capabilities. So:

- **TokenStars** — base URL, model id, chat path and request-id header all come
  from configuration. `structuredOutputs` defaults to **false**: whether
  TokenStars passes OpenAI's structured-output protocol through is unverified,
  so the adapter parses, validates against our own schema, and allows exactly
  **one** repair round trip before giving up (AI-03).
- **Music (HTTP)** — every path and every JSON pointer is configuration. The
  adapter refuses to construct if the mapping is absent, rather than guessing and
  reporting a fabricated integration.
- **Capabilities gate the UI** — the API only exposes controls the configured
  provider reports as genuinely supported. WAV export is unavailable unless the
  master is lossless; `commercialDeliveryPermitted` is false without a signed
  agreement, and the licence snapshot records that state per track.

The demo adapter's provider id is literally `demo-local` and its contract
version `demo-no-contract`, both stored on every job and licence record. Nothing
produced through it can be mistaken later for real provider output.

### Untrusted input

User text is data. It never becomes a system instruction, a URL to fetch, or a
database operation. Input screening runs **before any spend** and blocks artist
and song references, lyric and vocal requests, voice imitation, reference-media
URLs, personal information and prompt-injection attempts. A block costs no
credit, and every block is marked appealable — it says "outside what we accept",
never "you attempted something illegal" (SEC-07).

Provider audio URLs are fetched under SSRF guards: HTTPS only, host allow-list,
every resolved IP must be public (which blocks the metadata endpoint), redirects
refused, byte cap and timeout enforced while streaming.

---

## 8. Data model

17 tables, per §10. Ownership is part of every query rather than a separate
check a caller might forget; JPY amounts are integers; timestamps are
`DATETIME(3)` in UTC and rendered JST only at the edge; audio never enters the
database — only storage keys and hashes.

| Group | Tables |
| --- | --- |
| Identity | `users`, `projects` |
| Generation | `generation_jobs`, `generation_attempts`, `tracks`, `asset_versions` |
| Credits | `entitlement_batches`, `ledger_entries` |
| Billing | `product_catalog`, `orders`, `payments`, `subscriptions` |
| Provenance | `license_snapshots` |
| Infrastructure | `outbox`, `webhook_events`, `local_queue_messages` |
| Governance | `rights_cases`, `audit_logs`, `analytics_events`, `runtime_settings` |

`product_catalog` is versioned by `(price_key, version)` and orders reference the
version they were bought at, so changing a price never alters an existing order.

---

## 9. Local adapters

The local storage and queue adapters mirror their AWS counterparts' contracts
exactly — including short-lived signed URLs (HMAC, verified in constant time)
and SQS Standard's awkward parts: visibility timeouts, redelivery after a crash,
no ordering guarantee, and a dead-letter path after `maxReceiveCount`.

A consumer written against the local queue is therefore already correct under
real SQS. §4.2 is explicit that this passing locally is **not** evidence that
real S3 or SQS was verified, and `docs/ACCEPTANCE.md` records those separately.

---

## 10. Design trade-offs

**One image for API and worker.** Slightly larger deployment; in exchange the
two processes cannot drift on ledger or state-machine rules.

**Raw SQL, no ORM.** The ledger's correctness lives in lock ordering, `SKIP
LOCKED`, generated columns and CHECK constraints. An ORM would obscure exactly
the parts that matter most, and this is a money path.

**Counters alongside the append-only ledger.** Aggregating the ledger on every
balance read would be correct but slow, and would make the CHECK-constraint
guarantee impossible. Keeping both plus a reconciliation job gives fast reads,
a database-enforced invariant, and detection if they ever disagree.

**Operator switches can only narrow.** Runtime settings can turn features off,
never on. Otherwise a database row could re-enable something the run mode
forbids — an operator must not be able to enable commercial delivery from a
console.

**Metrics report "not computable".** §11 requires an immature sample to count as
neither success nor failure, so the reporting layer returns `null` with a stated
reason rather than `0%`, which would read as a real and bad result.
