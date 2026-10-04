# Launch readiness

What must be true before LOOPSCENE charges anyone. `PROJECT_TASK.md` §13.

---

## Verdict

**Not ready to charge. Not close.**

The software is in good shape: the credit ledger, the generation state machine,
the payment pipeline and the access controls are built and verified against a
real database (456 automated tests as of 2026-10-04, plus a browser walkthrough
and a live security pass over authz, session forgery, SSRF, webhook signatures
and rate limits). That is an engineering result.

It is **not** a commercial one. Charging requires a signed music-provider
agreement, a legal review of consumer terms, a confirmed operating entity, and
real cost figures. None of those exists. §13 is explicit that technical testing
cannot be used to infer that lawful operation or profitability has been
established, and this document does not attempt to.

The system is built so this cannot be forgotten by accident: production mode
**refuses to start** without real legal-entity details, and commercial delivery
**cannot be enabled** while the demo audio adapter is in use.

---

## 1. Music rights — BLOCKED

| Requirement | State |
| --- | --- |
| Signed enterprise/OEM agreement | ✗ Not obtained |
| Right to operate a paid consumer service on the API | ✗ Unconfirmed |
| Right to deliver files to end users and let them re-download | ✗ Unconfirmed |
| Downstream rights: personal SNS video, monetisation, global visibility | ✗ Unconfirmed |
| Survival of rights after cancellation or termination | ✗ Unconfirmed |
| Revenue share / per-download fees settled | ✗ Unconfirmed |
| Indemnity, warranty and claim-handling terms | ✗ Unconfirmed |
| Data processing region and sub-processors | ✗ Unconfirmed |
| Permission to benchmark or publish quality claims | ✗ Not obtained |

Two known obstacles, already documented:

- **SOUNDRAW**'s public API Pro agreement §3.8 imposes **70% / 50% revenue share**
  on downloads and §3.12 restricts resale. Whether the US$300 / 1,000-song base
  fee covers download delivery is unresolved — it cannot be assumed.
- **ElevenLabs** self-serve API access is explicitly **not** a resale right;
  enterprise authorisation and possibly co-branding would be required.

Both matter directly: at a 70% share, the modelled contribution per subscriber
goes **negative** (≈ −177 JPY/month). This is a pricing-model question, not an
engineering one.

---

## 2. Operating entity and legal — BLOCKED

| Requirement | State |
| --- | --- |
| Confirmed legal entity and budget owner | ✗ Not confirmed |
| 特定商取引法 disclosure with real details | ✗ Placeholder (production refuses to boot without it) |
| Terms of service reviewed by a Japanese lawyer | ✗ Draft only, labelled as such in the UI |
| Privacy policy reviewed; APPI cross-border path confirmed | ✗ Draft only |
| Whether prepaid credits are 前払式支払手段 | ✗ Undetermined — may change the product |
| Refund policy reconciled with 資金決済法 / 特商法 / consumer law | ✗ Draft only |
| Expired-credit compensation policy fixed | ✗ Configurable, not decided |
| Trademark / domain check on "LOOPSCENE" | ✗ Not performed |

Every legal page renders a visible "this is an unreviewed draft" banner, driven
by server state rather than a constant someone could forget to flip.

---

## 3. Payments — BLOCKED on the operating entity's account

The engineering is no longer what is blocking this. A **sandbox** account exists
and the whole path has been walked against it; what is missing is an account
belonging to the company that will actually take the money, and the reviews that
come with it.

| Requirement | State |
| --- | --- |
| Stripe account for the real operating entity | ✗ — the account in use is a sandbox, and a sandbox cannot be promoted |
| Test-mode verification: success, failure, 3DS, interrupted return | ✓ All four, against live test-mode Stripe, read out of the database rather than the screen (`26e7799`, `a0d355d`; `docs/ACCEPTANCE_PAYMENTS.md` Part B) |
| Webhook endpoint registered with its own secret | ◐ Signature verification is proven — tampered bodies, garbage, an absent header, the wrong secret and a stale timestamp are all rejected — but the endpoint is `stripe listen`, not one registered in a dashboard. Registering it is part of the real account |
| Versioned price ids | ✓ Every catalogue row carries one, across versions (`premier_monthly` v2 and v3 hold different ids, which is what kept v2 subscribers on v2 when the price changed) |
| JP 3DS configuration reviewed | ✗ The flow works — a `requires_action` challenge is raised and an abandoned one grants nothing — but which transactions *should* be challenged in Japan is a compliance decision, not an engineering one |
| Digital-content review by the payment provider | ✗ Blocked |
| Payment logic (orders, idempotency, refunds, subscriptions) | ✓ Built, tested, **and corrected by the live walk.** The suite was green while subscribers paid and received nothing: the Invoice field layout had moved and the simulated adapter agreed with our stale assumption. Treat "tested" and "exercised against the provider" as different claims |

---

## 4. Infrastructure — BLOCKED on an account

| Requirement | State |
| --- | --- |
| Authorised AWS account | ✗ |
| Terraform applied | ✗ Validates; never applied |
| Helm deployed | ✗ Renders and lints; never deployed |
| Cognito pool + SES sender | ✗ |
| Real S3 / SQS verification | ✗ Local adapters mirror the contracts, which is not the same thing |
| Restore drill (RPO 15 min / RTO 4 h) | ✗ **Targets, not achievements** — unverified until drilled |
| Monitoring proven to fire | ✗ Alarms defined; the application does not yet publish its custom metrics |

---

## 5. Cost and economics — ASSUMPTIONS ONLY

Every cost figure in the system is a modelled estimate flagged `is_estimate = true`
and reported in a **separate field** from invoiced cost. Nothing has been paid
to anyone.

| Assumption | Value | Status |
| --- | --- | --- |
| Music cost / request | 45 JPY | US$0.3 at a budget 150 JPY/USD. Not a quote. |
| Technical success rate | 90% | Planning figure; unmeasured |
| Failure billing | 100% billable | Conservative default; contract decides |
| Revenue share | 0% | **Target** condition; SOUNDRAW's public terms say 70%/50% |
| Monthly minimum | 45,000 JPY | Placeholder |

Baseline model: ≈998 JPY contribution per subscriber (56.6%), ≈578 JPY at full
usage (32.8%), breaking even at ≈1,154 subscribers. These clear the proposed
management thresholds **only under the 0% revenue-share assumption**, which is
precisely what is unconfirmed.

---

## 6. Product validation — NOT AN ENGINEERING RESULT

§11.3 is explicit, and this document will not blur it: demo data cannot
demonstrate commercial success.

| Step | State |
| --- | --- |
| ~20 target-creator interviews | ✗ Not started |
| ≥10 genuine paying users (not friends/colleagues) via manual delivery | ✗ Not started |
| Small-scale paid web experiment | ✗ Not started |
| Repeat-purchase evidence | ✗ Not started |
| Renewal cohort with a full period + 7-day window | ✗ Not started |

The reporting layer is built for this and reports honestly: every funnel metric
returns **"not computable"** with a stated reason when the cohort is immature,
rather than 0% — which would read as a real and bad result.

Also note the timing trap §11.3 calls out: opening subscriptions in week 9 means
week 12 will **not** have mature renewal data. Extend the observation window;
do not declare a threshold met early.

---

## 7. What is actually done

Stated plainly so the gap above is legible:

- 30s instrumental generation: scene → intent → provider → verification → delivery
- Append-only credit ledger with database-enforced anti-oversell, verified under
  real concurrency (10 concurrent jobs against 3 credits → exactly 3 reserved)
- Full job state machine including UNKNOWN verification, late results, worker
  crash recovery and cancel-vs-submit races
- Stripe payments, subscriptions and refunds with two independent idempotency
  layers, raw-body signature verification and out-of-order event handling
- Private library, trimming, export, per-track usage records with an immutable
  licence snapshot enforced by a database trigger
- Rights-complaint handling: free, unauthenticated, suspends distribution,
  preserves evidence, states plainly that suspension is not a finding
- Operations console with role separation and mandatory audited reasons
- Responsive UI in three languages (zh / ja / en, 735 keys at parity) verified
  at 320 / 390 / 1440px. The statutory 特商法 page stays Japanese by design;
  the purchase confirmation screen does not, because the law requires six
  facts the buyer can readily check, not six facts in Japanese
- 456 automated tests against real MySQL; Terraform validates and is formatted;
  Helm lints and refuses unpinned images; Docker image builds and its production
  guard fires; actionlint clean. CI went green for the first time on 2026-10-04 —
  it had failed on every commit before that, on two lint checks, which meant no
  deploy could ever have started

---

## 8. Order of work

1. **Music agreement.** Everything commercial depends on it, and the revenue-share
   question may change the pricing model entirely.
2. **Legal review.** Entity, terms, privacy, refunds, and the 前払式支払手段
   determination — the last of which could change the product.
3. **Real cost figures** into the economics model. Re-check contribution and
   break-even with contracted rates, not budget placeholders.
4. **Accounts**: Stripe, Cognito, AWS. Then verify PAY-03, PAY-12, SEC-02 and the
   whole AWS acceptance section for real.
5. **Close the engineering gaps** in `docs/OPEN_ITEMS.md` §3 — vocal detection,
   metric publication, budget enforcement, contrast measurement.
6. **Product validation** per §11.3, starting with interviews and manual delivery.
   Not before the above; and never inferred from demo data.

Until at least steps 1–3 are complete, this project must not be reported as
ready to charge. None of that blocks continuing reversible software work.
