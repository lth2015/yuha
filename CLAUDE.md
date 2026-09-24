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

- **No public feed, no likes.** The Explore surface and the whole like system
  are gone — routes, schema, tests. Songs are private, and "public" means
  anyone holding the link can open it. Do not reintroduce a browsable feed or
  engagement counters without asking.
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
