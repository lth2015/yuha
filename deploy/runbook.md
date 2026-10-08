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
   empty string there is a real value that has to be supplied.

   Two layers refuse, and it matters which one you are reading. The **chart**
   fails at `helm template` for the four values only it can know — image
   registry, repository, digest, and `runMode`. Everything else is checked by
   the **API at startup**, which lists every missing or contradictory setting by
   name and exits; so those show up as a CrashLoopBackOff whose logs name the
   fields. This step used to claim the chart caught all of it.

   The names in `serviceAccount.*` and `envFromSecret` are load-bearing: the
   IRSA trust policies in `infra/terraform/compute.tf` name
   `yuha:yuha-api`, `yuha:yuha-worker` and `yuha:yuha-external-secrets`
   exactly. AWS resources are `loopscene-<environment>-*`; everything inside the
   cluster is `yuha`. A mismatch does not fail the deploy — pods start and every
   AWS call returns AccessDenied.

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
   second, `yuha-runtime` never exists and every pod starts without a
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

6. **Register the Stripe webhook endpoint, and fill the price ids.** The
   endpoint is `POST https://yuha.studio/api/webhooks/stripe`, format
   **Snapshot**, API version **2025-03-31.basil**, with the fourteen events
   listed in [`docs/STRIPE_WEBHOOK.md`](../docs/STRIPE_WEBHOOK.md). The
   `whsec_…` the dashboard shows once goes into the Secrets Manager JSON above
   as `STRIPE_WEBHOOK_SECRET`; the API checks the prefix at start-up and never
   prints the value.

   Then fill `config.stripe` in `deploy/envs/<env>.yaml` with the four **live**
   `price_…` ids and the live `pk_live_…`. DROP and the licence are required at
   start-up whenever the stripe adapter is on, and the two subscription ids
   when `FEATURE_SUBSCRIPTIONS_ENABLED` — a deployment with subscriptions
   closed cannot sell them. Before this the licence and STUDIO ids were
   checked under no condition at all, and a missing one is a 500 on the
   checkout call rather than a boot failure, found by whoever tries to buy
   first. Nothing in this repository generates or guesses an id or a secret.

   **Changing a price id later needs a re-seed, not just a rollout.** Checkout
   reads `product_catalog.stripe_price_id`, which only `pnpm seed` writes, so
   editing the ConfigMap and rolling the pods leaves every session being built
   against the previous Price. `pnpm check:stripe-prices` compares the stored
   column as well as the variable and reports `stale` when they differ.

7. **Point the Google sign-in at this environment.** Google compares the
   redirect URI byte for byte and refuses on its own page, so a stale one
   leaves no trace on our side — no log line, no failed sign-in, just an error
   in the address bar. Three things have to agree:

   | Where | Value |
   | --- | --- |
   | Google Cloud Console → Credentials → the OAuth 2.0 **Web application** client → *Authorized redirect URIs* | `https://yuha.studio/v1/auth/google/callback` |
   | `deploy/envs/<env>.yaml` → `config.google.redirectUri` | the same string, byte for byte |
   | `deploy/envs/<env>.yaml` → `config.publicApiUrl` | `https://yuha.studio` |

   **It is the API's path, not the web app's.** `/auth/google/callback` also
   exists — it is where the API sends the browser *afterwards*, carrying a
   one-time code — which is exactly why it gets registered by mistake. Google
   must never be given it, and the API refuses to start if the path or the
   origin is wrong (`apps/api/src/auth/google-paths.ts`).

   Add rather than replace while migrating: an OAuth client may hold several
   redirect URIs, so leaving the old one in place keeps the previous
   deployment signing people in until it is switched off, and nobody is locked
   out during the cutover. Remove it afterwards.

   No *Authorized JavaScript origin* is needed — this is the server-side code
   flow and no Google script runs in the browser. `config.google.clientId` is
   not a secret and lives in the same file; `GOOGLE_CLIENT_SECRET` and
   `GOOGLE_SESSION_SECRET` go into the Secrets Manager JSON in step 5. If
   `GOOGLE_SESSION_SECRET` changes, every sign-in already in flight fails
   once — the `state` parameter is signed with it — which is a rolling-restart
   nuisance and nothing worse.

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
kubectl get externalsecret yuha-runtime -n yuha            # SecretSynced
kubectl run check --rm -i --restart=Never -n yuha \
  --image=curlimages/curl:8.11.0 -- curl -fsS http://yuha-api/health
```

A finished rollout is not evidence that the thing it rolled out works. Ask the
pod.

And ask the **front door** about the webhook, from outside the cluster:

```bash
curl -i -X POST https://yuha.studio/api/webhooks/stripe \
  -H 'content-type: application/json' --data '{}'
```

And ask it about the Google sign-in, which has no logs to check:

```bash
curl -si "https://yuha.studio/v1/auth/google/start" | grep -i '^location:'
```

The `Location` must be `accounts.google.com/o/oauth2/v2/auth?...` carrying
`redirect_uri=https%3A%2F%2Fyuha.studio%2Fv1%2Fauth%2Fgoogle%2Fcallback`.
Compare that string against the Cloud Console entry character by character —
that comparison is the whole test, because Google's is byte for byte. If
`/v1/auth/google/start` 404s, the sign-in button will not even appear.
`GET /v1/runtime` reports `googleConfigured: false` whenever any of the three
settings is missing, and `GET /v1/auth/config` carries `google.enabled` for
the same fact. (This named `googleConfigured` on `/v1/auth/config`, which has
never returned it — an operator grepping that response for it during a
cutover finds nothing and concludes the endpoint is broken.)

`400` with `{"error":{"code":"WEBHOOK_SIGNATURE_INVALID","message":"signature
verification failed"}}` is the pass. Unsigned on purpose: the API is the only
thing that can answer 400, so this proves the request reached it.

Read the **message**, not just the code. `raw body was not preserved` is the
same 400 from a route that is served but whose body is no longer handed through
as bytes — in that state every real Stripe event is refused as well, and it
looks identical to a wrong signing secret. A `200` carrying HTML means the path
is being served by something that is not the API, and Stripe would acknowledge
and discard every real event — a customer charged with nothing granted and no
error anywhere. A `3xx` is also a failure; a Stripe endpoint must answer
directly. `deploy/dgx/update.sh` runs the same check for the intranet stack.

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
