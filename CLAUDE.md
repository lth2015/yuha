# YUHA

An AI song studio: describe a feeling, get a finished song — instrumental or
sung, 30s to 4 minutes. pnpm monorepo: `apps/{api,web,worker}`,
`packages/{contracts,db,providers}`.

**The product is YUHA.** Two earlier names survive only where renaming is
unsafe: `PROJECT_TASK.md` and `spec/` are written records of the original
brief, and `0002_sonare_songs.sql` is an applied, checksum-tracked migration
whose name and bytes are frozen. Infrastructure identifiers (Helm chart,
Terraform resources, the dev database in `docker-compose.yml`) still read
`loopscene`; renaming those forces resource recreation, so it is a separate,
deliberate decision. Do not "tidy" either group.

## Agent skills

Development on this repo runs through **Matt Pocock's engineering skills**
(plugin `mattpocock-skills@mattpocock`, declared in `.claude/settings.json`).
Use them instead of ad-hoc improvisation:

| Situation | Skill |
| --- | --- |
| Unsure which flow fits | `/ask-matt` |
| Turning a conversation into a spec | `/to-spec` |
| Breaking a plan into tracer-bullet tickets | `/to-tickets` |
| Building the work a spec or ticket describes | `/implement` |
| Writing or changing behaviour-bearing code | `tdd` (red → green → refactor) |
| A hard bug or perf regression | `diagnosing-bugs` |
| Designing a module or its seams | `codebase-design` |
| Naming things / sharpening the domain | `domain-modeling` |
| Before committing a change | `code-review` |
| A merge or rebase conflict | `resolving-merge-conflicts` |
| Planning work larger than one session | `/wayfinder` |

Rules of engagement:

- Non-trivial features start at `/to-spec` or `/to-tickets`, not at the editor.
- Behaviour-bearing code is written under `tdd`. Test one vertical slice at a
  time; `pnpm test` (vitest) is the loop.
- Finish with `code-review` before committing.
- Never `git merge --abort` / `rebase --abort`; use `resolving-merge-conflicts`.

## Scope decisions

- **No public feed, no likes, no visible counters.** There is no browsable
  feed and no like system: no list endpoint, no Explore page, and migration
  0005 dropped `song_likes` and `tracks.like_count`. Songs are private, and
  "public" means anyone holding the link can open it.

  This bullet used to claim the Explore *routes, schema and tests* were gone
  too. They were not — `routes/explore.ts`, `tracks.play_count` and
  `tests/explore.test.ts` all still existed, and the song page rendered a play
  count next to the creator's name. A scope decision that the code contradicts
  is worse than no decision, so this now describes what is actually true.

  Plays **are** still counted: `POST /v1/explore/:id/plays` increments
  `tracks.play_count`, because operations needs to know what gets listened to.
  They are never shown to anyone — `playCount` is deliberately absent from the
  track view a client receives, so it cannot be rendered back onto a page by a
  later change. Showing the number turns a private song into a performance,
  and a song with two plays into a failure.

  Do not reintroduce a browsable feed, a like system, or any user-visible
  engagement counter without asking.
- **No creator revenue sharing.** The platform sells its own service; the
  earnings ledger and per-sale share rate are removed. What a licence records
  is who authored a song, who holds usage rights, and what was paid.
- **Authorship records are load-bearing.** `track_licenses` is kept precisely
  because it is the authorship/rights proof intended to move on-chain later.
  Treat it as a system of record, not as leftover monetisation plumbing.
- **Full songs, with vocals.** The simple path on the home page makes one
  decision (vocals or instrumental) and commits to 2:00; everything else —
  length, style tags, your own lyrics, visibility — lives in `/create`.

Per-repo skill configuration (issue tracker, triage labels, domain docs) is not
scaffolded yet — run `/setup-matt-pocock-skills` once to generate
`docs/agents/*.md`.

## Verifying

Verify the **claim**, not the render. A screenshot and a passing typecheck say
the page drew; they do not say the thing it promises is true.

This is not abstract. The composer told users "what you wrote is saved" for
three commits while a race between the load and save effects wiped the draft
on every mount. The string rendered correctly in all three languages, the
`aria-label` was right, and every check run against it passed — because every
check was about the rendering.

- **A promise in the UI is a test.** "Saved" → reload and look. "No credit
  spent" → read the ledger. "Cancel anytime" → cancel.
- **Deleting a file: list its exports and grep each one first.** `wakeBeat`,
  the only thing that resumed the AudioContext, was lost by removing the
  component that happened to call it — a component correctly identified as
  decorative. `pnpm check:orphans` now catches that shape.
- **Run the command that establishes a fact before stating the fact.**
- **Third-party API semantics: check them or mark them unverified.** Passing
  `payment_method_types` to Stripe silently opts out of the account's other
  payment methods; the comment above that call confidently asserted the
  opposite.
- **A driver's "did that work" is not the database's.** mysql2 connects with
  CLIENT_FOUND_ROWS, so `affectedRows` counts rows MATCHED, not changed: an
  `INSERT ... ON DUPLICATE KEY UPDATE id = id` reports 1 when it inserted
  nothing, and an `UPDATE` that changes no value reports 1 too. `INSERT IGNORE`
  does report 0 for a skipped row. `grantLicense` returned `created: true` for
  every duplicate for as long as it existed, unnoticed because the caller
  discarded it — and the fix that started using it would have detected nothing
  while looking tested. Read the row back when the answer decides money.
- **An unrouted path does not 404 — it answers the SPA, with 200.** In front of
  the api sits `location / { try_files $uri /index.html; }`, so a POST to a
  path the proxy does not forward comes back 200 with the page shell. Stripe
  reads 200 as delivered and never retries, so a webhook on a path nobody
  routed is a customer charged, an event acknowledged, nothing granted, and no
  error in any log. `/health` has the same shape and is already noted in
  `deploy/dgx/README.md`. Check a new public path with a request only the API
  can answer correctly — an unsigned webhook POST must come back 400 — never
  with one that 200 proves nothing about.
- **Prefer a scripted invariant to an eye.** The ones in this repo — brace
  balance after CSS edits, SQL placeholder counts, contrast maths, dictionary
  key parity, orphaned exports — have each caught real defects. Eyeballing
  caught none of them.
- **Before declaring yourself blocked, look.** "The tests cannot run here" was
  repeated for fourteen commits on the strength of `node -v` printing v20 and
  Docker not being up. nvm had Node 24 installed the whole time and Docker
  Desktop was sitting in /Applications; the suite runs in twenty seconds.
  That block cost this branch its only real validation — including whether
  two irreversible migrations applied — and it was never real. Reading one
  symptom and declaring the environment insufficient is the same move as
  reading a screenshot and declaring the feature working.

### Two sessions, one test database

Worktrees are cheap and the test database is not: every session on this machine
shares `loopscene_test` on 53307, and `resetData()` truncates between tests. Two
suites running at once interleave truncations and produce failures that look
like deep breakage — foreign keys to `users` failing, "job vanished", "Table
definition has changed", deadlocks — in files the running change never touched.

29 such failures arrived once while a spawned background task was running its
own suite in a sibling worktree. Nothing was wrong. The tell is the *shape*: a
change to a string table cannot deadlock InnoDB, and a failure list that spans
files with no relation to the diff is about the environment, not the diff.

Before believing a broad failure, run one of the failing files alone. If it
passes, nothing is wrong with the change. `ps aux | grep [v]itest` says whether
another suite is running and `git worktree list` says whether there is a
sibling to blame. Do not start fixing.

Then do not wait, either — a session doing TDD runs the suite every few
minutes, and waiting for a gap costs more than the collision. `TEST_DATABASE_URL`
overrides the connection, so give each session its own schema on the same
container:

```bash
docker exec loopscene-mysql-test sh -lc 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
  -e "CREATE DATABASE IF NOT EXISTS loopscene_test_b CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
      GRANT ALL ON loopscene_test_b.* TO '"'"'loopscene'"'"'@'"'"'%'"'"'; FLUSH PRIVILEGES;"'
TEST_DATABASE_URL='mysql://loopscene:loopscene_local_test@localhost:53307/loopscene_test_b' pnpm test
```

Migrations run from the harness, so a fresh schema needs nothing else. 386 of
386 passed on `_b` while the sibling was still running on the default schema,
which is both the fix and the proof that the collision was all it ever was.

### Running the suite from outside this machine

An agent session that runs in a cloud container cannot reach this machine's
MySQL and cannot execute the macOS `rollup`/`esbuild` binaries, so it works
from a clone inside the container, carried in as `git bundle create
yuha.bundle --all` plus a `git diff --cached --binary` patch — both written to
the repo root, because that is the only place such a session can copy files
out of, and both gitignored for that reason. `pnpm build` before `pnpm test` —
tests import `@yuha/*` by package name and resolve to `dist/`, not `src/` —
and `mysqld` on 53307 with `docker-compose.yml`'s flags.

**Do not leave the bundle configured as that clone's `origin`.** `git clone`
sets it as a remote, and a bundle cannot be pushed to, so the clone reads as
permanently ahead of its remote. The Stop hook that checks for unpushed work
then fires every single turn — about a throwaway clone, demanding a push that
cannot succeed, while the repository it is really asking about sits on this
machine, clean and outside the container entirely. Fetch by path instead:

```bash
git remote remove origin
git fetch /path/to/yuha.bundle 'refs/heads/*:refs/remotes/bundle/*'
```

This is the same failure as the bullet above, inverted: there the environment
was declared insufficient when it was not, here the environment reports a
problem that is not in this repository. Both are a check believed over the
thing it claims to describe.


## Commands

```bash
pnpm dev             # api + worker + web
pnpm test            # vitest (needs MySQL: pnpm db:up)
pnpm typecheck
pnpm check:orphans   # exports nothing imports, baselined
pnpm build
```

`pnpm` needs Node >= 22; the repo has no linter.

## Docs

Architecture, API, configuration and operations live in `docs/`.
Start at [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
