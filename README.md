# YUHA

**Any song you can describe.** An AI song studio: describe an idea (or bring
your own lyrics), pick styles, energy and length, and get a finished song —
vocals sung or instrumental, 30 seconds to four minutes — with a persistent
player, a private library and MP3 download. Payments run on Stripe (test mode
locally); sign-in is Google OAuth plus a development login for demo mode.

> Repo note: the product is **YUHA**. Two earlier names survive in places that
> cannot be renamed safely — `PROJECT_TASK.md` and `spec/` are the original
> brief and stay as written records, and the applied migration
> `0002_sonare_songs.sql` is checksum-tracked, so its name and contents are
> frozen. Local and deployed infrastructure identifiers (the Helm chart, the
> Terraform resources, the dev database) still read `loopscene`; renaming them
> would force resource recreation, so that is a deliberate, separate decision.

> Scope note: there is **no public feed and no likes**. Songs are private, and
> publishing means anyone holding the link can open it. The platform sells its
> own service and does not split licence revenue with creators — what a licence
> records is authorship and usage rights, which is the part intended to carry
> over to on-chain proof later.

> **This is not ready to charge anyone.** No music-provider agreement is signed,
> no legal review has happened, and no AWS account has been provisioned. Demo
> mode defaults to synthesised audio and simulated payments, and says so
> continuously in the interface. See
> [`docs/LAUNCH_READINESS.md`](docs/LAUNCH_READINESS.md) for the full list of
> what is still missing.
>
> "Demo" describes the defaults, not a ceiling. Each adapter is chosen
> independently, so a local run can hold real Stripe **test-mode** keys and a
> real TokenStars key while the music stays synthesised — which is how the
> payment path was actually exercised. Only `production` mode forbids the
> stand-ins, and it refuses to boot if any of them is selected.

---

## Quick start

Requirements: **Node ≥ 22.13**, **pnpm 11** (or `corepack pnpm`), **Docker** (for MySQL), **ffmpeg**.

```bash
cp .env.example .env
# Fill in the two secrets the demo needs:
#   DEV_AUTH_SECRET       — openssl rand -hex 32
#   STORAGE_SIGNING_SECRET — openssl rand -hex 32

pnpm bootstrap    # install, synthesise audio fixtures, start MySQL, migrate, seed
pnpm dev          # API :4000, worker, web :5173
```

Then open <http://localhost:5173> and sign in with one of the seeded demo
accounts:

| Account | Purpose |
| --- | --- |
| `creator@example.jp` | ordinary creator with 10 credits |
| `empty@example.jp` | creator with no credits (tests the top-up path) |
| `support@example.jp` | support role — read-only console plus compensation |
| `admin@example.jp` | administrator — rights cases and feature switches |

These are **development identities**. `loadConfig` refuses to start in
production mode if the dev auth adapter is selected, so they cannot exist there.

### Commands

| Command | What it does |
| --- | --- |
| `pnpm bootstrap` | One-shot local setup (install → fixtures → database → migrate → seed) |
| `pnpm dev` | API, worker and web together |
| `pnpm build` | Build every package and app |
| `pnpm typecheck` | Typecheck the whole workspace |
| `pnpm test` | Full test suite against a real MySQL |
| `pnpm db:up` / `db:down` | Start / stop the MySQL containers |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:reset` | Drop and recreate (refuses anything not named dev/test/local) |
| `pnpm seed` | Price catalogue, landing samples, demo accounts |
| `pnpm fixtures:audio` | Re-synthesise the demo audio fixtures |

---

## Run modes

The mode is one explicit value, and the adapter selection has to be consistent
with it. An illegal combination fails at start-up rather than producing a
half-real service (`PROJECT_TASK.md` §3.1).

| Mode | Identity | Audio | Payments | Notes |
| --- | --- | --- | --- | --- |
| `demo` | dev login | synthesised fixtures | simulated *(default)* | Local development. Banner always visible. Any adapter can be overridden — `PAYMENTS_ADAPTER=stripe` with test keys is the supported way to exercise real checkout locally. |
| `integration` | Cognito or dev | real provider as credentials allow | Stripe **test** mode | Record which dependencies are real per run. |
| `production` | Cognito only | licensed provider only | Stripe live | Refuses to boot without real legal-entity details. |

Production refuses, at start-up, to run with: the development login, the demo
music adapter, simulated payments, local storage, a test Stripe key, a
`DEV_AUTH_SECRET`, `DATABASE_SSL=false`, or placeholder 特定商取引法 details.
Those refusals are covered by tests in `tests/security.test.ts`.

Two further guards apply in every mode:

- `MUSIC_COMMERCIAL_DELIVERY=true` is rejected while the demo adapter is in use.
  A synthesised tone has no agreement behind it and can never carry a commercial
  licence (SEC-09).
- `FEATURE_WAV_EXPORT_ENABLED=true` is rejected unless the provider actually
  delivers lossless audio. Transcoding MP3 to WAV is not a quality upgrade and
  is not offered as one (UI-07).

---

## Architecture at a glance

```
apps/web        React SPA (Japanese, mobile-first) → S3 + CloudFront
apps/api        Fastify modular monolith           → ALB → EKS
apps/worker     Outbox dispatch, provider calls, audio processing, webhooks
packages/contracts   zod schemas, error codes, business enums
packages/providers   TokenStars, music, storage, queue, payments adapters
packages/db          Migrations, repositories, the credit ledger
infra/terraform      AWS (Tokyo): EKS, RDS MySQL, S3, SQS, Cognito, CloudFront
infra/helm           API + worker deployment, digest-pinned
```

Request path: the API creates the job, reserves a credit and writes an outbox
row **in one transaction**; the worker dispatches to SQS, calls the providers,
verifies the audio and delivers. The browser polls with backoff — no request is
ever held open waiting for audio.

`docs/ARCHITECTURE.md` has the full picture, including the state machine and the
ledger design.

### Database: MySQL, not PostgreSQL

`PROJECT_TASK.md` §1.1 and §4 say "RDS PostgreSQL". The actual deployment target
is a **MySQL-compatible RDS**, so `packages/db` targets **MySQL 8.0 / Aurora
MySQL 3.x**. 8.0 is a hard floor — three of its features carry the ledger's
correctness guarantees:

| Feature | Used for |
| --- | --- |
| `SELECT … FOR UPDATE SKIP LOCKED` | Job, outbox and queue claiming without two workers colliding |
| Enforced `CHECK` constraints | The anti-oversell invariant on `entitlement_batches` |
| `STORED` generated columns | Standing in for PostgreSQL partial unique indexes (a unique index ignores NULLs) |

One operational consequence: creating the licence-immutability trigger (SEC-08)
requires `log_bin_trust_function_creators=1`. It is set in `docker-compose.yml`
locally and in the RDS parameter group in `infra/terraform/data.tf`. The
migration fails with an explicit message rather than skipping the trigger.

---

## Testing

```bash
pnpm db:up          # the test database runs on :53307, separate from dev
pnpm test
```

159 tests across 13 files run against a **real MySQL instance**, never an
in-memory stand-in — §12.1 requires the ledger transactions, concurrency and
unique constraints to be verified against the engine that actually enforces
them.

| File | Covers |
| --- | --- |
| `tests/ledger.test.ts` | GEN-01/03/08/09/11, PAY-05/09, reconciliation, concurrent contention |
| `tests/generation.test.ts` | The HTTP surface and the real worker pipeline: GEN-01…12, AI-03/05/06 |
| `tests/payments.test.ts` | PAY-01…11 through the real webhook pipeline |
| `tests/stripe-invoice-shape.test.ts` | The Invoice/Subscription field layout Stripe actually sends |
| `tests/security.test.ts` | SEC-01…13, SSRF guards, run-mode boundaries, audit logging |
| `tests/budget.test.ts` | The daily upstream spend cap and what it refuses |
| `tests/market.test.ts` | Licensing a song, and who may not license one |
| `tests/mfa.test.ts` | TOTP enrollment, challenge, recovery codes |
| `tests/demo-provider.test.ts` | What the demo adapter refuses to pretend it can do |
| `tests/tokenstars.test.ts` | Reply budget, truncation, refusal states |
| `tests/telemetry.test.ts`, `tests/explore.test.ts`, `tests/lyrics.test.ts` | Analytics events, play counting, lyric timing |

One caveat worth knowing before trusting a green run: most payment tests drive
the **simulated** adapter, whose fixtures were written from the same
understanding of Stripe that the production code holds. A simulator agrees with
the belief it was built from, so it cannot detect that Stripe has changed. It
did not: subscribers paid and received nothing for as long as the current API
version has been in use, while every test passed. `stripe-invoice-shape.test.ts`
exists because of that, and its payloads are trimmed copies of real ones —
keep them that way.

Fault injection uses markers (`__FAULT_FAIL__`, `__FAULT_REJECT__`,
`__FAULT_UNKNOWN__`) carried in the generation brief, so failure tests drive the
same production code path rather than a test-only branch inside the worker.

---

## Demo audio

Every fixture in `assets/fixtures/audio/` is synthesised from scratch by
`scripts/make-audio-fixtures.mjs` using ffmpeg oscillators and noise sources.
There is no third-party recording, sample or model output in any of them, so the
demo path carries no licensing question at all.

They are synthetic tones, not music. Per §8 they demonstrate that the
engineering pipeline works; they are not evidence of model quality, originality
or commercial value.

---

## Deployment

Terraform and Helm are written to be reviewable and are validated in CI
(`terraform validate`, `helm lint`, `helm template`). **Nothing has been
applied** — no AWS account has been authorised for this project, so every AWS
acceptance item is recorded as `BLOCKED_EXTERNAL` in `docs/ACCEPTANCE.md`.

```bash
docker build -t loopscene:local .    # one image, both workloads
terraform -chdir=infra/terraform init -backend=false && terraform -chdir=infra/terraform validate
helm template loopscene infra/helm/loopscene --set image.api.digest=sha256:… --set image.worker.digest=sha256:…
```

The Helm chart **refuses to render** without digest-pinned images: a mutable tag
would make "roll back to the previous release" ambiguous.

`docs/OPERATIONS.md` covers deployment, refunds, compensation, reconciliation,
alerts, rollback and recovery.

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Modules, data flow, state machine, schema, design trade-offs |
| [`docs/UI_DESIGN.md`](docs/UI_DESIGN.md) | Design system and direction, with the competitive review behind it |
| [`docs/API.md`](docs/API.md) | Endpoints, error codes, idempotency rules |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Deploy, refund, compensate, reconcile, alert, roll back, recover |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | Every UI/GEN/PAY/AI/SEC item with a result and evidence |
| [`docs/ACCEPTANCE_PAYMENTS.md`](docs/ACCEPTANCE_PAYMENTS.md) | What the Stripe sandbox has actually been made to do, and what is still only argued |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | Every environment variable, and which run modes refuse which values |
| [`docs/DEPLOY_AWS.md`](docs/DEPLOY_AWS.md) | The AWS deployment path, none of which has been applied |
| [`docs/UI_CRAFT.md`](docs/UI_CRAFT.md) | The detail rules the interface is held to |
| [`docs/OPEN_ITEMS.md`](docs/OPEN_ITEMS.md) | What is unfinished, what is blocked, and on whom |
| [`docs/LAUNCH_READINESS.md`](docs/LAUNCH_READINESS.md) | What must be true before charging anyone |

---

## Scope

Built: full-song generation (lyrics sung or instrumental, 30s–4min), the
Simple/Custom studio, a persistent queue player, link sharing on and off, a
private library, MP3 download and trimming, per-song usage and authorship
records, rights-complaint handling, Google OAuth + development login, Stripe
checkout / subscriptions / refunds (JPY catalogue, tax-inclusive: DROP ¥980,
CREATOR ¥1,980/month, STUDIO ¥3,980/month), an async job pipeline with the
credit ledger, and the operations console.

Plays are counted server-side and shown to **nobody**: `playCount` is
deliberately absent from the track view a client receives
(`packages/contracts/src/generation.ts`), so no later change can render it onto
a page by accident. Operations needs to know what gets listened to; a private
song with two plays should not be made to look like a failure.

Deliberately **not** built: a public feed or social graph, likes, creator
revenue sharing, voice imitation of real people, cover versions,
reference-audio upload, music distribution, royalty splitting, Content ID
registration, remixing, annual or unlimited plans, auto top-up, transferable
credit balances, native apps, and video upload or composition.

None of these are reachable through a hidden entry point or a provider default —
`vocalMode` is re-imposed server-side on every request, and the input screen
rejects voice-imitation, quoted-lyrics and artist-reference prompts before any
spend occurs.

## Music provider: GLM preset

`MUSIC_ADAPTER=glm` wires the generic HTTP adapter with GLM (Z.ai bigmodel)
defaults — async submit + poll, 30s–4min songs, vocals supported. Only
`MUSIC_API_KEY` is required; every endpoint path/field remains overridable via
the `MUSIC_*` variables in `.env.example`. Until a signed agreement exists the
preset reports `commercialDeliveryPermitted: false` (SEC-09), so demo-mode
synthesised audio is what ships by default. Swap to any provider by filling in
the `http` adapter's mapping from its documentation.

## Two-factor authentication (Google Authenticator)

Sign-in is Google OAuth (PKCE + JWKS-verified id tokens); accounts can add a
TOTP second factor compatible with Google Authenticator: enrollment shows a
QR `otpauth://` URI, confirmation requires a live code, and every later
sign-in is intercepted by a 5-minute single-use challenge token until a valid
code (or a one-time recovery code) is presented. Secrets are AES-256-GCM
encrypted at rest; recovery codes are SHA-256 hashed and consumed one at a
time; disable requires a valid code. Google's consumer accounts expose no MFA
API we can call on a user's behalf, so this is the standard commercial
integration of Google's authenticator surface with our own verified flow.

## Licensing and the authorship record

A song whose link is open can be licensed by another user (**¥980**,
tax-inclusive, `market_license` catalogue key). The buyer receives per-track
download rights.
The platform sells its own service and does **not** split that revenue with
creators, so there is no earnings ledger and no payout machinery.

What each sale writes is a `track_licenses` row: who authored the song, who
holds usage rights to it, and what was paid, idempotent on the order id. That
record is deliberately kept as a system of record — it is the authorship proof
intended to carry over to on-chain attestation later, and it must outlive any
monetisation model layered on top of it.

## Lyric alignment

Synced lyrics carry a provenance label: `aligned` timings come from a real
vocal-sync model via the configurable HTTP alignment adapter
(`ALIGNMENT_ADAPTER=http` + the `ALIGNMENT_*` mapping from that model's
documentation — nothing is invented); until one is configured the worker
stores deterministic line timings labelled `estimated`, and the UI says
"Estimated sync" rather than implying word-level accuracy.

## Google login

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI`
(redirect: `<api-origin>/v1/auth/google/callback`, registered verbatim in Google
Cloud Console). The button appears on the sign-in card automatically; the flow
is authorization-code + PKCE with a signed state, and the SPA exchanges a
60-second one-time code for its session (no token ever sits in a URL).
