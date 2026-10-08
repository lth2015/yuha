# YUHA 部署到 AWS QA 环境 — SRE 任务清单

面向大连 SRE 团队。英文细节在 [DEPLOY_AWS.md](DEPLOY_AWS.md)（完整步骤）和
[../deploy/runbook.md](../deploy/runbook.md)（值班手册），这份清单只负责说清楚
**谁做什么、按什么顺序、做完怎么确认**。

> **先读这一段。** 本仓库的基础设施代码（Terraform / Helm / GitHub Actions）
> 是完整的，并且在 CI 里通过了格式检查、`terraform validate`、`helm lint` 和
> 渲染检查。但是 **它从未在任何真实 AWS 账号上 `apply` 过**。所以这份清单里
> 凡是标 ⚠️ 的地方，都是"代码写了但没人跑过"，第一次执行时请预留调试时间，
> 不要当成按下按钮就能过的流程。

---

## 0. 现状速览

| 项目 | 状态 |
| --- | --- |
| 应用镜像（`Dockerfile`，api/worker/web 同一个镜像） | ✅ CI 里能构建 |
| Terraform（VPC / EKS / RDS / S3 / SQS / Cognito / IAM / 监控） | ✅ `validate` 通过，⚠️ 从未 `apply` |
| Helm chart（`infra/helm/loopscene`） | ✅ `lint` 和渲染通过 |
| CI（`.github/workflows/ci.yml`） | ✅ 2026-10-04 起为绿（此前连续失败，见下） |
| 部署流水线（`.github/workflows/deploy.yml`） | ✅ 代码完整，⚠️ 从未真正部署成功过 |
| QA 环境定义 | ✅ 本次新增，见第 1 节 |
| Terraform 远程状态后端（S3 + DynamoDB 锁） | ❌ **未配置，需要你们建**，见清单 2.1 |

### CI 之前为什么是红的

从 `gh run list` 看，本分支**每一次提交 CI 都失败**，连续八次。原因不是测试，
是两个 lint：`terraform fmt -check` 要求两处对齐（各一行），以及 actionlint 报
了五个 shellcheck 问题。

这件事对你们很重要，因为 `deploy.yml` 里有 `needs: verify`，它通过
`workflow_call` 调用 `ci.yml`。**CI 红着，部署根本无法开始。** 这两个问题已在
提交 `CI has been red on every commit` 中修复，当前 CI 五个任务全绿。

---

## 1. 为 QA 环境做的改动（已提交）

原先 `qa` 这个环境名在三个地方都不被接受，直接执行会在第一步失败：

| 文件 | 改动 |
| --- | --- |
| `infra/terraform/variables.tf` | `environment` 的校验列表加入 `qa`（原本只允许 dev/staging/production） |
| `deploy/envs/qa.yaml` | 新建，从 `staging.yaml` 复制而来 |
| `.github/workflows/deploy.yml` | 手动触发的环境选项加入 `qa` |

Terraform 只在 `environment == "production"` 时分叉（Multi-AZ、删除保护、私有
EKS 端点、更长的备份保留）。**`dev` / `qa` / `staging` 三者形状完全一致**，所以
QA 是一次足尺彩排，不是缩水版。

---

## 2. 清单

### 阶段 0 — 开工前你需要拿到的东西

- [ ] 一个可用的 AWS 账号（区域 **ap-northeast-1 东京**），有创建 VPC / EKS /
      RDS / S3 / SQS / IAM / KMS / Cognito 的权限
- [ ] 一个 QA 用的域名，例如 `qa.yuha.studio`，以及对应的 Route 53 托管区
- [ ] 该域名在 **ap-northeast-1** 的 ACM 证书（必须是这个区域，ALB 要用）
- [ ] 本仓库 `lth2015/music` 的 **Settings 管理权限**（要建 Environment 和变量）
- [ ] 以下外部服务的 QA 用密钥（向<redacted: operator name>索取，**不要用生产的那套**）：
      Stripe（`sk_test_…` + `whsec_…` + 四个 price id）、Google OAuth
      client id/secret、Tokenstars API key

### 阶段 1 — Terraform 状态后端 ⚠️ 必须先做

`infra/terraform/main.tf` 第 30 行写着后端应当配置，但 **代码里是注释掉的**：

```hcl
# Configure a versioned S3 backend with DynamoDB locking before first use.
# backend "s3" {}
```

- [ ] 1.1 手工创建一个开启版本控制的 S3 桶（例：`yuha-tfstate-apne1`）
- [ ] 1.2 创建一张 DynamoDB 表用于加锁（主键 `LockID`，字符串）
- [ ] 1.3 取消注释并填好 `backend "s3"`，然后 `terraform init -migrate-state`

> 不做这一步也能跑，但状态会留在本机，第二个人执行时会覆盖彼此的变更。
> 多人运维必须先做。

### 阶段 2 — 基础设施（Terraform）⚠️ 从未在真实账号执行

在 `infra/terraform/` 目录下：

- [ ] 2.1 `terraform init`
- [ ] 2.2 `terraform plan -var environment=qa -var-file=qa.tfvars`
      —— `qa.tfvars` 需要你们自己写，至少包含：
      `web_callback_urls`、`ses_source_arn`、`ses_from_address`、`alert_email`
      （见 `variables.tf`，没有默认值的就是必填）
- [ ] 2.3 **人工审阅 plan**。第一次执行请逐项看，不要直接 apply
- [ ] 2.4 `terraform apply`
- [ ] 2.5 记录 `terraform output`，后面每一步都要用：
      ECR registry、`api_role_arn`、`worker_role_arn`、
      `cognito_user_pool_id`、`cognito_app_client_id`、
      `quarantine_bucket`、`delivery_bucket`、`kms_media_key_arn`、
      `sqs_queue_url`

资源命名统一是 `loopscene-qa-*`（AWS 侧保留历史名 `loopscene`，集群内一律叫
`yuha`，这是刻意为之，见 `CLAUDE.md`，**请勿"顺手改名"**）。

### 阶段 3 — 运行时密钥（Secrets Manager）

集群通过 External Secrets 从 Secrets Manager 拉取，路径是写死的
`loopscene-<环境>/…`。QA 需要建两条：

- [ ] 3.1 `loopscene-qa/database`，含属性 `url`
      —— 格式 `mysql://用户:密码@主机:3306/库名`
- [ ] 3.2 `loopscene-qa/app`，含以下属性：

| 属性名 | 说明 |
| --- | --- |
| `STRIPE_SECRET_KEY` | QA 用 `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` |
| `TOKENSTARS_API_KEY` | 文本模型 |
| `MUSIC_API_KEY` | 音乐服务 |
| `GOOGLE_CLIENT_SECRET` | OAuth |
| `GOOGLE_SESSION_SECRET` | 会话签名，**随机 32 字节以上** |

> ⚠️ **`GOOGLE_SESSION_SECRET` 绝对不能留空。** 2026-10-04 修了一个相关缺陷：
> 配置里写了键但值为空时，`??` 兜底接不住空字符串，会话会用**空密钥**签名。
> 现在空值和纯空格一律视为未设置，生产模式会拒绝启动——但 QA 跑的是
> `integration` 模式，**请确认这个值真的填了**。
>
> `STORAGE_SIGNING_SECRET` 在 AWS 上**不需要**，它只给本地存储适配器用；
> S3 的签名由 AWS SDK 完成。

### 阶段 4 — 集群内（External Secrets Operator）

- [ ] 4.1 在 EKS 上安装 External Secrets Operator（Helm）
- [ ] 4.2 把 `deploy/cluster/external-secrets.yaml` 里的 `__ENVIRONMENT__`
      替换成 `qa`，然后 apply
- [ ] 4.3 确认生成了名为 `yuha-runtime` 的 Secret，且七个键都在：
      ```bash
      kubectl -n yuha get secret yuha-runtime -o jsonpath='{.data}' | tr ',' '\n' | cut -d'"' -f2
      ```

### 阶段 5 — GitHub 侧配置（这部分你们手动做）

- [ ] 5.1 **建 Environment**：仓库 Settings → Environments → 新建名为 **`qa`**
      的环境。`deploy.yml` 里有 `environment: ${{ inputs.environment }}`，
      **环境不存在，部署会直接失败**
- [ ] 5.2 **配 OIDC 角色**：Settings → Secrets and variables → Actions →
      Variables，新增仓库变量 **`AWS_DEPLOY_ROLE_ARN`**，值是 Terraform
      `github_oidc.tf` 创建的那个角色 ARN
      > 整条流水线**没有任何静态 AWS 密钥**，这是刻意设计。请不要为了省事改成
      > access key。
- [ ] 5.3 `DEPLOY_RUNNER_PRODUCTION` **QA 不需要配**。它只在生产用——生产的
      EKS 端点是私有的，GitHub 托管 runner 连不上，需要自建 runner。
      QA 的端点是公开的，用 `ubuntu-latest` 即可
- [ ] 5.4 如果需要人工审批，在 `qa` 环境上配 Required reviewers

### 阶段 6 — 填 QA 的 Helm values

编辑 `deploy/envs/qa.yaml`，把阶段 2.5 记下的 Terraform 输出填进去。
**所有空字符串都必须填**：

- [ ] `image.registry`（ECR 地址）
- [ ] `serviceAccount.api.roleArn` / `serviceAccount.worker.roleArn`
- [ ] `ingress.host`、`ingress.certificateArn`
- [ ] `config.publicWebUrl` / `publicApiUrl`
- [ ] `config.google.clientId` / `redirectUri`
- [ ] `config.cognito.userPoolId` / `appClientId`
- [ ] `config.storage.*`（两个桶 + KMS key）
- [ ] `config.queue.url`
- [ ] `config.tokenstars.baseUrl` / `modelId`
- [ ] `config.stripe.publishableKey` + 四个 price id

> chart 只对它自己能判断的东西（registry、repository、digest、runMode）在渲染
> 阶段报错；**其余缺失项由 API 在启动时逐个点名后退出**。所以 Pod
> CrashLoopBackOff 时第一件事是看日志，它会直接告诉你缺哪个。
>
> `image.*.digest` **不要提交到仓库**，由流水线在部署时注入。

### 阶段 7 — 首次部署

- [ ] 7.1 确认 CI 在目标 commit 上是绿的（`gh run list`）
- [ ] 7.2 Actions → Deploy → Run workflow → environment 选 **`qa`**
- [ ] 7.3 观察流水线：它会先跑完整 CI（`verify`），再构建推送镜像到 ECR，
      按 digest 固定版本，最后 `helm upgrade --install`
- [ ] 7.4 数据库迁移由 Helm hook 执行，**不要手工跑迁移**

### 阶段 8 — 部署后验收

- [ ] 8.1 `kubectl -n yuha get pods` 全部 Running
- [ ] 8.2 流水线最后一步会用一个临时 Pod 去请求服务，确认**真的在服务**，
      而不只是 rollout 成功
- [ ] 8.3 浏览器打开 `https://qa.yuha.studio`，走一遍：
      登录 → 创作 → 生成 → 播放 → 下载
- [ ] 8.4 Stripe webhook 指向 `https://qa.yuha.studio/api/webhooks/stripe`（`/v1/webhooks/stripe` 同样可用，是同一个处理器），格式 Snapshot、API 版本 `2025-03-31.basil`、勾 docs/STRIPE_WEBHOOK.md 列的 14 个事件，
      用 Stripe CLI 发一个测试事件，确认返回 200
- [ ] 8.5 详细冒烟项见 [DEPLOY_AWS.md](DEPLOY_AWS.md) 第 7 节

### 回滚

见 [../deploy/runbook.md](../deploy/runbook.md) 的 Rolling back 一节。要点：
ECR 仓库是 **不可变（IMMUTABLE）** 的，同一个 commit 重新部署不会覆盖镜像，
回滚靠 `helm rollback`。

---

## 3. 已知的坑

1. **`qa` 这个名字在 Terraform 里刚刚才被允许。** 如果你们拉的是旧
   commit，`terraform apply -var environment=qa` 会直接被校验拒绝。
2. **Terraform 状态后端是注释掉的。** 多人运维前必须先做阶段 1。
3. **`runMode` 不能写 `qa`。** 它是 `demo | integration | production` 的枚举，
   `qa.yaml` 里是 `integration`（意思是"真实适配器，但不承担生产级承诺"）。
   写成 `qa` 会让每个 Pod 在启动时报 `Invalid enum value` 退出。
4. **音乐服务**：`qa.yaml` 里 `music.adapter` 是 `demo`。接真实音乐服务需要
   另外配一组 `MUSIC_*`，并且把音频主机加进 `allowedAudioHosts` 白名单——
   SSRF 防护是精确主机匹配，不是后缀匹配。
5. **特商法信息**：`qa.yaml` 里带着真实的经营者姓名、住址和电话。QA 环境如果
   对外可访问，请先和<redacted: operator name>确认是否要替换成占位值。

---

## 4. 本清单不覆盖的事

- 真实刷卡扣款的端到端验收（只做过 Stripe 测试模式）
- S3 保留期清扫、账户删除作业在真实 S3 上的行为（代码完成，**未在 S3 验证**）
- 生产环境部署（私有 EKS 端点，需要自建 runner，是另一套流程）
- 真机读屏（screen reader）无障碍测试

---

有任何一步卡住，请把 **完整的 plan / 流水线日志** 发回来，不要只发最后一行
报错——这套东西第一次在真实账号上跑，上下文比结论有用。
