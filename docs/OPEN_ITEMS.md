# Open items

What is unfinished, what is blocked, and on whom. `PROJECT_TASK.md` §13.

Every claim below was checked against the code on **2026-10-02**. Anything that
cannot be checked from inside this repository says so, rather than carrying an
older answer forward as if it still held — and the list of what *cannot* be
checked here got shorter on 2026-10-02: the test suite now runs (see §7), so
rows that rested on reading can rest on a result instead.

The decay rate is the point of this note. First pass 2026-09-28; a day later
three rows were already stale, one of them stale in the commit that wrote it;
two days on, six more. This pass found **four**: the track-retention sweep
(built the night before this one), the contrast row's account of what the gate
can and cannot see, the hardcoded-string count quoted in two places as 19 and
35, and the §1 premise about load testing. Re-check it whenever behaviour
moves, not on a schedule, and count the rows rather than trusting the previous
count.

Two kinds of entry:

- **Blocked** — the code exists and the boundary is defined; an external
  prerequisite is missing.
- **Incomplete** — engineering work still to do inside this repository.

---

## 1. The music model: no longer a signed agreement, now a self-hosted one

**This section's premise changed on 2026-10-01 and the rows below are kept
rather than deleted, because what they asked is still worth answering — the
answers now come from a different place.**

The product no longer rents a music model. ACE-Step runs on the company's own
DGX Spark (`deploy/dgx/`), `MUSIC_ADAPTER=http` points at it, and the audio
seven or eight people have been listening to this week came out of it. The row
that said "the correct engineering state is demo audio" described a build that
no longer exists.

That removes the commercial questions a vendor contract would have decided —
per-call pricing, revenue share, benchmarking permission, whether we may
operate a paid consumer service on somebody's API. It does not remove the
rights questions; it moves them onto us, and adds one that is now the single
largest unknown:

**Nobody has read ACE-Step's model card.** Apache 2.0 covers the weights. What
the model was trained on, and what claim anyone can make over its output, is a
separate question that the licence does not answer — and the answer decides
whether YUHA can keep telling users 「你生成的歌曲归你」. Suno and Udio settled
with the major labels in late 2025 and the industry moved to licensed training
data; a self-hosted model does not exempt anyone from that. Owner: legal, with
the model card as the document to read.

The start-up guard still holds and is still worth having:
`MUSIC_COMMERCIAL_DELIVERY=true` is **rejected while the demo adapter is in
use** (`config.ts:409`). It is not a guard against shipping on an unexamined
licence, which is a different thing and currently has none.

| Item | State | Owner | Unblocks |
| --- | --- | --- | --- |
| **ACE-Step's training data and output-rights claim** | **Unread.** Apache 2.0 is the weights' licence and answers neither | Legal | UI-09, the licence record, 「你生成的歌曲归你」 |
| Delivering MP3/WAV to end users; storing and re-downloading | Ours to decide now that we host it; still unwritten | Legal | UI-06, UI-07, SEC-09 |
| Downstream user rights: personal SNS video, monetisation, global visibility | Ours to decide; follows the row above | Legal | UI-09, the licence record contents |
| Whether rights **survive** cancellation | Ours to decide | Legal | PAY-10, our terms §7 |
| Data processing region and sub-processors | **Answered by self-hosting**: generation happens on a machine in the office, and the deployed `.env` already sets `MUSIC_DATA_REGION=self-hosted-lan-jp` — `unconfirmed` is only the schema's default. What is left is the privacy page saying it in words a reader understands | Engineering | SEC-12, the privacy page |
| Unit economics | No longer a vendor's price list. Electricity and one GPU, against ¥196 a song on the DROP pack — but the per-song cost on this hardware has not been measured | Engineering | AI-06, all cost reporting |
| Enterprise API agreement, per-call pricing, revenue share, benchmarking permission | **Moot while self-hosted.** Kept as the shape of what a vendor deal would have to settle, if one is ever signed | — | — |
| Model version pinning, concurrency, idempotency, cancel | Ours: `ENGINE`, `V15_MODEL`, `MAX_QUEUE` and `VOCAL_TAKES` in `deploy/dgx/music`. Pinning is a deploy discipline nobody has written down | Engineering | AI-04, AI-05 |

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

What ships today: real audio from a model we host, commercial delivery still
off, and licence records that say what provider and contract version produced
each song. Turning `MUSIC_COMMERCIAL_DELIVERY` on is a decision that needs the
model card read first, not a configuration change.

---

## 2. Blocked on credentials or accounts

| Item | Missing | Consequence |
| --- | --- | --- |
| Cognito | User pool, app client, SES sender + verified domain | Real token verification and the email-OTP UI unverified. |
| AWS | An authorised account. **Owner: SRE**, applying with their own tooling — the environment has specifics this repository does not model. | Terraform `validate`s and Helm renders. Whether anything was ever **applied** is unknown from here: `terraform state list` has not been run, and this repository holds no state file. Until it is, treat deployment, S3, SQS, monitoring, rollback and recovery as unexercised. |

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
  first line. All seven failure cases in `docs/ACCEPTANCE_PAYMENTS.md` Part B
  have now been run too, and the last two each found a defect rather than
  confirming one. B7: a partial refund revoked the *entire* unused batch, so
  returning 30% of the money took 100% of the songs. B5 found a hole that no test and no alarm could see — a
  payment the provider settled and never told us about left the order `pending`
  with the money gone, while `UngrantedPaidOrders` correctly read zero because
  it counts *paid* orders. `reconcilePendingCheckouts` closes it.

---

## 3. Incomplete engineering work

| Item | Why it matters | Effort |
| --- | --- | --- |
| **Unintended-vocal detection** (AI-07) | Vocals are a product feature; what is unverified is the *instrumental* choice being honoured. PROJECT_TASK AI-07 asks for a check and a failure path when instrumental was requested, and the output checks cover decodability, duration, silence and integrity — none of which detects a voice. Needs a classifier plus the human review AI-07 requires. Until then "instrumental" rests on the provider's parameter, not on our verification. (This row previously read "the launch promise is instrumental-only", which contradicts `CLAUDE.md` and §5.) | Medium |
| **CloudWatch metric publication** | `monitoring.tf` alarms on `UpstreamFailureRate`, `DailyBudgetConsumedRatio`, `WebhookBacklog`, `LedgerDiscrepancies`, `UngrantedPaidOrders`, `StaleUnknownJobs`. The worker computes all of these but does **not yet publish** them. They are set `treat_missing_data = "breaching"` so they fail loudly rather than looking healthy. | Small |
| **An alarm on settlement-by-sweep** | Two sweeps now repair a lost delivery, and both log at `warn` on success, because a repair is the symptom and not the cure: `reconcilePendingCheckouts` settles a checkout nobody told us about, and `reconcileUngrantedSubscriptions` (`fd51f39`) grants a subscription period whose `invoice.paid` never came. Nothing alarms on either, and the existing set cannot: `UngrantedPaidOrders` counts *paid* orders, which the checkout case never reaches on its own, and `WebhookBacklog` counts events received and unprocessed when the whole problem is that none was received. Whoever publishes the metrics above should add one that counts repairs. | Small |
| **`UngrantedPaidOrders` counts subscriptions too** | Fixed in two steps, and the second is the one worth remembering. `a0d355d` marked the opening order fulfilled once the invoice granted, which made the count honest **while the invoice arrives**. When it does not, the order stays paid and ungranted and, until `fd51f39`, nothing could repair it — `recoverUngrantedOrders` skips every product that is not `one_time` — so the count would have risen and never fallen. Why it was wrong at all: subscriptions deliberately do not grant from the checkout event (PAY-06), so anything reading "paid but not granted" as a fault will mis-read them. Any future non-credit product needs the same care in both places: the grant, and the repair. | Done, recorded as a trap |
| **Contrast on translucent surfaces** (UI-14) | Measured and gated, not outstanding: `scripts/check-contrast.mjs` checks **7** text tokens against `--bg`, `--surface-solid` and `--surface-soft` on every run, and all 7 clear 4.5:1 — the tightest is `--muted` at 5.03 on `--surface-soft`. The canvas went back to warm white in `4f62bf1`, so the dark-studio numbers this row used to carry (8 tokens, `--faint` at 4.56) describe a palette that no longer exists; `--petal` left the measured set when it stopped being used as body text. Extended on 2026-10-02 to read `color` and `opacity` together, which is where it had been blind: six rules multiplied a passing token by 0.22-0.55, and the lyrics of a song on the song page rendered at **2.25:1** under a green build. It now reports 7 tokens and 4 faded rules, refuses a faded block that does not declare its own colour rather than guessing at the cascade, and takes `--contrast-floor: 3` as an in-CSS declaration for a large-text exception so the exception is parsed rather than trusted. What it still cannot see: glass (a translucent surface over a moving light field has no colour in the stylesheet, so the lightest opaque surface stands in — a conservative substitution, not a measurement), and anything drawn on a canvas. `.cover-art__index` was the latter: 88% white pinned near the corner of a gradient whose light stop `CoverArt` places at a seeded random point, so the same component measured anywhere from 1.3:1 to 8:1 depending on the seed. It sits on a scrim now, which makes its ground a property of the rule instead of a property of the seed. | Small |
| **Screen reader and real-device testing** (UI-13, UI-14) | Verified at three widths in a desktop browser only. VoiceOver, TalkBack and physical mobile playback are untested. | Small |
| ~~**Nobody has heard the audio**~~ | **Closed 2026-10-01.** Seven or eight colleagues have the internal build and have been generating and listening to real songs on it, and so has the owner. This row existed because the acceptance browser's `AudioContext` advanced 0.006s per 2s of wall clock (`26e7799`), so no automated check could ever close it — only a human with speakers, which is what happened. | Done |
| **OpenAI-style OpenAPI document** | `docs/API.md` is complete and accurate but hand-written. §10 accepts "OpenAPI or equivalent"; a generated document from the zod schemas would stay in sync automatically. | Medium |
| **16 hardcoded English strings remain** | `scripts/check-i18n.mjs` only recognised hardcoded text containing CJK, so English written straight into JSX was invisible to it while it reported "no new hardcoded UI strings". Extending it on 2026-09-29 found 43; five were fixed on the spot and 38 baselined, `97025da` translated 21, and SyncedLyrics' one has gone since. The baseline now holds **16** (was 35; `Checkout.tsx`'s 19 are gone — see the row above): Legal 13, App 2 (admin access denied) and common 1 are the English that remains, and the other 19 are the pre-existing Japanese in `Checkout.tsx` — a Chinese reader meets Japanese there, which is the same fault wearing a different language. `Legal.tsx` should not be translated by engineering: the page is marked as a draft pending legal review, and an unreviewed translation of a legal draft reads as an official one. Counted from the baseline file rather than from this row's own history, which has been wrong twice. | Small, except Legal |
| ~~**Account deletion execution**~~ (SEC-11) | **Closed 2026-10-01** (`c7e7c9a`, `a14bd15`). A request is a row that can be worked (`account_deletions`), an admin verifies identity and only then can execute, and the erasure removes the stored objects — which first needed `StorageAdapter.remove`, because nothing in the codebase could delete a stored object at all. Three holds: open rights case, orders and payments (hence anonymise rather than delete the user row), and songs other people have licensed. That last one was a promise the response did not make and now does. **Not yet exercised against S3**: on a versioned bucket a delete leaves a noncurrent version that the lifecycle rule expires after 30 days, which the response states as `audioErasureDays`. | Done, unverified on S3 |
| ~~**Track retention sweep**~~ | **Closed 2026-10-01** (`7ea93f5`). `sweepExpiredTrackAudio` runs in `maintenanceLoop`, object before row, 200 per pass, with the row kept when the object delete fails so a retry can find it again. `TRACK_RETENTION_DAYS` is 90. Two holds: an open rights case, and a song somebody else has licensed. The three cases that exercise it were among the five failures the suite found the first time it ran (§7) — two of them were asserting against a `market_license` version the harness does not seed, and two were using 7-character idempotency keys. | Done |
| ~~**Analytics `preview_10s` event**~~ | **Closed 2026-10-01** (`a473b06`). The player had detected the moment since it was written and exposed `onTenSeconds`; nothing subscribed, so the activation query read an event that was never written. `Layout` subscribes and posts to `POST /v1/previews`. The detection was also wrong: `audio.currentTime >= 10` counted a drag of the scrubber as a listen, and it now accumulates played time. | Done |
| **Subscription renewal and dunning** | The first period is now proven end to end against Stripe (`a0d355d`): purchase, grant, the duplicate-subscription guard firing for the first time outside a unit test, and cancellation agreeing with Stripe on both the flag and the period end. What has still never happened is a **second** period — a renewal invoice, and `invoice.payment_failed` on a card that stops working. Both are a month away in real time; forcing them needs a test clock. | Small, with a test clock |
| **Load testing** | §12.3 targets (P95 <1s create, <120s generation, ≥95% success) could not be measured against a fixture that returns instantly. That changed when ACE-Step went onto the company's DGX Spark (`MUSIC_ADAPTER=http`): generation now takes real time on real hardware, and the box is a desktop machine shared by every tester, so queueing behaviour under even a handful of concurrent requests is both measurable and worth measuring. `deploy/dgx/music/02_acceptance.py` already records `rtf` per run and is the place to start. | No longer blocked |

---

## 3b. Long term: the generation agent workflow

Recorded 2026-09-29 from a product discussion, deliberately **not** started.
The premise is right — if the model is rented, the only defensible layer is what
surrounds it — but the shape proposed needs correcting before anyone builds it.

**What cannot be built the way it sounds.** Staging an agent over timbre, scale,
melody and chords assumes the provider exposes those as controllable inputs.
Text-to-music APIs take a prompt, tags and optionally lyrics. You cannot instruct
one to use a particular mode or cadence and have it comply, so a "chord
optimisation" stage emits text *describing* chords and hopes — prompt decoration
with extra cost and latency, not control.

The harder half is verification. Checking that the output carries the requested
harmony needs chord recognition, key detection and beat tracking: real audio
ML, none of which exists here. **A check stage that cannot measure anything is
the most expensive kind of theatre** — it bills, it delays, and it emits
confident claims about musical quality that nobody verified. That is the exact
failure this repository keeps finding in itself; see the Verifying section of
`CLAUDE.md`.

**What is worth building, roughly in order:**

| Layer | Why it holds |
| --- | --- |
| **Lyrics** | The one place with genuine control *and* a code-checkable result: syllables per line, rhyme scheme, stress against meter, and for Japanese **mora** counts and pitch accent rather than syllables. Most competitors handle Japanese lyrics crudely. This is the strongest candidate for a real moat |
| **Selection over generation** | Generate N candidates and *choose*. Everything decidable here is measurable: duration accuracy, loudness against the −14 LUFS target already configured, silence, clipping, and whether vocals are present when vocals were asked for — which is **AI-07**, still unbuilt, and the honest core of any "check" stage |
| **Brief compilation** | Turning 「雨の午後、備忘録のような曲」 into the tag shape a *specific* provider responds to. Unglamorous, provider-specific, and it accumulates — it is also what survives changing providers |

**The constraint that shapes all of it.** Unit economics assume ~45 JPY per
music request and 0.5 JPY for GPT. CREATOR is ¥1,980 for 15 songs — **¥132 of
revenue per song**. A five-stage workflow sampling several candidates heads
straight for 5× the music call and the margin disappears. Any design here has to
carry its own cost model, and the cheap layers (lyrics, selection) are also the
defensible ones, which is convenient rather than coincidental.

Blocked behind §1 regardless: none of this can be tuned against a synthesised
tone, so it waits on a provider agreement.

---

## 4. Decisions that need a human

**An edit forgets the voice and the energy.** `POST /v1/tracks/:id/edit`
rebuilds a create request from the track row, and that row records neither the
voice the creator chose nor the energy — both live on the source job's
`resolved_params`. So editing a duet re-generates it as whatever the model
picks, silently. The fix is a join back to the job (or two columns on
`tracks`); the decision is whether an edit should inherit every original
choice or only the ones the editor is shown. Energy has behaved this way since
the edit flow existed; the voice joins it today rather than being quietly
dropped without a note.

| Question | Why it is not an engineering call |
| --- | --- |
| Refund policy | The proposed "unused, within 7 days" rule is a **draft**. It must be reconciled with 資金決済法, 特商法 and consumer law before it is presented as binding. The code applies whatever is configured; it does not decide. |
| Whether prepaid credits are 前払式支払手段 | Depends on the actual function of the credits, not on what they are called or on a 90-day expiry. Needs a lawyer's determination; the answer may change the product. |
| Expired-credit compensation policy | `EXPIRED_BATCH_COMPENSATION_DAYS` defaults to 30. §6.2 requires this to be decided **before** charging. |
| Duration tolerance and loudness target | Currently ±750ms and −14 LUFS. Reasonable defaults, but they should be confirmed against the real provider's output characteristics. |
| Which failures the supplier bills for | Configured conservatively as "failures are billable" (`MUSIC_BILL_FAILED_REQUESTS=true`) because assuming the opposite would understate cost. The contract decides. |
| ~~**住所 for the 特商法 disclosure**~~ | **Supplied and confirmed 2026-10-02.** All five operator fields are set in `deploy/envs/*.yaml`, so `legalEntityConfigured` is true and production will start. **Superseded on 2026-10-08 — see §8.** The five fields are no longer in this repository at all; they come from the deployment's secret store. The published form is the registered one, confirmed by the operator: it carries the postal code and omits the prefecture, because the city is a 政令指定都市 and the registered form omits it — the convention of prefixing it was dropped in favour of what is registered. The form is recorded in the secret, not here. |
| **The terms and the privacy policy have still not been read by a lawyer** | And this is the row that nearly disappeared. The draft banner on /legal/terms, /legal/privacy, /legal/company and /legal/tokushoho says "this text has not been reviewed by counsel" — and was gated on `isPlaceholder`, which means something else entirely: that the LEGAL_ENTITY_* fields are unset. So supplying the last operator field would have removed that warning from four pages while the text stayed exactly as unreviewed as it was the minute before. They are separate now: `LEGAL_TEXT_REVIEWED` in `Legal.tsx` is a constant, to be flipped in the same commit that lands reviewed text, and the banner shows while either it is false or the operator block is unconfigured. It is false. |
| Which plan names users see | The catalogue, pricing page and purchase history say **CREATOR** (¥1,980 / 15 songs) and **STUDIO** (¥3,980 / 45 songs); the internal keys and every Stripe id say `pro_monthly` and `premier_monthly` (`apps/api/src/catalogue.ts`). Both names are live at once. Which side changes is a naming decision, and a receipt that names the wrong plan is the failure mode. |
| The Stripe tax code | `scripts/stripe-sandbox-setup.mjs` sets `txcd_10000000`, Stripe's catch-all for an electronically supplied service, because a product without a tax code is rejected outright. It is overridable via `STRIPE_TAX_CODE`. Whether it is the *correct* code for this service is a tax determination. |
| The remaining 特商法 wording | `apps/web/src/pages/Tokushoho.tsx` renders **要法務確認** against two items that genuinely need counsel: the available payment methods (they depend on what the Stripe account has enabled, so the page cannot state them) and the cancellation and refund wording (the current text is a draft in `docs/`). A third 要法務確認 is not a legal question at all — it is the fallback when the product catalogue fails to load, so a failed fetch reads to the user as "a lawyer has not checked this". That is worth separating. Unrelated, and not a decision: `scripts/check-i18n.mjs` reports **35** baselined hardcoded strings across the app (this row said 19 and the row above said 35; the baseline file is the count), with this page deliberately exempt as a Japanese statutory disclosure. |
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
| ACE-Step's section-tag vocabulary | `[intro] [verse] [pre-chorus] [chorus] [bridge] [rap] [interlude] [instrumental] [solo] [outro]` | The intent prompt has always asked for `[verse]/[chorus]/[bridge]`, and the set was widened to the ten above when creators were given buttons for them. **Which of the ten the model actually acts on has never been measured.** `bench_vocals.py` on the DGX box is where that would be answered: one short lyric, each tag in turn, listen for whether the structure changes. Until then a marker is translated into this vocabulary and nothing is claimed about the result. An unrecognised marker is passed through untranslated, which is a third unknown. |

The reporting layer keeps modelled and invoiced cost in **separate fields** and
never sums them, so a simulation cannot be read as a supplier bill.

---

## 7. The 2026-10-02 self-review: what it found and did not fix

An overnight pass over the whole repository along four axes — function,
business model, interaction, visual design — asked to fix what it found. Six
commits did: the visual layer's undefined classes and the contrast gate's
blindness to `opacity`; six ways money and credits came apart; four ways a
paid licence stopped working; a job the provider lost ending an account
permanently; nobody ever being asked whether they are 18; the failures that
never reached the screen; and eight claims the product made about itself that
were not true. Each commit message carries its own reasoning.

**The suite runs now, and that is the single most useful thing in this file.**
MySQL is not reachable from the shell on the machine this work happens on, so
two nights of changes went in on reading alone. A container with root, docker
and apt is reachable: MySQL 8.0 installed there, the repository synced across
as a git bundle plus a patch, and `pnpm build && pnpm test` runs for real.
The first run found **five failing tests in the previous night's work** — a
`toBe(0)` against a column `createPool`'s own `typeCast` returns as a boolean,
two orders inserted at a `market_license` version the harness does not seed,
and two 7-character idempotency keys against a `min(8)` schema. None of them
subtle. That is what "I could not run it" costs, and it is worth setting this
up properly in CI rather than rebuilding it each night.

### Left for a person, with the reasoning

| Item | Why it was not fixed here |
| --- | --- |
| ~~**A refund or chargeback does not reverse a subscription grant**~~ | **Closed 2026-10-03**, on an explicit decision: a refund revokes. Three faults, not the two this row named. `handleRefund` found the order by `stripe_payment_intent_id`, which a `mode: 'subscription'` checkout never has; it then filtered to `source = 'one_time_order'` batches; and — unnamed here — a **renewal has no order at all**, so even with both fixed nothing keyed on an order could reach month two. The key that survives is the invoice: a subscription batch is already `<subscription>:<invoice>`, and migration 0012 gives `payments` the `stripe_invoice_id` hop a `refund.created` needs, since it carries a charge and no invoice. The proportional rule is unchanged and shared, floored in the subscriber's favour. Disputes went further than the decision strictly required, because `charge.dispute.closed` was **not routed at all**: a dispute we lose took the money with no revocation and not even the operator signal, which fires on `created`. Opening still revokes nothing — we may win, and taking credits then punishes someone owed nothing — and losing reverses through the same function a refund uses, because a second copy here would have been the old bug under a new name. `tests/refund-subscription.test.ts`, `tests/dispute-lost.test.ts`. | Done |
| ~~**An annual plan would be mis-served by the inferred period**~~ | **Closed 2026-10-03.** `billing_interval` on `product_catalog`, which is the fix this row already named. Backfilled to `month` for the two existing subscriptions, NULL for one-time, and a CHECK makes a subscription without a cadence impossible rather than merely discouraged — the guess cannot return by somebody forgetting the column, and it proved that immediately by rejecting the test harness's own seed. `inferredPeriodDays` still errs long for both cadences (31 and 366), because a batch a few days past its period is a bounded error in the customer's favour where ending early takes something they paid for. Writing it found a second gap: cadence was in neither `upsertProduct`'s commercial-terms comparison nor its UPDATE clause, so moving a plan from monthly to annual under the same version would have been accepted silently and then ignored — the row keeping its old interval while the seed said otherwise. It is a commercial term now, and a version that tries to change it is refused. `tests/billing-interval.test.ts`. | Done |
| ~~**`maintenanceLoop`'s step isolation has no test**~~ | **Closed 2026-10-03.** No harness was needed after all — the helper was a closure inside the loop, so it is `isolatedStep(log)`, exported, and `tests/maintenance-isolation.test.ts` injects throwing sweeps directly: a poison step does not stop the ones behind it, never throws out of the loop, names itself in the log, and stays quiet on success. Two things turned up while writing it. `(err as Error).message` is `undefined` for anything that is not an Error, and seventeen call sites used it, so a line could name a failed step and say nothing about it — `describeError` in `@yuha/contracts` (there, not the worker, because the webhook service needs it and already sits below the worker). And the per-order `catch` in both reconcilers did `await trackEvent(...)`, a database write, when the likeliest reason the block threw is a sick database: the error path could reintroduce the failure the isolation exists to contain, and silence the sweep for every order behind it. Both now `.catch(() => undefined)`. That last path is reasoned, not covered — making `trackEvent` throw inside a real sweep needs module mocking the suite does not do. | Done; one path reasoned, not covered |
| **The operations console renders two endpoints out of eleven** | `Admin.tsx` fetches `/v1/admin/overview` and `/v1/admin/rights-cases`. Registered and invisible: the deletion queue (`GET /v1/admin/deletions`, plus verify and execute), `/v1/admin/jobs`, `/v1/admin/jobs/:id/costs`, `/v1/admin/settings`, `/v1/admin/users/:id/compensate`, `/v1/admin/reconciliation`, `/v1/admin/audit-logs`. The deletion queue is the one that matters: `POST /v1/me/deletion-request` tells the user "deletion runs after identity verification", that verification is a manual admin action, and the queue it lands in is shown to nobody. |
| **Two admin figures cannot be anything but zero** | `track_adopted` has exactly one producer, `POST /v1/tracks/:id/adopted`, and no caller in the web app — so "cost per adopted result" divides by a number that is always 0. And the "Dead-lettered" counter reads `local_queue_messages.dead_lettered`, a table only `LocalQueueAdapter` writes; production runs SQS, whose `deadLetter` deliberately leaves redrive to the queue's own policy. The one health number an operator would check during a backlog is 0 by construction. |
| **`tracks.play_count` has no reader** | `CLAUDE.md` keeps the counter on the grounds that "operations needs to know what gets listened to". It is written by the explore endpoint and read by nothing: not `operationsSnapshot`, not `costSummary`, not `funnelSummary`, and deliberately not by either track view. Either surface it or stop claiming a reader. |
| **The rights-complaint process promises things it cannot do** | The API receipt says 「1営業日以内に受領のご連絡をします」and the help page says a case number can be used to check progress. There is no mail capability in this product at all, so nothing can contact a reporter; `GET /v1/rights-cases/:caseNumber` exists and no page calls it, so there is nowhere to enter the number. The case number is real and suspension-on-filing is real — it is the acknowledgement and the progress check that are not. |
| **A song held back by erasure stays on the public showcase** | `executeAccountDeletion` keeps a song somebody else has licensed, by design, and the owner's account is gone. It is still `visibility = 'public'`, so it still appears in `/v1/explore` under a now-anonymised creator name. Unpublishing it would have broken the buyers' downloads until this pass fixed that; it no longer would, so the decision is now actually open. It is still a product decision. |
| ~~**The preview URL expires in five minutes and nothing re-signs it**~~ | **Closed 2026-10-03.** The player asks for a fresh signature when the audio errors, once per attempt, and plays it. On error rather than on a timer: the client is never told the TTL, a timer needs both clocks to agree, and it would re-sign tracks nobody plays — an error is the one moment we know the URL did not work. `createResignGuard` keeps "once" true, because `error` also fires for genuinely broken audio and a self-rearming retry would turn one dead file into a request loop; starting a track again re-arms it, since pressing play an hour later meets an expired signature all over again. Verified against the real condition rather than a mock: the stack was restarted with `DOWNLOAD_URL_TTL_SECONDS=2`, the library left to go stale, and the network log shows the dead signature, the `/v1/tracks/:id` re-sign and a fresh signature seventeen seconds later — with the song audibly playing at 0:13 of 0:29 and no error state. `tests/preview-resign.test.ts`. The dead-file case is covered by the guard's unit tests, not end to end. | Done |
| ~~**Webhook retries have no backoff, and `processing` rows are never reset**~~ | **Closed 2026-10-03.** Migration 0010 adds `attempted_at`, the one fact nothing recorded — `received_at` never moves and `processed_at` is only set at the end. `claimWebhookEvents` now takes a row back when its five-minute lease expires, so a worker that dies mid-handler no longer holds a payment for ever with no alert counting it (the row is not `failed`, so nothing was looking). Failed rows wait `30s × 2^(attempts-1)`, capped at 30 minutes: the same ten attempts that used to be spent in about a second now span roughly two hours, which is a length an incident can actually be. Re-claiming is safe by construction, not by luck — the event id is UNIQUE and grants are keyed on (user, source, source_ref), which is what makes a lease the right answer rather than a risk. The backfill sets `attempted_at` from `received_at`, and a NULL is treated as claimable anyway, so rows already stuck before the migration are freed. `tests/webhook-retry.test.ts`. | Done |
| **No offline story anywhere** | `grep` for `navigator.onLine` across `apps/web/src` returns nothing. The copy for it exists and is good (`err.NETWORK.*` in all three languages); it reaches the screen only where a `catch` happens to surface it, which this pass widened considerably but did not make systematic. One app-level banner would cover most of it. |
| ~~**`Checkout.tsx` is Japanese-only**~~ | **Closed 2026-10-03**, after checking the premise instead of the file's own header comment. 特商法 12条の6 requires six **items of information** on the 最終確認画面 — quantity, price, payment timing and method, delivery timing, any application period, and withdrawal/cancellation — and prescribes no wording and no language; the 消費者庁 standard is 「顧客が容易に確認し及び訂正することができる」, which is comprehension, and the agency publishes [a foreign-language guide to this very Act](https://www.no-trouble.caa.go.jp/foreignlanguage/). For a Chinese reader, Japanese-only text defeats that standard rather than satisfying it. The repo's own exemption is for "a statutory disclosure addressed to consumers under one country's law" — that is `Tokushoho.tsx`, the filed notice, which stays Japanese and stays linked from this screen. A confirmation screen is not that document; it is the UI that has to make six facts legible. All 19 strings plus the demo payment screen now come from the dictionary in zh/ja/en, and the Japanese renders byte-for-byte as before. Verified in all three in the browser, including the one-time variant. | Done |
| ~~**`/projects/:id` is unreachable, and its regenerate button lies**~~ | **Deleted 2026-10-03.** The decision was taken on one fact nobody had written down: the page is a version-comparison view ("each card here is one generation"), the composer never sends `projectId`, so every generation makes a fresh project — the dev database held 15 projects and 14 tracks with a tracks-per-project distribution of exactly `1 → 14`. **No project has ever held more than one track.** The page could only ever compare one thing with nothing, so wiring it up was not a link but a feature: grouping versions, in a composer that no longer uses the scene/project flow this page was written for. Gone with it: the route, the page-title rule and its test case, `SCENE_KEY` / `TRACK_MOOD_KEY` / `TRACK_STATE_TONES`, and 29 dictionary keys across three languages. The `projects` table and its five endpoints stay — every track hangs off one, and the API already accepts `projectId` if grouping is ever specified properly. | Done |
| **`.art-panel` is styled and never rendered** | ~34 lines of stylesheet including a dedicated keyframe and two media-query blocks, plus an entry in `lib/sheen.ts`'s target list, for an element that appears in no component. The `.market-head` / `.chart__*` block is another 32 for a page with no route. The first looks like it was meant to ship — that is a question for whoever wrote it, not a deletion for me to make overnight. |
| **`apps/web/public/brand/yuha-tokens.css` is loaded by nothing** | No `<link>`, no `@import`, no reference. `styles.css` cites it as the source of truth and disagrees with it on every motion duration (100/160/240/480ms there, 120/200/320/560ms in use) and on `--yuha-line`. Either it is the source of truth and should be imported, or it is a historical document and should say so. |
| **Type, spacing and radius have no scale, only tokens that are sometimes used** | Measured: **19** distinct fixed font sizes plus 10 `clamp()` ramps; **25** raw px spacing values alongside the 8 `--s*` tokens, where 6px, 10px and 14px are the real fourth, fifth and sixth steps and have no names; **15** border radii against 3 tokens, including `14px` written raw while `--r-control` *is* 14px; 34 `box-shadow` declarations of which 15 bypass the three-step ramp; and 44 inline `fontSize` values, against the 4 uses of the `.page-title` / `.section-title` / `.credit-figure` classes added to stop exactly that. `check-contrast.mjs` shows the shape a fix takes: a short script that turns a convention into a gate caught a real failure the first time it ran. This is the highest-value piece of design work left, and it is work, not a patch. |
| **Cover art varies between styles and barely within one** | Six well-separated colour families across 25 mapped style tags, with unmapped tags hashed in stably — that half works, and it is the half the component was written for. Two songs sharing a family differ only in where a very broad highlight sits and in a three-digit number: six lo-fi songs are six near-identical orange squares. Letting the seed rotate hue ±12-15° within the family would fix it. A design call. Two mechanical notes while anyone is in there: `familyFor` consumes `rand()` only in the no-tags branch, so the same seed gives different light positions depending on whether tags exist, and mark density keys off the `size` *prop* rather than the rendered width, so a 150px sleeve in the phone masonry still draws 52 notes into half the space — the opposite of what its comment says is intended. |
| **`Score`'s animation loop never parks** | `requestAnimationFrame` is re-armed as the first statement of `draw`, so under reduced motion it still wakes every frame to early-return, and the hero score repaints a 150px canvas at 60fps on the landing page with nothing playing. The second part is deliberate — that idle sweep is the motion the owner singled out as the thing he likes — so this needs care rather than a fix: park the loop when genuinely still and re-arm on a change signal, without touching the sweep. |
| **`verify` auto-creates an account for an unknown subject** | Carried from the previous pass. The dev adapter was fixed; the Google path still upserts, so a deleted user signing in again gets a fresh account rather than a refusal. A real fix needs a record of erased subjects, which is a schema change and a privacy question at once. |

---

## 8. The donation: what the licence settles and what it does not

Added 2026-10-08. The code is donated to the NEXT technical community as
upstream steward, under Apache-2.0 (`LICENSE`, `NOTICE`, `GOVERNANCE.md`,
`CONTRIBUTING.md`). The service at yuha.studio was not donated: the Stripe
account and every consumer obligation stay with the operator. The documents say
that; this section is what is still open, so that a reader of this file does
not conclude nothing is.

| Item | Kind | Status |
| --- | --- | --- |
| ~~**The operator's five fields are in tracked files**~~ | Done 2026-10-08 | They were in `deploy/envs/{production,staging,qa}.yaml` and rendered into a ConfigMap — one person's legal name, home address, telephone number and personal email, in git and printable by `kubectl get cm`. They now come from the runtime Secret (`deploy/cluster/external-secrets.yaml`, `deploy/runbook.md` step 5); the chart renders no `LEGAL_ENTITY_*`, no values file carries a `legal:` block, and they had already been removed from `.env.example`, five documents, `deploy/dgx/app/deploy_yuha.sh`, `tests/lrc.test.ts`, `tests/security.test.ts` and a personal work address in `tests/dev-login-allowlist.test.ts`. `pnpm check:stewardship` fails if a `legal:` block or a ConfigMap key returns, or if any tracked file acquires something shaped like a Japanese address, telephone number or off-domain email that is not on a declared list of invented ones. |
| ~~**The same values are still in git history**~~ | Done 2026-10-08 | `git filter-repo --replace-text --replace-message --mailmap` over the whole history. Replaced, as literals and as every fragment the commit messages had line-wrapped them into: the operator's name, the registered address (down to the prefecture and city, which narrow it on their own), the postal code, the telephone number in each of its spellings, and the personal mailbox; a work address used as a fixture in one test became `colleague@netstars.co.jp`; and the author and committer emails were normalised off an address git had built from the laptop's hostname — a `.local` name, not a mailbox — onto one work address. Authorship was deliberately **kept** — a donation's provenance is who wrote it. Verified afterwards by reading **every one of the 1,689 blobs reachable from every ref**, every commit message, every author and committer field, and all three annotated tags: zero occurrences of any of them. The `HEAD` tree is byte-identical to the pre-rewrite one (`71710f8f`), so the 922 passing tests and five green gates carry over unchanged. Consequence: every commit from 2026-10-01 onward has a new SHA, 107 of 192 in all, so this history and the one in the old repository are different objects — which is why the repository is **moving** rather than being force-pushed. GitHub keeps unreachable objects fetchable by SHA until it is asked to collect them, so a force-push would have left the old commits retrievable by anyone who had noted one; deleting the old repository does not. |
| **The old repository is public, and the values are in it** | **Blocked, on the operator — now** | Checked 2026-10-08 by anonymous `git ls-remote` (11 refs, no credentials) and by an unauthenticated API read: `lth2015/music` is `"visibility": "public"`, created 2026-09-09. Still true on 2026-10-09: the redacted history has moved to `lth2015/yuha`, which changes nothing about the old repository — it is still serving the values until it is made private or deleted. An earlier version of this row called it private and treated that as the containment. It is not private and there is no containment: the operator's legal name, home address, mobile number and personal mailbox have been readable by anyone since they were first committed on 2026-10-02. `forks_count` is 0, so there is no fork to chase, but a public repository is crawled, indexed and archived by third parties, so **deleting it later is not retraction** — it only stops GitHub serving it. The first action is therefore not a deletion and not a push: it is **Settings → Danger Zone → Change visibility → Private**, which takes seconds, destroys nothing, and keeps every Actions secret, Environment and protection rule the SRE has configured. (On a free plan, note that Actions minutes are metered for private repositories and free for public ones.) Only after that does the order below matter. |
| ~~**The new repository has to be created**~~ | Done 2026-10-09 | `lth2015/yuha` is the canonical repository: `master` and `yuha` at the redacted tip, three annotated tags on redacted commits. Verified afterwards against GitHub rather than against the local copy — a `--mirror` clone of the published repository, 196 commits and 1,698 blobs, scanned object by object along with every commit message, author and committer field and all three tag objects: zero occurrences of the name, address, postal code, telephone number, personal mailbox or laptop hostname. The only identity left is the deliberate authorship, `li.dawei <li.dawei@netstars.co.jp>`. It is public, which is fine for personal data and does leave `spec/API Pro Plan - API General Agreement & Licensing terms.md` publicly readable — the unanswered counsel question in this section, and a decision nobody has taken rather than a new exposure, since the old repository published it too. |
| **The old repository still has to go** | Blocked, on the operator | Make `lth2015/music` private or delete it. Deleting is the only one of the two that removes the objects from GitHub, and neither is retraction for something that was public for a month. |
| **Moving the repository costs more than a push — the checklist** | Incomplete | A push carries commits, branches and tags. It carries none of this, and an SRE configuring GitHub Actions is working almost entirely in this column: **Actions secrets and variables** (never exportable — they have to be entered again, by hand, in the new repository), **Environments** and their protection rules and required reviewers, **branch protection / rulesets**, **Actions permissions and allowed-actions settings**, **deploy keys and webhooks**, workflow **run history** and caches, and any issues or pull requests. Checked 2026-10-08: `origin/master` and `origin/yuha` are both still at `6699d92`, so nothing has been committed to the old repository that the rewritten history lacks — the exposure is settings, not commits. On the AWS side one thing breaks on its own: `infra/terraform/github_oidc.tf` builds the deploy role's trust policy from `var.github_repository`, default `"lth2015/music"`, as `repo:<owner/name>:ref:refs/heads/master` and `:ref:refs/tags/v*`. A repository with a new name assumes nothing until that variable changes and Terraform is applied, and the failure reads as an `AssumeRoleWithWebIdentity` denial rather than as a renamed repository. **Renaming the repository is not a shortcut**: it keeps every setting, and it keeps the object store, so the values this section is about stay retrievable. So: tell whoever is configuring Actions first; create the new repository; push; re-enter the secrets and environments there; change the Terraform variable and apply; prove one deploy green from the new repository; *then* delete the old one. **Where that stands on 2026-10-09:** the repository exists and is pushed, and `var.github_repository` still says `"lth2015/music"` — which is now not merely a value that will need changing but a **wrong** one, so the deploy role cannot be assumed from the repository the code actually lives in. Left untouched deliberately: `infra/` is the SRE's. It is one line (`infra/terraform/github_oidc.tf`) plus an apply. |
| **Who holds copyright** | Decision | `LICENSE` and `NOTICE` say `Copyright 2026 YUHA contributors`. If the agreement assigns copyright to a named entity, both change to it. The footer's `© <year> YUHA` (`footer.made`, three languages) is a product string, not a licence header, but it should not disagree. |
| **CLA or DCO** | Decision, the steward's | Apache-2.0 §5 already makes inbound contributions inbound-equals-outbound, so nothing is broken while this is unanswered. `CONTRIBUTING.md` says there is no sign-off requirement today; if one is adopted it goes there and in `GOVERNANCE.md`. |
| **Whether SOUNDRAW's agreement text may be published at all** | Decision, needs counsel | `spec/API Pro Plan - API General Agreement & Licensing terms.md` is a counterparty's contract text, reproduced verbatim. `NOTICE` carves it out of the Apache grant, which fixes the *licensing* claim and says nothing about confidentiality. If it may not be published, the file leaves the repository before the repository is public. |
| **The name and the marks** | Decision | Apache-2.0 §6 grants no trademark rights, so "YUHA", the wordmark and the marks (`apps/web/public/brand/`, `yuha/YUHA_Design_v1/`, and the vector paths inlined in `apps/web/src/components/Brand.tsx`) do not travel with the code unless the agreement says they do. `NOTICE` states the carve-out; it does not decide the question. |
| **NEXT's own legal particulars are nowhere in the repository** | Deliberate | netx.world, read 2026-10-08, publishes no entity name, seat, legal form or registration number. Nothing was invented. If a document needs them, they come from the executed agreement. |
| **`LEGAL_ENTITY_REPRESENTATIVE` and `_PHONE` are optional in config but required by 特商法** | Incomplete | `loadConfig` requires only NAME, ADDRESS and CONTACT in production, and `legalEntityConfigured` is derived from the same three — so a deployment can boot, report `isPlaceholder: false`, and show no draft banner while 運営統括責任者 is blank. `Tokushoho.tsx` now marks both of those rows **要法務確認** when they are missing, which makes the gap visible on the page instead of printing an empty statutory field. Making `loadConfig` refuse without them is the fuller fix and changes what `legalEntityConfigured` means, so it is a separate decision. |
