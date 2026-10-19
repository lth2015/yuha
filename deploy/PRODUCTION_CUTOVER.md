# yuha.studio 切换到生产模式（Stripe 收款）

yuha.studio 跑在 AWS 的 `qa-music` 命名空间里，名字叫 QA，**实际是交给用户用的正式服务**。
它目前以 `RUN_MODE=integration` + 模拟支付运行：用户点「充值」买不了任何东西，
生产模式的那组保护也一条都没有生效。本文是切到 `RUN_MODE=production` + Stripe
live 的顺序和逐项清单。

## 为什么「生产 .env 都放进 secret 了」还不够

2026-10-19 时线上 `/v1/runtime` 仍是 `mode: integration`、`payments: simulated`，原因有三个，都在部署接线上：

1. **`RUN_MODE` 写死在 manifest 里。** `deploy/k8s/qa/resources.yaml` 的 API、worker 容器和
   `migration.yaml` 都有 `env: RUN_MODE=integration`。Kubernetes 里显式 `env:` 优先于 ConfigMap 和 secret，
   secret 里写什么都改不了它——只能改这个仓库（「切换 PR」）。
2. **secret 只挂进来 15 个指定的 key**（见下表），其余变量放进 secret 不会被读到。
   `PAYMENTS_ADAPTER`、`STRIPE_PUBLISHABLE_KEY`、`STRIPE_PRICE_ID_*`、`EMAIL_ADAPTER`、`DATABASE_SSL`
   等读的是 ConfigMap `qa-music-api-config` / `qa-music-worker-config`。
3. **同名时 ConfigMap 赢。** 应用只用 secret 文件补「环境里还没有的变量」（`resolveEnv`），
   所以 ConfigMap 里一个旧值会盖住 secret 里的新值。

另外：integration 模式下应用**拒绝启动**于 `sk_live_` 密钥，而 10-19 部署后 pod 正常起来了——
说明当时 secret 里的 `STRIPE_SECRET_KEY` 还不是 live key（空或测试 key），线上却在发 `pk_live_`。

## 每个变量放在哪里

| 来源 | 变量 |
| --- | --- |
| **manifest（本仓库）** | `RUN_MODE`、`NODE_ENV`、`APP_SECRET_DIR` |
| **secret**（AWS Secrets Manager，经 SecretProviderClass 挂载） | `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_SESSION_SECRET`、`STORAGE_SIGNING_SECRET`、`TOKENSTARS_API_KEY`、`MUSIC_API_KEY`、`ALIGNMENT_API_KEY`、`POLYGON_RPC_PRIMARY_URL`、`POLYGON_RPC_SECONDARY_URL`、`LEGAL_ENTITY_NAME`、`LEGAL_ENTITY_REPRESENTATIVE`、`LEGAL_ENTITY_CONTACT`、`LEGAL_ENTITY_PHONE`、`DEV_AUTH_SECRET`（切换时删除） |
| **ConfigMap** | 其余全部：`PAYMENTS_ADAPTER`、`STRIPE_PUBLISHABLE_KEY`、`STRIPE_PRICE_ID_*`、`STRIPE_API_VERSION`、`EMAIL_ADAPTER`、`SES_REGION`、`EMAIL_FROM`、`DATABASE_SSL`、`ADMIN_MFA_REQUIRED`、S3/SQS/TokenStars/音乐服务的非密钥配置…… |

数据库凭据另走 `yuha-database-secrets`（RDS 托管），不在此表。

## 生产模式需要什么

最权威的清单是检查命令本身的输出（下一节），它跑的就是应用启动时的 `loadConfig`。下面是和收款直接相关的部分：

**Stripe（live 模式，Stripe 后台操作）**

- 4 个 Price，金额必须与目录一致（含税，JPY）：

  | 变量 | 商品 | 金额 | 类型 |
  | --- | --- | --- | --- |
  | `STRIPE_PRICE_ID_DROP_5` | DROP — 5 songs | ¥980 | 一次性 |
  | `STRIPE_PRICE_ID_PRO_MONTHLY` | CREATOR — 15 songs / month | ¥1,980 | 每月订阅 |
  | `STRIPE_PRICE_ID_PREMIER_MONTHLY` | STUDIO — 45 songs / month | ¥3,980 | 每月订阅 |
  | `STRIPE_PRICE_ID_MARKET_LICENSE` | Licence — one song | ¥980 | 一次性 |

  CREATOR 和 STUDIO 只差价格，最容易填反。填反的后果是按 Stripe 的价格扣款、订单记目录价，
  webhook 的金额校验在扣款**之后**才报错。检查命令和部署时的目录步骤都会逐个比对。
- Webhook endpoint：`https://yuha.studio/api/webhooks/stripe`（已确认这条路径由 API 应答：未签名的 POST 返回
  400 `WEBHOOK_SIGNATURE_INVALID`，不是页面壳）。订阅事件：
  `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed`、
  `checkout.session.expired`、`charge.refunded`、`refund.created`、`charge.dispute.created`、`charge.dispute.closed`、
  `customer.subscription.created`、`customer.subscription.updated`、`customer.subscription.deleted`、
  `invoice.paid`、`invoice.payment_succeeded`、`invoice.payment_failed`。
  它的签名密钥（`whsec_…`）进 secret 的 `STRIPE_WEBHOOK_SECRET`。

**secret**：`STRIPE_SECRET_KEY` = `sk_live_…`；删除 `DEV_AUTH_SECRET`（生产模式拒绝它存在）和 `LEGAL_ENTITY_ADDRESS`（已不使用）。

**ConfigMap**（API 和 worker 两个都要）：`PAYMENTS_ADAPTER=stripe`、`STRIPE_PUBLISHABLE_KEY=pk_live_…`（与 secret key 同一个 Stripe 账户）、
四个 `STRIPE_PRICE_ID_*`、`DATABASE_SSL=true`、`EMAIL_ADAPTER=ses`（或 `smtp`）及其配置、不要把 `ADMIN_MFA_REQUIRED` 设为 false。

## 检查命令

`deploy/k8s/qa/production-check.yaml` 是一个一次性 Job：用线上同一个 API 镜像、**当前的** ConfigMap 和 secret 挂载，
强制 `RUN_MODE=production`，跑 `check-production.js`。它不启动服务、不写任何东西、不打印任何值，
只列出「哪个变量有什么问题、该在 ConfigMap / secret / manifest 哪里改」；配置能通过时，再只读地向 Stripe 比对四个价格。

为什么不是 `kubectl exec` 进现有 pod：容器的环境变量在启动时就固定了，改完 ConfigMap 后，运行中的 pod 看到的还是旧值。

```bash
image=$(kubectl -n qa-music get deploy yuha-api -o jsonpath='{.spec.template.spec.containers[0].image}')
sed "s#__API_IMAGE__#$image#" deploy/k8s/qa/production-check.yaml | kubectl -n qa-music apply -f -
kubectl -n qa-music logs -f job/yuha-production-check
kubectl -n qa-music delete job yuha-production-check
```

worker 的配置同样要查：按 Job 文件顶部的说明换成 `qa-music-worker-config`、`yuha-worker-secrets` 和 `worker` 服务账号。

最后一行是 `✓ production mode would start, and the live Stripe prices match the catalogue.` 才进入切换。

## 切换顺序

1. **Stripe 后台**：建 4 个 live Price、建 live webhook endpoint。对线上无影响。
2. **改 secret 和 ConfigMap**（上面各项）。运行中的 pod 不受影响（环境只在启动时读取）。
   ⚠️ 从这一步到第 4 步之间，任何**新启动**的 pod（重启、HPA 扩容）会以 integration 模式读到 live key 而拒绝启动；
   旧 pod 继续服务。所以 2→4 请一次做完，不要隔夜。
3. **跑检查 Job**（API 和 worker 各一次），直到两边都是 ✓。
4. **合并切换 PR**（把 manifest 里的 `RUN_MODE` 改为 `production`、去掉 `DEV_AUTH_SECRET` 挂载）。部署流程会：
   跑迁移 → 滚动发布（新 pod 起不来时旧 pod 继续服务，部署失败）→ 健康检查 → 「Write the price catalogue」把 live price id
   写进 `product_catalog` 并逐项与 Stripe 比对，不一致则部署失败。
5. **验收**：
   - `curl https://yuha.studio/v1/runtime` 应为 `mode: production`、`payments: stripe`、`cardPaymentsEnabled: true`（该字段来自 lth2015/yuha#3）；
   - 用自己的卡买一次 DROP（¥980），确认：跳转到 Stripe 页面 → 回到完成页 → 额度 +5 → Stripe 后台该 webhook 投递为 2xx；
   - 在 Stripe 后台退款，确认订单变为已退款、额度被收回；
   - 如开放订阅：订阅 CREATOR，再在「账单」页取消，确认 Stripe 侧订阅为「到期取消」。

## 回滚

回退切换 PR（`RUN_MODE` 回到 integration）时，**同时**把 ConfigMap 的 `PAYMENTS_ADAPTER` 改回 `simulated`、
把 secret 的 `STRIPE_SECRET_KEY` 换回非 live 值——integration 模式见到 `sk_live_` 会拒绝启动。

## 收款之前还没解决的

法务页面全部带着「Draft — pending legal review」横幅（`apps/web/src/pages/Legal.tsx` 的 `LEGAL_TEXT_REVIEWED = false`）。
正式收款前应由律师确认条款，并在同一个提交里把它改为 `true`。
