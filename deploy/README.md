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
| Build, test, image checks, `terraform validate`, `helm lint` | `.github/workflows/ci.yml` | complete |

The ALB is already modelled: `ingress.className: alb`, internet-facing,
`target-type: ip`, HTTPS-only with redirect, `/health` checks and a 60-second
idle timeout, because the API hands back a job id and the client polls.

## What was missing, and is here

Everything was built and validated, and **nothing ever shipped**:

- `ci.yml` builds the image with `push: false` — it never reached ECR.
- No workflow had AWS credentials of any kind.
- No `helm upgrade` existed anywhere.
- Nothing created the `sonare-runtime` Secret the chart mounts, so a cluster
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

## Configuration

Non-secret configuration is in the ConfigMap, rendered from the values in
`envs/`. Secrets are **not**, and must not be moved there: a ConfigMap is
readable by anything that can read the namespace and its values appear in
`helm get values` and in release history.

| Kind | Where | Examples |
| --- | --- | --- |
| Non-secret | `envs/*.yaml` → ConfigMap | URLs, bucket names, feature flags, limits, legal entity block, provider endpoints |
| Secret | AWS Secrets Manager → `sonare-runtime` Secret | `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_SESSION_SECRET`, `TOKENSTARS_API_KEY`, `MUSIC_API_KEY` |

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
