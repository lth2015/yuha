# Deploying SONARE on AWS

End-to-end runbook for the production topology: **ALB → EKS (api + worker) →
RDS MySQL 8**, audio on **S3** (two access boundaries), queue on **SQS**, static
web on **S3 + CloudFront**, payments on **Stripe**, sign-in with **Google**.
Region: `ap-northeast-1` (Tokyo) throughout.

Everything here is driven by the two IaC layers that already exist:

| Layer | Path | Provides |
| --- | --- | --- |
| Terraform | `infra/terraform/` | VPC, EKS + managed node groups, IRSA roles, RDS MySQL (+ param group `log_bin_trust_function_creators=1`), S3 buckets + KMS, SQS + DLQ, Cognito (optional identity), CloudFront + web bucket, ECR repos, CloudWatch alarms |
| Helm | `infra/helm/loopscene/` | api Deployment/Service/Ingress(ALB)/HPA/PDB, worker Deployment/HPA, configmap (non-secret env), pre-upgrade migrate Job |

Secrets never live in either layer: they are created in **AWS Secrets Manager**
(Terraform output `app_secret_arn`) and synced into the cluster as the
`sonare-runtime` Secret (External Secrets Operator or equivalent).

---

## 0. Prerequisites

```bash
aws configure            # an account/role allowed to create all of the above
kubectl version --client
helm version             # v3
terraform version        # >= 1.6
docker version
```

DNS: a hosted zone you control (e.g. `sonare.example.com`) for the API and web
hostnames, plus an ACM certificate in `us-east-1` for CloudFront and one in
`ap-northeast-1` for the ALB.

## 1. Infrastructure (Terraform)

```bash
cd infra/terraform
terraform init

terraform apply -var='environment=production' \
  -var='alert_email=ops@netstars.co.jp' \
  -var='web_callback_urls=["https://sonare.example.com"]'
```

What this creates (and why it is shaped this way):

- **EKS 1.31**, private API endpoint in production, two managed node groups —
  api on general purpose, worker on a tainted `workload=worker` pool (ffmpeg is
  CPU-bound).
- **RDS MySQL 8.0** Multi-AZ, `db.t4g.medium` default, in private subnets, with
  the parameter group that allows the licence-immutability trigger. The master
  password is generated into Secrets Manager (`database_secret_arn`).
- **S3**: `quarantine` (raw provider output; the delivery path cannot read it)
  and `delivery` (masters/exports, private, KMS-SSE, versioned, lifecycle).
  Both have public access blocked. Presigned URLs are the only way out.
- **SQS** generation queue + DLQ; alarms on queue age and DLQ depth.
- **ECR** repositories `sonare-api` / `sonare-worker`.
- **CloudFront + web bucket** for the SPA (`cloudfront_domain` output).

Capture the outputs — Helm consumes them:

```bash
terraform output cluster_name
terraform output api_role_arn        # → serviceAccount.api.roleArn
terraform output worker_role_arn     # → serviceAccount.worker.roleArn
terraform output database_secret_arn
terraform output quarantine_bucket
terraform output delivery_bucket
terraform output sqs_queue_url
terraform output cloudfront_domain
```

## 2. Runtime secrets (Secrets Manager → Kubernetes)

Create one secret named e.g. `sonare/production/runtime` holding:

```json
{
  "DATABASE_URL": "mysql://<user>:<password>@<rds-endpoint>:3306/sonare?ssl={\"rejectUnauthorized\":true}",
  "GOOGLE_CLIENT_SECRET": "…",
  "GOOGLE_SESSION_SECRET": "<openssl rand -hex 32>",
  "STRIPE_SECRET_KEY": "sk_live_…",
  "STRIPE_WEBHOOK_SECRET": "whsec_…",
  "TOKENSTARS_API_KEY": "…",
  "MUSIC_API_KEY": "<GLM API key>"
}
```

Sync it into the namespace as Secret `sonare-runtime` (External Secrets
Operator):

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: sonare-runtime
spec:
  refreshInterval: 1h
  secretStoreRef: { name: aws-secretsmanager, kind: ClusterSecretStore }
  target: { name: sonare-runtime }
  dataFrom:
    - extract: { key: sonare/production/runtime }
```

## 3. Container images

One Dockerfile builds one image serving both workloads (dist-pinned):

```bash
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin $AWS_ACCOUNT.dkr.ecr.ap-northeast-1.amazonaws.com

docker build -t sonare .
docker tag sonare:latest $AWS_ACCOUNT.dkr.ecr.ap-northeast-1.amazonaws.com/sonare-api:$(git rev-parse --short HEAD)
docker tag sonare:latest $AWS_ACCOUNT.dkr.ecr.ap-northeast-1.amazonaws.com/sonare-worker:$(git rev-parse --short HEAD)
docker push $AWS_ACCOUNT.dkr.ecr.ap-northeast-1.amazonaws.com/sonare-api:$(git rev-parse --short HEAD)
docker push $AWS_ACCOUNT.dkr.ecr.ap-northeast-1.amazonaws.com/sonare-worker:$(git rev-parse --short HEAD)

# Helm refuses to render without digests — resolve and pin:
docker manifest inspect $AWS_ACCOUNT.dkr.ecr.ap-northeast-1.amazonaws.com/sonare-api:$(git rev-parse --short HEAD) | jq -r '.manifests[0].digest'   # or .config.digest for single-manifest
```

## 4. Web (SPA)

```bash
cd apps/web && pnpm build   # outputs static files
aws s3 sync dist/ s3://$(terraform -chdir=../../infra/terraform output -raw web_bucket) --delete
```

Invalidate CloudFront after each release:
`aws cloudfront create-invalidation --distribution-id <id> --paths "/*"`.

Point `sonare.example.com` (CNAME) at `cloudfront_domain`.

## 5. External consoles

| Console | What to configure |
| --- | --- |
| **Google Cloud** | OAuth 2.0 Web client. Authorized redirect URI: `https://api.sonare.example.com/v1/auth/google/callback` (exactly; it equals `GOOGLE_REDIRECT_URI` in Helm). Copy client id/secret into Secrets Manager. |
| **Stripe** | Products/prices for `drop_5`, `pro_monthly`, `premier_monthly` (USD). Webhook endpoint: `https://api.sonare.example.com/v1/webhooks/stripe`, events: checkout.session.completed, invoice.paid, customer.subscription.updated/deleted, charge.refunded, charge.dispute.*. Copy price ids into Helm values and the webhook signing secret into Secrets Manager. |
| **ACM** | `ap-northeast-1` cert for `api.sonare.example.com` (ALB); `us-east-1` cert for the CloudFront domain. |

## 6. Release (Helm)

```bash
aws eks update-kubeconfig --name $(terraform -chdir=infra/terraform output -raw cluster_name) --region ap-northeast-1

helm upgrade --install sonare infra/helm/loopscene \
  --namespace sonare --create-namespace \
  --set image.api.digest=sha256:… \
  --set image.worker.digest=sha256:… \
  --set serviceAccount.api.roleArn=$(terraform -chdir=infra/terraform output -raw api_role_arn) \
  --set serviceAccount.worker.roleArn=$(terraform -chdir=infra/terraform output -raw worker_role_arn) \
  --set config.publicWebUrl=https://sonare.example.com \
  --set config.publicApiUrl=https://api.sonare.example.com \
  --set config.google.clientId=….apps.googleusercontent.com \
  --set config.google.redirectUri=https://api.sonare.example.com/v1/auth/google/callback \
  --set config.storage.quarantineBucket=$(terraform -chdir=infra/terraform output -raw quarantine_bucket) \
  --set config.storage.deliveryBucket=$(terraform -chdir=infra/terraform output -raw delivery_bucket) \
  --set config.storage.kmsKeyId=$(terraform -chdir=infra/terraform output -raw kms_media_key_arn) \
  --set config.queue.url=$(terraform -chdir=infra/terraform output -raw sqs_queue_url) \
  --set config.stripe.publishableKey=pk_live_… \
  --set config.stripe.priceIdDrop5=price_… \
  --set config.stripe.priceIdProMonthly=price_… \
  --set config.stripe.priceIdPremierMonthly=price_… \
  --set ingress.host=api.sonare.example.com \
  --set ingress.certificateArn=arn:aws:acm:ap-northeast-1:…:certificate/…
```

The chart runs `db:migrate` as a pre-upgrade hook, keeps API replicas spread
across AZs (PDB `minAvailable: 1`), and scales worker 1→4 on CPU — the real
worker ceiling is the music provider's concurrency quota and the daily budget,
not the HPA.

`helm template` (as CI runs) refuses to render without digest-pinned images —
a mutable tag would make "roll back to the previous release" ambiguous.

## 7. Post-deploy smoke checks

```bash
curl -fsS https://api.sonare.example.com/health           # {"status":"ok","mode":"production"}
curl -fsS https://api.sonare.example.com/v1/runtime       # adapters: google / glm / stripe / s3 / sqs
kubectl -n sonare rollout status deploy/sonare-api
kubectl -n sonare logs -l component=worker --tail=50
```

In the browser: Google sign-in → create one song → watch it deliver → publish
to Explore → play it → Stripe test-mode purchase on staging before live keys.

Confirm the alarms exist:
`aws cloudwatch describe-alarms --alarm-name-prefix sonare`.

## 8. Operations quick reference

- **Roll back**: `helm rollback sonare <revision> -n sonare` (digest pinning
  makes the previous revision unambiguous), then re-run the migrate Job only if
  a migration needs reverting (forward-fix per policy).
- **Scale**: raise `worker.autoscaling.maxReplicas` only with provider quota to
  match; raise `DAILY_BUDGET_MINOR` deliberately.
- **Rotate secrets**: update Secrets Manager; External Secrets refreshes
  within `refreshInterval`; restart workloads
  (`kubectl -n sonare rollout restart deploy/sonare-api deploy/sonare-worker`).
- **Stop generation, keep the site alive**: set runtime setting
  `feature_overrides.generationEnabled=false` via the admin console — order
  lookup, library and downloads continue.
- **RDS recovery**: PITR window and snapshot cadence come from the Terraform
  defaults; the runbook target is RPO 15 min / RTO 4 h — rehearse before
  relying on it.

## 9. Production gates (enforced at boot)

`loadConfig` refuses to start in production mode with any of: the dev auth
adapter, the demo music adapter, simulated payments, local storage, a test
Stripe key, `DEV_AUTH_SECRET` set, `DATABASE_SSL=false`, or placeholder legal
details — so a misconfigured release fails loudly instead of half-working.
`MUSIC_COMMERCIAL_DELIVERY=true` is likewise rejected until a signed provider
agreement replaces the GLM preset's default.
