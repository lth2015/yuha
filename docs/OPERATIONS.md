# Operations

Runbook for LOOPSCENE. `PROJECT_TASK.md` §12.3 and §13.

> Nothing in this document has been executed against real AWS infrastructure.
> No account has been provisioned, so every procedure below is written to be
> followed, not reported as rehearsed. Targets that need a drill to prove
> (RPO/RTO) are marked as **unverified targets**, not achievements.

---

## 1. Deploying

### Prerequisites (one-time)

1. **RDS parameter group** must set `log_bin_trust_function_creators = 1`.
   The licence-immutability trigger (SEC-08) cannot be created without it, and
   the migration **fails with an explicit message** rather than skipping the
   trigger. Terraform sets this in `infra/terraform/data.tf`; changing it
   requires a reboot of the instance.
2. **Secrets** — Terraform creates the Secrets Manager containers with
   placeholders and `ignore_changes` on the value. Write the real values out of
   band:

```bash
aws secretsmanager put-secret-value --secret-id loopscene-<env>/app --secret-string '{
  "STRIPE_SECRET_KEY": "...", "STRIPE_WEBHOOK_SECRET": "...",
  "TOKENSTARS_API_KEY": "...", "MUSIC_API_KEY": "..."
}'
```

Never put a real key in `values.yaml`, in git, or in Terraform state.

### Release

The normal path is Actions → Deploy (`.github/workflows/deploy.yml`), and
`deploy/runbook.md` is the procedure. What follows is the same thing by hand,
for when the workflow cannot run.

```bash
# 1. Build and push, capturing the digest — tags are not acceptable references
docker build -t $ECR/loopscene-$ENV-api:$SHA .
docker push $ECR/loopscene-$ENV-api:$SHA
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' $ECR/loopscene-$ENV-api:$SHA | cut -d@ -f2)

# 2. Deploy. Migrations run as a pre-upgrade hook, before any new pod starts.
helm upgrade --install yuha infra/helm/loopscene \
  --namespace yuha --create-namespace \
  --values deploy/envs/$ENV.yaml \
  --set image.api.digest=$DIGEST --set image.worker.digest=$DIGEST \
  --atomic --timeout 10m
```

Three things in that block were wrong until 2026-09-28, and each would have
produced a different broken deploy: the ECR repositories Terraform creates are
`loopscene-<environment>-api`, not `loopscene-api`; the release and namespace
are `yuha`, which is what the IRSA trust policies name and what the deploy
workflow uses; and `infra/helm/loopscene/values-$ENV.yaml` has never existed —
the per-environment values live in `deploy/envs/`.

The chart **refuses to render** without a digest. A mutable tag would make
"roll back to the previous release" ambiguous, which is unacceptable on a path
that moves money.

### Post-deploy checks

```bash
kubectl -n yuha get pods
curl -sf https://$HOST/health
curl -s https://$HOST/v1/runtime | jq '{mode, demo, features}'
```

Confirm `mode` is what you intended and that `features.commercialDeliveryEnabled`
matches the actual signed agreement. If it says `true` without one, stop and fix
the configuration before announcing anything.

---

## 2. Rollback

```bash
helm rollback yuha <REVISION> --namespace yuha --wait
```

**Before rolling back, check whether the release ran a migration.** Application
rollback is instant; schema rollback is not. Migrations must therefore be
written forward-compatible: the previous image has to keep working against the
new schema. In practice:

- adding a nullable column or a new table — safe to roll back;
- dropping or renaming a column, or adding a NOT NULL without a default — **not**
  safe. Split it across two releases (add → backfill → switch reads → drop later).

If a migration failed part-way, note that MySQL DDL is not transactional: the
schema may be partly applied. The runner names the exact failing statement.
Repair forward with a new migration file; never edit an applied one — the
checksum guard will reject it (`§12.3 向前修复`).

---

## 3. Daily reconciliation

Run every day, or watch the alarms that cover the same ground.

### Credit ledger

```bash
curl -s -H "Authorization: Bearer $STAFF" https://$HOST/v1/admin/reconciliation | jq
```

`ok: true` means the per-batch counters agree with the append-only ledger.

**A discrepancy is never auto-corrected.** It means a bug wrote a counter
without a matching entry; automatically "fixing" it destroys the evidence needed
to find the cause. Instead:

1. Note the affected `batch_id`s and freeze further manual adjustments.
2. Read `ledger_entries` for those batches to reconstruct the intended state.
3. Find and fix the code path that produced the divergence.
4. Correct the user's balance through the **compensation** flow, which adds a
   new batch and leaves the original history intact.

### Payments

```bash
curl -s -H "Authorization: Bearer $STAFF" https://$HOST/v1/admin/overview \
  | jq '.revenue'
```

`ungrantedPaidOrders` should be 0. Non-zero means a payment succeeded but the
entitlement never landed; the worker's `recoverUngrantedOrders` sweep repairs
these automatically each minute, so a persistent non-zero value means the sweep
is not running or is failing — check the worker logs.

---

## 4. Alerts and responses

| Alarm | Means | Response |
| --- | --- | --- |
| `queue-age` > 180s | Users are waiting; the UI already says "delayed" | Check worker pods and provider latency. Do **not** scale past the provider's concurrency quota — it will not help. |
| `dlq-not-empty` | A job failed every retry | Inspect the DLQ message and the job's `generation_attempts`. Credits are already released; confirm before replaying. |
| `upstream-failure-rate` > 5% | Below the §12.3 target | Check the provider's status. Consider pausing generation via the runtime switch; order lookup and existing downloads keep working. |
| `daily-budget` > 80% | Approaching the spend cap | Decide deliberately whether to raise `DAILY_BUDGET_MINOR`. At 100% new generation pauses. |
| `webhook-backlog` > 20 | Entitlements are delayed | Check the worker's webhook loop. Events are persisted, so nothing is lost — it is a delay, not a loss. |
| `ledger-discrepancy` > 0 | Counters disagree with the ledger | Section 3. Investigate; do not auto-correct. |
| `ungranted-paid-orders` > 0 | Charged but no credits | Should self-heal. If not, the worker is down. |
| `stale-unknown-jobs` > 0 | Jobs past the 15-minute verification window | Should self-heal (fail + release). If not, the maintenance loop is down. |

The application-published alarms use `treat_missing_data = "breaching"`. An
alarm on a metric that nothing publishes looks healthy while being blind, which
is worse than no alarm at all.

---

## 5. Refunds

A refund arrives as a Stripe webhook and is processed automatically:

- unused units are revoked;
- **reserved** units (in-flight jobs) and **consumed** units (delivered work) are
  **not** clawed back;
- a `refund_partial_fulfilment` event is recorded when either remains, for a
  human to look at;
- the order becomes `refunded` or `partially_refunded`.

Refunds are idempotent on the refund object id, so a redelivered event revokes
nothing further.

**Manual decision needed** when a user requests a refund for credits they have
already spent. The system will not revoke delivered work automatically. The
proposed policy — unused and within 7 days of purchase — is **not yet legally
reviewed** (see `docs/LAUNCH_READINESS.md`), so until it is, escalate rather
than applying it as if it were settled.

---

## 6. Compensation

For a user who lost credits to something that was our fault:

```bash
curl -X POST https://$HOST/v1/admin/users/$USER_ID/compensate \
  -H "Authorization: Bearer $STAFF" -H 'content-type: application/json' \
  -d '{"units": 2, "reason": "upstream outage 2026-09-10, goodwill credit"}'
```

This creates a **new** compensation batch. It never edits the original
consumption, so the history of what actually happened stays intact. The reason
is mandatory and is written to `audit_logs` with the operator and the before/
after state.

Most cases need no intervention: technical failure, provider rejection, failed
output checks and verification timeouts all release the credit automatically.

### Compensation is not a gift

Compensation says, in the ledger, that we broke something and are putting it
right. It is capped at 20 units per call, at
`ADMIN_COMPENSATION_MAX_UNITS_PER_DAY` per operator per rolling day, and dated
by `EXPIRED_BATCH_COMPENSATION_DAYS`. The daily total was added late: capped
per call is not capped, and this route is open to `support`, which is the
wider of the two doors. If what you actually want is to **give**
somebody credits — a friend trying the product, an apology that is not for a
technical failure, a small giveaway — use §6a instead. Routing a giveaway
through this endpoint would say in the books that a failure happened, and
"how much have we given away" would stop having an answer.

---

## 6a. Giving credits to somebody

In the console: the **Customers and credits** panel on `/admin`, below the
overview, cost, revenue and rights-case sections. Search by email, open the
account, read where the credits they already hold came from and when they
expire, then enter a number and a reason.

This screen exists because none of it did. The only route that granted units
took a user UUID in its path, there was no way anywhere in the product to turn
an email address into that UUID, and `services/purchase-cap.ts` meanwhile
assured the reader that an operator "can issue credits directly from the
console" — offering that as the reason not to worry about the purchase cap
stopping a real customer. The escape hatch was not there.

By API, if you have the account id already:

```bash
curl -X POST https://$HOST/v1/admin/users/$USER_ID/grant \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"units": 50, "reason": "friend trying the product"}'
```

What it will refuse, and why each one exists:

| Refusal | Reason |
| --- | --- |
| more than `ADMIN_GRANT_MAX_UNITS` (100) in one gift | 500 instead of 50 is one keystroke |
| more than `ADMIN_GRANT_MAX_UNITS_PER_DAY` (500) **per operator** | the per-gift cap bounds nothing on its own — fifty gifts of fifty is still two and a half thousand generations of provider cost. This is the limit that matters if an operator account is compromised |
| a validity longer than `ADMIN_GRANT_VALIDITY_DAYS` (90) | a giveaway that never expires is a liability nobody remembers agreeing to. You may shorten it per gift, never lengthen it |
| a suspended account | somebody decided to stop serving it |
| a deleted account | granting credits to the row an executed erasure left behind would quietly undo the erasure |
| no reason | the audit row is the only record of why, and the column is NOT NULL |
| `support` calling it at all | a credit is a generation and a generation is provider cost, so this spends money. Support can compensate — an apology for a failure of ours, 20 per call and now a daily total of its own (`ADMIN_COMPENSATION_MAX_UNITS_PER_DAY`) — but giving credits away is a different authority |

Asking twice gives twice — each gift is its own batch. That is the opposite of
the order and invoice paths, which key on a business reference so a replayed
webhook grants once, and it is right here: a person clicking "Give 50" twice
meant it twice.

Credits given this way appear in the ledger as `operator_gift`, which is what
makes the question answerable later. `GET /v1/admin/audit-logs` carries the
operator, the reason and the expiry for each one.

---

## 7. Rights complaints

1. A complaint arrives at `POST /v1/rights-cases` — no account, no payment.
2. If it identifies a track, distribution is suspended immediately and the
   licence snapshot moves to `suspended`. New download links stop being issued.
3. Acknowledge the reporter within one business day.
4. Investigate, then resolve as `dismissed` / `restored` (track returns to
   deliverable) or `upheld` (track stays suspended, licence revoked).

Every resolution requires a reason and is audited. Admin role only.

Two things to state honestly, in this order, whenever a suspension happens:

- a suspension is **not** a finding of infringement — the user gets to respond;
- files already downloaded to a device or posted to an external platform
  **cannot** be technically recalled. Offer notification and cooperation; do not
  promise retrieval.

A track under an open case cannot be deleted by its owner, so evidence survives.

---

## 8. Pausing generation

Without a deploy:

```bash
curl -X PUT https://$HOST/v1/admin/settings/feature_overrides \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"value": {"generationEnabled": false}, "reason": "provider outage, ref INC-123"}'
```

New generation stops; order lookup, the library and existing downloads continue
to work (§12.3 requires exactly that split).

Runtime switches can only turn things **off**. Re-enabling something the run
mode forbids is impossible from here by design — an operator must not be able to
enable commercial delivery from a console.

---

## 9. Backup and recovery

- **Automated backups** with PITR: 14 days in production.
- **Targets: RPO 15 minutes, RTO 4 hours.** These are targets from §12.3, and
  they remain **unverified** until a restore drill is performed. Do not report
  them as met before then.

Drill procedure (not yet run):

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier loopscene-production \
  --target-db-instance-identifier loopscene-restore-test \
  --restore-time <ISO8601>

# Then, against the restored instance:
#  1. run the reconciliation query — counters must match the ledger
#  2. confirm no entitlement_batches row violates the CHECK constraints
#  3. confirm license_snapshots rows are intact and the trigger exists
#  4. record actual elapsed time as the measured RTO
```

S3 delivery is versioned; the quarantine zone expires after 30 days and is not
part of recovery — it holds raw provider output for failure investigation only.

---

## 10. Shutting down cleanly

If generation must stop permanently or for a long period, §12.3 requires order
lookup and lawful historical downloads to keep working:

1. Set `generationEnabled: false`.
2. Leave the API, the database and the delivery bucket running.
3. Notify users with a date after which downloads will end, giving enough time
   to retrieve their files.
4. Only then consider decommissioning storage.

Do **not** delete the delivery bucket while telling users their existing tracks
remain usable. Their licence records say the usage rights survive; the files
have to survive with them.
