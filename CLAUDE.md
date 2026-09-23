# YUHA

An AI song studio: describe a feeling, get a finished song — instrumental or
sung, 30s to 4 minutes. pnpm monorepo: `apps/{api,web,worker}`,
`packages/{contracts,db,providers}`.

**The product name is unsettled.** The interface says YUHA, `README.md` says
SONARE, the workspace packages are `@loopscene/*` and `PROJECT_TASK.md` says
LOOPSCENE. Treat the interface as current and leave the package names alone;
they are historical. Pick one before launch.

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

- **No public feed.** The Explore/market surface was cut; songs are private,
  and "public" means anyone with the link can open it. Do not reintroduce a
  browsable feed of other people's work without asking.
- **Full songs, with vocals.** The simple path on the home page makes one
  decision (vocals or instrumental) and commits to 2:00; everything else —
  length, style tags, your own lyrics, visibility — lives in `/create`.

Per-repo skill configuration (issue tracker, triage labels, domain docs) is not
scaffolded yet — run `/setup-matt-pocock-skills` once to generate
`docs/agents/*.md`.

## Commands

```bash
pnpm dev         # api + worker + web
pnpm test        # vitest
pnpm typecheck
pnpm lint
pnpm build
```

## Docs

Architecture, API, configuration and operations live in `docs/`.
Start at [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
