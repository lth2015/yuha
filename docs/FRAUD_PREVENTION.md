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
| ③ | Velocity / amount limits per account | **Enforced** | Purchases: `PURCHASE_CAP_JPY_PER_DAY` (¥50,000) and `PURCHASE_CAP_ORDERS_PER_DAY` (20), rolling 24 hours, in `apps/api/src/services/purchase-cap.ts` — one place that all three purchase paths go through, kept that way by a grep over the source. Capacity: generation and export per hour (`GENERATION_RATE_LIMIT_PER_HOUR`, `EXPORT_RATE_LIMIT_PER_HOUR`) and concurrent jobs per user. Tests: `tests/purchase-cap.test.ts` |
| ④ | Throttling repeated failed attempts | **Enforced** | Five wrong second-factor codes lock the account for fifteen minutes, counted on the account rather than the address, so more addresses do not buy more attempts. `apps/api/src/services/mfa.ts`, migration 0014. Tests: `tests/mfa-account-lock.test.ts` |
| ⑤ | Notifying customers of account activity | **Enforced** | Sign-in from an unfamiliar source, second factor enabled or disabled, and a deletion request each send mail. The source is stored as an HMAC, never an address (migration 0013). `apps/api/src/services/notices.ts` |
| ⑥ | Manual review of high-risk orders | **Enforced** | Both channels. Stablecoin: short, over, late or unattributable payments go to a queue an operator resolves with a stated reason and an audit row (`/v1/admin/stablecoin-payments`). Card: a paid order matching a risk signal has its DELIVERY held until a person releases or refuses it (`/v1/admin/order-reviews`, `apps/api/src/services/order-review.ts`, migration 0017). Signals are our own data only — a brand-new account spending ¥5,000 in its first hour, an account with a previous chargeback, ten orders started in a rolling day — and each is configurable or switchable off. Tests: `tests/card-order-review.test.ts` |
| ⑦ | Address / identity verification | **Not implemented** | Stripe Checkout collects and verifies payment details; nothing additional is done here. Deliberately not ticked |

## What is still not true

Listed because a checklist's value is in what it refuses to claim.

- ~~**No per-account spending cap.**~~ Done. `PURCHASE_CAP_JPY_PER_DAY`
  (¥50,000) and `PURCHASE_CAP_ORDERS_PER_DAY` (20) over a rolling 24 hours,
  both switchable off with 0. Two numbers because the two abuses look
  different: a stolen card that works is value, while card testing is count —
  a hundred declines move no money, so a value cap never sees it. Enforced in
  one place that all three purchase paths go through (card checkout, licence
  checkout, stablecoin quote), with a test that greps the source to keep it
  that way: `insertOrder` may be called from `services/purchase-cap.ts` and
  nowhere else in `apps/api`, so a fourth path cannot quietly skip the limit.
  Issuing credits from the console is deliberately not capped — it is the
  remedy when a real customer has been stopped, and it has an audit row and a
  person behind it.
- ~~**Card orders get no manual review.**~~ Done, and worth saying what it does
  and does not do. What is held is DELIVERY, never the payment: Stripe has
  taken the money already and its own screening has had its say, and the thing
  that cannot be undone is not the charge — a chargeback takes money back,
  nothing takes back a downloaded song. The hold is enforced inside
  `grantEntitlementForOrder`, the one function both payment channels and the
  recovery sweep run, because `listUngrantedPaidOrders` selects exactly "paid
  and not granted" — which is what a held order looks like — so a check
  anywhere else would have been delivered by the sweep on its next pass.
  Refusing an order does **not** refund it: the refund happens in Stripe, by a
  person, and the refund webhook is what records it here. The console says so
  rather than letting a button imply otherwise. The thresholds are set so that
  almost nothing is held, because a hold on a legitimate purchase is a
  customer who paid and received nothing, and at this scale that is the worse
  failure.
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
