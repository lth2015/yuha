# Contributing to YUHA

YUHA is Apache-2.0 (`LICENSE`). Who stewards the code, and why the hosted
service at yuha.studio is a separate thing with separate obligations, is in
`GOVERNANCE.md` — read that before touching anything on a legal page.

## Getting it running

Node ≥ 22.13, pnpm 11, Docker (for MySQL), ffmpeg.

```bash
cp .env.example .env     # fill DEV_AUTH_SECRET and STORAGE_SIGNING_SECRET
pnpm bootstrap           # install, audio fixtures, MySQL, migrate, seed
pnpm dev                 # api :4000, worker, web :5173
```

Sign in with a seeded demo account (`README.md` lists them). Demo mode uses
synthesised audio and simulated payments and says so in the interface.

## Before you open a change

```bash
pnpm build       # packages first — tests import @yuha/* by name, so they resolve to dist/
pnpm test        # vitest, against a real MySQL on :53307
pnpm typecheck
pnpm check:i18n
pnpm check:contrast
pnpm check:orphans
pnpm check:stewardship
```

`pnpm check:stripe-prices` additionally compares the catalogue in the code
against the live Stripe account and the `product_catalog` rows Checkout
actually reads; it needs credentials, so it is not part of the default run.

Tests run against a real MySQL instance on purpose, never an in-memory
stand-in: the ledger's transactions, unique constraints and contention are only
meaningfully tested by the engine that enforces them.

## How changes are expected to be made

- **Behaviour-bearing code is written test-first.** Red, green, refactor, one
  vertical slice at a time.
- **Verify the claim, not the render.** A passing typecheck and a screenshot say
  the page drew; they do not say the promise on it is true. If the UI says
  "saved", reload and look. If it says "no credit spent", read the ledger.
  `CLAUDE.md` has the long version, written out of the specific bugs that
  taught it — it is the most useful file in the repository for a newcomer.
- **Never add a check, comment, test or document that asserts something it
  cannot back.** This is this codebase's signature defect and most of the
  worst bugs in its history are instances of it: a price check that compared
  the variable instead of the column, a comment claiming an OAuth `state` bound
  something it did not, a "unique index on email" that was never on `email`. A
  green check on the wrong object is worse than no check, because it ends the
  search.
- **Scripted invariants over conventions.** If a rule matters, write the script
  that fails when it is broken — see `scripts/` for the existing ones.

## Things that look untidy and must stay

- `PROJECT_TASK.md` and `spec/` are written records of the original brief, under
  earlier product names. They are history, not debt — and they are a third
  party's documents, carved out of the Apache-2.0 grant in `NOTICE`
  (`PROJECT_TASK.md` is a byte-identical copy of
  `spec/TokenStars_Music_Codex_Task.md`; both paths are listed there, and a new
  file under `spec/` fails `pnpm check:stewardship` until it is). Do not
  relicense, rewrite or "modernise" them.
- `packages/db/src/migrations/0002_sonare_songs.sql` is applied and
  checksum-tracked. Its name and bytes are frozen; a new migration is how you
  change the schema.
- Infrastructure identifiers (the Helm chart, the Terraform resources, the dev
  database in `docker-compose.yml`) read `loopscene`. Renaming them forces
  resource recreation, so it is a separate, deliberate decision.
- The site footer has exactly two links. That is a decision, not an oversight;
  the reasoning is in the comment above it.

## Secrets

`.env` is not in git and must stay out of it. No key, token, webhook secret or
RPC URL belongs in source, in a container image, in the frontend bundle or in a
log line — RPC endpoints carry API keys and are secrets like any other. When
configuration is missing, code in this repository reports that it is missing;
it does not guess, synthesise or fall back to a placeholder that could be
mistaken for the real thing.

Nothing in this repository initiates a real-funds transaction on its own, and
nothing in it should ever ask a human for a seed phrase.

## Licence of your contribution

Contributions are under Apache-2.0, on the same terms as the project
(Apache-2.0, section 5), unless and until the steward adopts a CLA or a DCO —
see `GOVERNANCE.md`. There is no sign-off requirement today; do not invent one
in a pull-request template.
