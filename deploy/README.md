# deploy

How a commit becomes a running deployment in Tokyo (`ap-northeast-1`).

## What was already here

Most of the AWS story predates this folder, and none of it was duplicated into
it — one cluster with two sources of truth is worse than an awkward directory
layout:

| Concern | Lives in | State |
| --- | --- | --- |
| VPC, EKS, RDS MySQL, S3, ECR, CloudFront, Cognito, KMS, IRSA, alarms | `infra/terraform/` | written, **never applied** — see `docs/OPEN_ITEMS.md` |
| Deployments, Service, **ALB Ingress**, HPAs, PDB, migration hook, ConfigMap | `infra/helm/loopscene/` | complete |
| Build, test, image checks, `terraform validate`, `helm lint` | `.github/workflows/ci.yml` | complete, and now actually runs — see below |

The ALB is already modelled: `ingress.className: alb`, internet-facing,
`target-type: ip`, HTTPS-only with redirect, `/health` checks and a 60-second
idle timeout, because the API hands back a job id and the client polls.

## What was missing, and is here

Everything was built and validated, and **nothing ever shipped**:

- `ci.yml` builds the image with `push: false` — it never reached ECR.
- No workflow had AWS credentials of any kind.
- No `helm upgrade` existed anywhere.
- Nothing created the `yuha-runtime` Secret the chart mounts, so a cluster
  applying the chart today would start pods with no `DATABASE_URL`.

So this folder holds the delivery path only:

```
deploy/
  envs/staging.yaml       per-environment Helm values (the ConfigMap content)
  envs/production.yaml
  cluster/                one-time in-cluster prerequisites
  runbook.md              deploying, verifying, rolling back
```

The workflow itself is `.github/workflows/deploy.yml`, because GitHub only
reads workflows from `.github/workflows`. It takes all of its inputs from here.

The GitHub OIDC role is `infra/terraform/github_oidc.tf`, with the rest of the
Terraform. It is an AWS resource, and a second Terraform state mirroring a
folder name would have to be applied separately forever.

## The workflows are not in this folder, and cannot be

GitHub Actions reads workflows from `.github/workflows/` and nowhere else, so
both live there even though everything else about delivery is here:

| File | Fires on | Does |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push to `main`/`master`/`yuha`, any pull request, manual, **and `workflow_call`** | build, typecheck, the four gates, the suite against a real MySQL, the image checks, `terraform validate`, `helm lint`, and actionlint over these two files |
| `.github/workflows/deploy.yml` | `v*` tag, or manual with an environment | `verify` (which *is* `ci.yml`, on the ref being released) and then `helm upgrade` |

Two things about that were wrong until 2026-10-02 and are worth knowing, because
both were invisible:

- **CI had never run.** Its triggers were `main` and `master`; work happens on
  `yuha` and goes in without pull requests. A complete CI suite, green because
  nothing ever asked it.
- **A release did not run it.** `deploy.yml` fires on `v*` and had no `needs:`
  of any kind, so a tag shipped a commit no test had been run against. It now
  calls `ci.yml` through `workflow_call` on that exact ref and will not deploy
  unless it passes. One definition, called from two places — a copy of the
  suite in this workflow would drift from the real one, and the drift would
  only show up as a broken release.

The test job starts MySQL with `docker compose up -d --wait mysql-test` rather
than a `services:` block, for the same single-source reason: `services:` can
set environment variables but not command arguments, and every server setting
this project relies on — `sql_mode`, `innodb_lock_wait_timeout`,
`default-time-zone`, `log-bin-trust-function-creators` — is a command argument
in `docker-compose.yml`. CI was running against the image's defaults, which is
a different engine from the one everybody develops against.

## Two naming domains

AWS is `loopscene-<environment>` — cluster, ECR repositories, IAM roles,
Secrets Manager entries — because renaming those forces resource recreation
(CLAUDE.md). Everything inside the cluster is `yuha`: namespace, Helm release,
ServiceAccounts, the synced Secret.

The bridge is IRSA, and it is exact. `infra/terraform/compute.tf` trusts
`system:serviceaccount:yuha:yuha-api`, `…:yuha-worker` and
`…:yuha-external-secrets`; the chart and `cluster/` must create ServiceAccounts
with those names in that namespace. Until 2026-09-28 three names were in play —
the chart defaulted to `sonare-*`, `envs/*` said `yuha-*`, Terraform trusted
`loopscene:loopscene-*` — and no layer checks this. Pods would have started and
every S3, SQS and Secrets Manager call would have returned AccessDenied, which
reads as a permissions problem rather than a typo.

## Configuration

Non-secret configuration is in the ConfigMap, rendered from the values in
`envs/`. Secrets are **not**, and must not be moved there: a ConfigMap is
readable by anything that can read the namespace and its values appear in
`helm get values` and in release history.

| Kind | Where | Examples |
| --- | --- | --- |
| Non-secret | `envs/*.yaml` → ConfigMap | URLs, bucket names, feature flags, limits, legal entity block, provider endpoints |
| Secret | AWS Secrets Manager → `yuha-runtime` Secret | `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_SESSION_SECRET`, `TOKENSTARS_API_KEY`, `MUSIC_API_KEY` |

Terraform already creates the two Secrets Manager secrets and grants the pods'
IRSA roles `secretsmanager:GetSecretValue`. `cluster/` closes the last gap by
syncing them into the namespace.

## Before the first deploy

1. `terraform apply` in `infra/terraform/` (never yet run against a real
   account) and record the outputs.
2. Put the output values into `envs/<environment>.yaml`.
3. Set the repository Actions variable `AWS_DEPLOY_ROLE_ARN` from the
   `github_deploy_role_arn` output.
4. Install the AWS Load Balancer Controller and the External Secrets Operator,
   then apply `cluster/` — see `runbook.md`.
5. Fill the real values of the two Secrets Manager secrets.

## Production reaches the cluster differently

`infra/terraform/compute.tf` sets:

```hcl
cluster_endpoint_public_access = var.environment != "production"
```

In production the EKS API endpoint is **private**, and a GitHub-hosted runner
cannot reach it. The workflow therefore deploys staging directly and, for
production, requires a runner that is inside the VPC — set
`DEPLOY_RUNNER_PRODUCTION` to that runner's label. It fails with that
explanation rather than timing out against an unreachable endpoint.

This is a real decision still open, not an oversight: a self-hosted runner in a
private subnet, or a narrowly allow-listed public endpoint. `runbook.md` states
the trade.
