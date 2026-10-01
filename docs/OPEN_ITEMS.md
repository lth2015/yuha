# Open items

What is unfinished, what is blocked, and on whom. `PROJECT_TASK.md` §13.

Every claim below was checked against the code on **2026-10-01**. Anything that
cannot be checked from inside this repository — anything needing AWS
credentials, or a payment completed by hand — says so, rather than carrying an
older answer forward as if it still held.

The decay rate is the point of this note. First pass 2026-09-28; the re-check a
day later found three rows already stale, one of them stale in the commit that
wrote it. This pass, two days on, found **six more**: the dark-studio contrast
numbers (the canvas went back to warm white), the hardcoded-string count, three
rows that are now done, and — the one that matters — a whole section premised
on renting a music model from a vendor, written while the model was being moved
onto a machine in the office. Re-check it whenever behaviour moves, not on a
schedule, and count the rows rather than trusting the previous count.

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
| **Contrast on translucent surfaces** (UI-14) | Measured and gated, not outstanding: `scripts/check-contrast.mjs` checks **7** text tokens against `--bg`, `--surface-solid` and `--surface-soft` on every run, and all 7 clear 4.5:1 — the tightest is `--muted` at 5.03 on `--surface-soft`. The canvas went back to warm white in `4f62bf1`, so the dark-studio numbers this row used to carry (8 tokens, `--faint` at 4.56) describe a palette that no longer exists; `--petal` left the measured set when it stopped being used as body text. What the gate still cannot see is glass: a translucent surface over a moving light field has no colour in the stylesheet, so the lightest opaque surface stands in for it. That is a conservative substitution, not a measurement. Text placed on the `docs/UI_DESIGN.md` gradient rather than on a panel still needs measuring against the rendered lightest point. | Small |
| **Screen reader and real-device testing** (UI-13, UI-14) | Verified at three widths in a desktop browser only. VoiceOver, TalkBack and physical mobile playback are untested. | Small |
| ~~**Nobody has heard the audio**~~ | **Closed 2026-10-01.** Seven or eight colleagues have the internal build and have been generating and listening to real songs on it, and so has the owner. This row existed because the acceptance browser's `AudioContext` advanced 0.006s per 2s of wall clock (`26e7799`), so no automated check could ever close it — only a human with speakers, which is what happened. | Done |
| **OpenAI-style OpenAPI document** | `docs/API.md` is complete and accurate but hand-written. §10 accepts "OpenAPI or equivalent"; a generated document from the zod schemas would stay in sync automatically. | Medium |
| **16 hardcoded English strings remain** | `scripts/check-i18n.mjs` only recognised hardcoded text containing CJK, so English written straight into JSX was invisible to it while it reported "no new hardcoded UI strings". Extending it on 2026-09-29 found 43; five were fixed on the spot and 38 baselined, `97025da` translated 21, and SyncedLyrics' one has gone since. The baseline now holds **35**: Legal 13, App 2 (admin access denied) and common 1 are the English that remains, and the other 19 are the pre-existing Japanese in `Checkout.tsx` — a Chinese reader meets Japanese there, which is the same fault wearing a different language. `Legal.tsx` should not be translated by engineering: the page is marked as a draft pending legal review, and an unreviewed translation of a legal draft reads as an official one. Counted from the baseline file rather than from this row's own history, which has been wrong twice. | Small, except Legal |
| ~~**Account deletion execution**~~ (SEC-11) | **Closed 2026-10-01** (`c7e7c9a`, `a14bd15`). A request is a row that can be worked (`account_deletions`), an admin verifies identity and only then can execute, and the erasure removes the stored objects — which first needed `StorageAdapter.remove`, because nothing in the codebase could delete a stored object at all. Three holds: open rights case, orders and payments (hence anonymise rather than delete the user row), and songs other people have licensed. That last one was a promise the response did not make and now does. **Not yet exercised against S3**: on a versioned bucket a delete leaves a noncurrent version that the lifecycle rule expires after 30 days, which the response states as `audioErasureDays`. | Done, unverified on S3 |
| **Track retention sweep** | Soft-deleted tracks keep their S3 objects; nothing removes them on a schedule. No longer blocked on a missing primitive — `StorageAdapter.remove` exists as of `c7e7c9a` — so what is left is the sweep itself and the decision about how long a soft-deleted track is recoverable before its audio goes. | Small |
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
