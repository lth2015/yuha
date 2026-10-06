# Anti-fraud measures: what the code actually does

Stripe's production application asks which anti-fraud measures are in place and
requires at least one. Six were ticked. This file exists so each tick can be
checked against something, and so a box that is no longer true gets noticed
rather than remembered wrongly.

Written 2026-10-06. If you change one of these, change this file in the same
commit.

| # | Measure | Status | Where |
| --- | --- | --- | --- |
| ① | CAPTCHA on sign-up | **Not implemented** | Sign-in is Google OAuth only in production; there is no password form to defend. Deliberately not ticked |
| ② | Two-factor for staff accounts | **Enforced** | `apps/api/src/plugins/auth.ts` — `requireRole` refuses any staff account without an enabled factor. `ADMIN_MFA_REQUIRED` defaults true and production refuses to start with it off (`config.ts`). Tests: `tests/admin-mfa.test.ts` |
| ③ | Velocity / amount limits per account | **Partial** | Generation and export are capped per hour (`GENERATION_RATE_LIMIT_PER_HOUR`, `EXPORT_RATE_LIMIT_PER_HOUR`) and concurrent jobs per user are capped. There is no cap on purchase value per account per day. See "What is still not true" |
| ④ | Throttling repeated failed attempts | **Enforced** | Five wrong second-factor codes lock the account for fifteen minutes, counted on the account rather than the address, so more addresses do not buy more attempts. `apps/api/src/services/mfa.ts`, migration 0014. Tests: `tests/mfa-account-lock.test.ts` |
| ⑤ | Notifying customers of account activity | **Enforced** | Sign-in from an unfamiliar source, second factor enabled or disabled, and a deletion request each send mail. The source is stored as an HMAC, never an address (migration 0013). `apps/api/src/services/notices.ts` |
| ⑥ | Manual review of high-risk orders | **Partial** | Stablecoin payments that are short, over, late or unattributable go to a queue an operator resolves with a stated reason and an audit row (`/v1/admin/stablecoin-payments`). Card orders have no equivalent review step |
| ⑦ | Address / identity verification | **Not implemented** | Stripe Checkout collects and verifies payment details; nothing additional is done here. Deliberately not ticked |

## What is still not true

Listed because a checklist's value is in what it refuses to claim.

- **No per-account spending cap.** ③ is ticked on the strength of generation and
  export limits, which protect capacity rather than money. A stolen card used
  to buy forty DROP packs in an hour would meet no limit here.
- **Card orders get no manual review.** ⑥ is real for the stablecoin channel
  and absent for the card one, which is the channel carrying every payment
  today.
- **Email delivery is not proven in production.** The adapter is real and
  tested (`tests/email-adapter.test.ts`), but nothing has sent a message
  through SES from a production pod yet, and the API's IRSA role has no
  `ses:SendEmail` statement — that is a Terraform change the SRE still has to
  make. ⑤ is code-complete and deployment-incomplete.
- **Notices are bilingual because `users` records no locale.** Everyone gets
  Japanese and English in one message. Not a fraud question, but it is the kind
  of thing a reader of this table would otherwise assume was handled.

## Why this file is phrased as it is

Three of the seven say "partial" or "not implemented". Ticking a box on an
application is a statement to a payment processor about how an account is run,
and the cost of overstating it is not a rejected form — it is a claim that
cannot be met when it matters. The two unticked rows are unticked on purpose
and should stay that way until something backs them.
