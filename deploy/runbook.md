# Deploy runbook

Tokyo (`ap-northeast-1`). Cluster `loopscene-<environment>`, namespace `yuha`,
Helm release `yuha` from `infra/helm/loopscene`.

## Once, before the first deploy

Nothing below has been run against a real AWS account. `docs/OPEN_ITEMS.md`
records that as BLOCKED_EXTERNAL, and this runbook does not pretend otherwise.

1. **Apply the infrastructure.**
   ```bash
   cd infra/terraform
   terraform init
   terraform apply -var environment=staging
   ```

2. **Set the repository variables** (Settings → Secrets and variables →
   Actions → Variables). Variables, not secrets: neither is confidential.

   | Variable | From |
   | --- | --- |
   | `AWS_DEPLOY_ROLE_ARN` | `terraform output github_deploy_role_arn` |
   | `DEPLOY_RUNNER_PRODUCTION` | label of a self-hosted runner inside the VPC — production only |

3. **Fill `deploy/envs/<environment>.yaml`** from the Terraform outputs. Every
   empty string there is a real value that has to be supplied; the chart fails
   rather than rendering a half-configured release.

4. **Install the two controllers the chart and the secret sync depend on.**
   ```bash
   helm repo add eks https://aws.github.io/eks-charts
   helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
     -n kube-system --set clusterName=loopscene-staging

   helm repo add external-secrets https://charts.external-secrets.io
   helm install external-secrets external-secrets/external-secrets \
     -n external-secrets --create-namespace
   ```
   Without the first, the Ingress is created and no ALB appears. Without the
   second, `sonare-runtime` never exists and every pod starts without a
   `DATABASE_URL`.

5. **Put the real secret values in Secrets Manager.** Terraform writes the
   database secret itself. `loopscene-<env>/app` is created with placeholders
   and `ignore_changes`, so fill it out of band:
   ```bash
   aws secretsmanager put-secret-value --secret-id loopscene-staging/app \
     --secret-string '{"STRIPE_SECRET_KEY":"...","STRIPE_WEBHOOK_SECRET":"...","TOKENSTARS_API_KEY":"...","MUSIC_API_KEY":"...","GOOGLE_CLIENT_SECRET":"...","GOOGLE_SESSION_SECRET":"..."}'
   ```
   `GOOGLE_CLIENT_SECRET` and `GOOGLE_SESSION_SECRET` are **not** in Terraform's
   placeholder but are required by the chart. The sync reports a missing
   property until they are added, which is the correct failure — Google sign-in
   cannot work without them, and a silently absent key looks like a login bug.

## Deploying

Actions → Deploy → Run workflow, pick the environment. A `v*` tag deploys
production.

The workflow builds one image, publishes it to both ECR repositories, pins
both Deployments **by digest** — the chart refuses a mutable tag — applies the
secret sync, then runs `helm upgrade --install --atomic --wait`. Migrations run
as a `pre-upgrade` hook, so they complete before any new pod starts.

Re-running a deploy for a commit that is already published reuses the existing
image instead of failing: the repositories are `IMMUTABLE`, and redeploying the
same commit is a normal thing to want.

## Verifying

The workflow already does all three; do them by hand if you are deploying
outside it.

```bash
kubectl rollout status deploy -n yuha -l app.kubernetes.io/instance=yuha
kubectl get externalsecret sonare-runtime -n yuha          # SecretSynced
kubectl run check --rm -i --restart=Never -n yuha \
  --image=curlimages/curl:8.11.0 -- curl -fsS http://yuha-api:4000/health
```

A finished rollout is not evidence that the thing it rolled out works. Ask the
pod.

## Rolling back

`--atomic` reverts automatically if the upgrade fails. To go back after one
that succeeded and then misbehaved:

```bash
helm history yuha -n yuha
helm rollback yuha <revision> -n yuha --wait
```

**A rollback does not undo a migration.** The hook runs forward-only. If a
release contained a destructive migration, rolling the image back leaves the
new schema underneath the old code — check `helm history` against
`packages/db/src/migrations/` before assuming a rollback is safe, and prefer
rolling forward.

## When production will not deploy

The production EKS endpoint is private:

```hcl
cluster_endpoint_public_access = var.environment != "production"
```

A GitHub-hosted runner cannot reach it. The workflow fails immediately with
that explanation rather than timing out. Two ways out, neither chosen yet:

- A self-hosted runner in a private subnet — keeps the endpoint closed, costs a
  runner to operate.
- A public endpoint with `cluster_endpoint_public_access_cidrs` allow-listed —
  simpler, but GitHub-hosted runners have wide, changing IP ranges, so the
  allow-list ends up broad enough to be worth little.

The first is the better trade for a product holding payment data. It is
recorded here rather than decided unilaterally.
