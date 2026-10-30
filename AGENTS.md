# AGENTS.md

This repository is worked on by two agents: Claude (Claude Code) and Codex.
Read these before doing anything:

1. **[docs/agents/CODEX_COLLABORATION.md](docs/agents/CODEX_COLLABORATION.md)** —
   who does what, where findings go (public PR comments vs. local-only), the
   report format, and the logic rules ("invariants") both agents check.
2. **[CLAUDE.md](CLAUDE.md)** — project rules that bind every agent, not only
   Claude: the product name, "QA" is production, the operator's identity goes
   in no file, the public-repository rule, and how to verify a claim rather
   than a render.

The repository is **public**. Never put real users, orders, wallets, console
screenshots or unfixed vulnerability details in a commit, PR or comment.

Commands: `pnpm test`, `pnpm typecheck`, `pnpm check:stewardship`,
`pnpm check:ui`, and `pnpm check:invariants` once it exists. Node >= 22.
