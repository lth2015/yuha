# Open items

What is unfinished, what is blocked, and on whom. `PROJECT_TASK.md` §13.

Every claim below was checked against the code on **2026-09-28**, because six
of them had come to say the opposite of what the repository does. Anything that
cannot be checked from inside this repository — anything needing AWS
credentials, or a payment completed by hand — says so, rather than carrying an
older answer forward as if it still held.

Two kinds of entry:

- **Blocked** — the code exists and the boundary is defined; an external
  prerequisite is missing.
- **Incomplete** — engineering work still to do inside this repository.

---

## 1. Blocked on a signed music-provider agreement

The single largest dependency. Nothing about real music generation has been
verified, and the platform is built so that this cannot be accidentally
forgotten: `MUSIC_COMMERCIAL_DELIVERY=true` is **rejected at start-up** while
the demo adapter is in use.

| Item | State | Owner | Unblocks |
| --- | --- | --- | --- |
| Enterprise API agreement | Not obtained | Business + legal | AI-01, AI-04, AI-08, PAY-03 |
| Whether we may operate a paid consumer service on the API | Unknown | Legal | Everything commercial |
| Delivering MP3/WAV to end users; storing and re-downloading | Unknown | Legal | UI-06, UI-07, SEC-09 |
| Per-download fees or revenue share | Unknown | Business | Unit economics |
| Downstream user rights: personal SNS video, monetisation, global visibility | Unknown | Legal | UI-09, the licence record contents |
| Whether rights **survive** cancellation | Unknown | Legal | PAY-10, our terms §7 |
| Real pricing: per call, per download, minimum commitment, failure billing | Unknown | Business | AI-06, all cost reporting |
| Model version pinning, concurrency, idempotency, cancel, webhook support | Unknown | Engineering + supplier | AI-04, AI-05, the http adapter config |
| Data processing region and sub-processors | Unknown | Legal | SEC-12, the privacy page |
| Benchmarking / evaluation permission | Not obtained | Business | Any quality claim at all |

Two contract findings already on record and unresolved:

- **SOUNDRAW** — the public API Pro agreement (`spec/API Pro Plan …md`) §3.8 sets
  an Extended Licence with **70% / 50% revenue share** on downloads, and §3.12
  restricts resale. §3.17 deletes generated songs after **72 hours**, so we must
  copy to our own storage inside that window (the current pipeline does store
  the master immediately, which is compatible). How §3.8 interacts with the
  US$300 / 1,000-song base fee needs written clarification — a per-call price
  cannot be assumed to cover it.
- **ElevenLabs** — self-serve API access is explicitly **not** a resale right;
  enterprise authorisation plus possible co-branding would be required.

Until one of these (or another provider) is signed, the correct engineering
state is exactly what ships today: demo audio, commercial delivery off, and
licence records that say so.

---

## 2. Blocked on credentials or accounts

| Item | Missing | Consequence |
| --- | --- | --- |
| Cognito | User pool, app client, SES sender + verified domain | Real token verification and the email-OTP UI unverified. |
| AWS | An authorised account | Terraform `validate`s and Helm renders. Whether anything was ever **applied** is unknown from here: `terraform state list` has not been run, and this repository holds no state file. Until it is, treat deployment, S3, SQS, monitoring, rollback and recovery as unexercised. |

### No longer blocked, as of 2026-09-27

Both were rows in the table above. They are kept on record rather than deleted,
because "obtained" and "verified" are different claims and the gap between them
is where the next piece of work is.

- **TokenStars.** Base URL, key, model id, chat path and request-id header are
  configured, and the adapter was called against the live service with the
  owner's key — four calls, `54d5b42`. AI-01 is verified. Two assumptions moved
  under that call: `response_format: { type: 'json_object' }` is accepted, and
  truncation arrives as `finish_reason: 'length'`. Two things the documentation
  does not mention were read off the response headers: the gateway fronts Azure
  OpenAI, so a content-policy block arrives as `finish_reason:
  'content_filter'` and not in `message.refusal` — the refusal branch could
  never have fired, and every policy block would have been billed as a
  technical failure — and an `x-request-id` header is returned, so failures are
  now quotable to support. **What this does not include:** the 12 tests in
  `tests/tokenstars.test.ts` run against a stubbed transport. They pin the
  contract read from the vendor's documentation; they are not live coverage, and
  nothing re-checks the live API on a schedule.
- **Stripe.** Sandbox keys, `whsec_`, an API-version pin and four Price ids are
  configured, the catalogue exists in the sandbox with the ids in
  `product_catalog.stripe_price_id`, and the **one-time** path has been walked
  end to end against real Stripe (`26e7799`), with every assertion read out of
  the database: a declined card leaves the order `pending` and grants nothing; a
  refund revokes the unused units and sets the order `refunded`, with
  `refund.created` and `charge.refunded` producing one revoke between them;
  signature rejection was exercised over tampered bodies, garbage, an absent
  header, the wrong secret and a stale timestamp; a replayed real event returns
  `duplicate: true` with the ledger unmoved. PAY-03 is verified. **What this
  does not include:** nothing of PAY-03 or PAY-12 remains unexercised against
  live Stripe. Success, decline, 3DS-abandoned and the subscription half have
  all now been walked (`a0d355d`), and the subscription walk found that
  subscribers paid and received nothing — the Invoice and Subscription field
  layout had moved and the handler discarded every subscription invoice on its
  first line. Two failure cases are still open and are listed in
  `docs/ACCEPTANCE_PAYMENTS.md` Part B: B5 (listener stopped, paid, restarted,
  resent) and B7 (the same charge refunded twice).

---

## 3. Incomplete engineering work

| Item | Why it matters | Effort |
| --- | --- | --- |
| **Unintended-vocal detection** (AI-07) | Vocals are a product feature; what is unverified is the *instrumental* choice being honoured. PROJECT_TASK AI-07 asks for a check and a failure path when instrumental was requested, and the output checks cover decodability, duration, silence and integrity — none of which detects a voice. Needs a classifier plus the human review AI-07 requires. Until then "instrumental" rests on the provider's parameter, not on our verification. (This row previously read "the launch promise is instrumental-only", which contradicts `CLAUDE.md` and §5.) | Medium |
| **CloudWatch metric publication** | `monitoring.tf` alarms on `UpstreamFailureRate`, `DailyBudgetConsumedRatio`, `WebhookBacklog`, `LedgerDiscrepancies`, `UngrantedPaidOrders`, `StaleUnknownJobs`. The worker computes all of these but does **not yet publish** them. They are set `treat_missing_data = "breaching"` so they fail loudly rather than looking healthy. | Small |
| **Contrast on translucent surfaces** (UI-14) | Measured and gated, not outstanding: `scripts/check-contrast.mjs` checks 8 text tokens against `--bg`, `--surface-solid` and `--surface-soft` on every run, and all 8 clear 4.5:1 — the tightest is `--faint` at 4.56 on `--surface-soft`. What the gate cannot see is glass: a translucent surface over a moving light field has no colour in the stylesheet, so `--surface-soft`, the lightest opaque surface, stands in for it. That is a conservative substitution, not a measurement. Text placed on the `docs/UI_DESIGN.md` gradient rather than on a panel still needs measuring against the rendered lightest point. | Small |
| **Screen reader and real-device testing** (UI-13, UI-14) | Verified at three widths in a desktop browser only. VoiceOver, TalkBack and physical mobile playback are untested. | Small |
| **Nobody has heard the audio** | The delivered file is a real 180.000s 192kbps MP3 and Chrome decodes it to `readyState 4`, but playback itself has never been verified: in the browser pane used for acceptance the `AudioContext` advances 0.006s per 2s of wall clock, so nothing sounds there (`26e7799`). This is the only link in the core promise that no check of any kind covers, and it needs a human at a machine with audio output. | Small, and only a human can close it |
| **OpenAI-style OpenAPI document** | `docs/API.md` is complete and accurate but hand-written. §10 accepts "OpenAPI or equivalent"; a generated document from the zod schemas would stay in sync automatically. | Medium |
| **Account deletion execution** (SEC-11) | The request is recorded with a correct retention statement, but no job actually deletes the account and its audio after identity confirmation. | Medium |
| **Track retention sweep** | Soft-deleted tracks keep their S3 objects; nothing removes them on a schedule. | Small |
| **Analytics `preview_10s` event** | The player detects 10 seconds of real listening and the activation metric queries it, but the client does not yet POST it. Day-1 activation will therefore report as not computable. | Small |
| **Subscription renewal and dunning** | The first period is now proven end to end against Stripe (`a0d355d`): purchase, grant, the duplicate-subscription guard firing for the first time outside a unit test, and cancellation agreeing with Stripe on both the flag and the period end. What has still never happened is a **second** period — a renewal invoice, and `invoice.payment_failed` on a card that stops working. Both are a month away in real time; forcing them needs a test clock. | Small, with a test clock |
| **Load testing** | §12.3 targets (P95 <1s create, <120s generation, ≥95% success) cannot be meaningfully measured against a synthesised fixture that returns instantly. | Blocked on a real provider |

---

## 4. Decisions that need a human

| Question | Why it is not an engineering call |
| --- | --- |
| Refund policy | The proposed "unused, within 7 days" rule is a **draft**. It must be reconciled with 資金決済法, 特商法 and consumer law before it is presented as binding. The code applies whatever is configured; it does not decide. |
| Whether prepaid credits are 前払式支払手段 | Depends on the actual function of the credits, not on what they are called or on a 90-day expiry. Needs a lawyer's determination; the answer may change the product. |
| Expired-credit compensation policy | `EXPIRED_BATCH_COMPENSATION_DAYS` defaults to 30. §6.2 requires this to be decided **before** charging. |
| Duration tolerance and loudness target | Currently ±750ms and −14 LUFS. Reasonable defaults, but they should be confirmed against the real provider's output characteristics. |
| Which failures the supplier bills for | Configured conservatively as "failures are billable" (`MUSIC_BILL_FAILED_REQUESTS=true`) because assuming the opposite would understate cost. The contract decides. |
| Legal entity, terms, privacy policy | All placeholder. Production refuses to start without real values, but refusing to start is not the same as having them. |
| Which plan names users see | The catalogue, pricing page and purchase history say **CREATOR** (¥1,980 / 15 songs) and **STUDIO** (¥3,980 / 45 songs); the internal keys and every Stripe id say `pro_monthly` and `premier_monthly` (`apps/api/src/seed.ts`). Both names are live at once. Which side changes is a naming decision, and a receipt that names the wrong plan is the failure mode. |
| The Stripe tax code | `scripts/stripe-sandbox-setup.mjs` sets `txcd_10000000`, Stripe's catch-all for an electronically supplied service, because a product without a tax code is rejected outright. It is overridable via `STRIPE_TAX_CODE`. Whether it is the *correct* code for this service is a tax determination. |
| The remaining 特商法 wording | `apps/web/src/pages/Tokushoho.tsx` renders **要法務確認** against two items that genuinely need counsel: the available payment methods (they depend on what the Stripe account has enabled, so the page cannot state them) and the cancellation and refund wording (the current text is a draft in `docs/`). A third 要法務確認 is not a legal question at all — it is the fallback when the product catalogue fails to load, so a failed fetch reads to the user as "a lawyer has not checked this". That is worth separating. Unrelated, and not a decision: `scripts/check-i18n.mjs` reports 19 baselined hardcoded strings across the app, with this page deliberately exempt as a Japanese statutory disclosure. |
| Who reads the crash reports | Not "where do they go" — `POST /v1/client-errors` exists, takes no session, and writes an `analytics_events` row named `client_error` (`apps/api/src/routes/telemetry.ts`). Nothing in the repository ever reads those rows: no alarm, no dashboard, no metric. A crash reporter nobody watches is the same as no crash reporter, and choosing the destination is an operations decision. |

---

## 5. Explicitly out of scope

Not oversights — §1.2 excludes them, and none is reachable through a hidden
entry point or a provider default:

lyrics quoted from existing songs · voice imitation · cover versions ·
reference-audio or humming upload · music distribution (Spotify etc.) ·
royalty splitting · Content ID registration · a marketplace ·
public community, follows, rankings or remixing ·
annual and unlimited plans · auto top-up · transferable or withdrawable credit
balances · native iOS/Android apps · video upload or cloud video composition ·
self-trained models and GPU clusters.

**Vocals and original lyrics are in scope**, and this list used to say
otherwise. `CLAUDE.md` promises full songs with vocals, `VocalMode` is
`instrumental | with_vocals` (`packages/contracts/src/enums.ts:93`) and custom
mode accepts a `lyrics` field. Reading §5 as written would have led someone to
delete a shipped feature.

`vocalMode` is set server-side from the request's `instrumental` flag
(`apps/api/src/services/generation.ts:206`), never from whatever the text model
returns. The input screen rejects voice imitation, artist and title references,
and asking for someone else's lyrics verbatim
(`packages/providers/src/text/safety.ts`) — it does not reject a request for
original lyrics, though one over-broad pattern did until `26e7799`, refusing
「オリジナルの歌詞」 among others.

---

## 6. Assumptions that are not facts

Carried through from the unit-economics workbook and clearly marked as estimates
in code (`is_estimate = true` on every modelled cost event):

| Assumption | Value | Reality |
| --- | --- | --- |
| Music cost per request | 45 JPY | Derived from US$0.3/track at a **budget** rate of 150 JPY/USD. Not a quote, not a current exchange rate. |
| Technical success rate | 90% | A planning figure. The real rate is unmeasured. |
| Failure billing | 100% billable | Conservative default, not a contract term. |
| GPT cost per request | 0.5 JPY | TokenStars internal assumption, not OpenAI pricing. |
| Revenue share | 0% | The **target** contract condition. SOUNDRAW's public agreement says 70%/50% for downloads. |
| Monthly minimum commitment | 45,000 JPY | A budget placeholder. |
| Stripe fees | 3.6% + 0.7% | Public JP rates; the actual merchant agreement governs. |

The reporting layer keeps modelled and invoiced cost in **separate fields** and
never sums them, so a simulation cannot be read as a supplier bill.
