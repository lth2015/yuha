# YUHA 配置指导（你需要配置什么）

所有配置集中在根目录 **`.env`** 一个文件（模板见 `.env.example`，复制后填写）。
本文按「什么时候需要配」分类；**本地演示零配置即可跑通全流程**（合成音频 + 模拟支付 + 开发登录）。

```bash
cp .env.example .env   # 然后按需填写下表中的值
```

---

## A. 本地演示必配（2 个随机串）

| 变量 | 填什么 | 生成方式 |
|---|---|---|
| `DEV_AUTH_SECRET` | 任意 32+ 位随机串 | `openssl rand -hex 32` |
| `STORAGE_SIGNING_SECRET` | 任意 32+ 位随机串 | `openssl rand -hex 32` |
| `DATABASE_URL` | 本地 MySQL 连接串 | 默认值已适配 `pnpm db:up` 的容器，一般不用改 |

其余全部留空 = demo 模式：合成音频、模拟支付、开发登录（`creator@example.jp` 等演示账号）。

---

## B. 接入真实能力（按需，填一个通一个）

### B1. Google 登录（推荐第一个接）

| 变量 | 从哪里拿 |
|---|---|
| `GOOGLE_CLIENT_ID` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → 创建 **OAuth 2.0 客户端 ID（Web 应用）** |
| `GOOGLE_CLIENT_SECRET` | 同上，创建时生成，只显示一次 |
| `GOOGLE_REDIRECT_URI` | 固定填 `http://localhost:4000/v1/auth/google/callback`（本地）；**必须与控制台里登记的「已获授权的重定向 URI」一字不差** |
| `GOOGLE_SESSION_SECRET`（生产必填） | `openssl rand -hex 32` |

配置后登录页自动出现「使用 Google 继续」按钮；MFA（Google Authenticator 两步验证）在 账户设置 → 两步验证 中扫码开启，无需额外配置。

### B2. 音乐生成（GLM / 其他供应商）

| 变量 | 说明 |
|---|---|
| `MUSIC_API_KEY` | 你的 GLM（智谱 bigmodel）API Key |
| `MUSIC_MODEL` | 模型 ID，按你开通的文档填（如 `glm-music-01`，留空用预设） |
| `MUSIC_BASE_URL` / `MUSIC_SUBMIT_PATH` / … | 端点细节全部可覆盖；预设按文档默认，拿到接口文档后核对一遍即可 |

启用方式：取消 `MUSIC_ADAPTER=glm` 的注释并填 Key。**替换为任意其他供应商**：改回 `MUSIC_ADAPTER=http` 并按其文档填 `MUSIC_SUBMIT_PATH / POLL_PATH / REQUEST_ID_FIELD / STATUS_FIELD / AUDIO_URL_FIELD / STATUS_MAP / ALLOWED_AUDIO_HOSTS`。

### B3. 文本模型（TokenStars / GPT）

| 变量 | 说明 |
|---|---|
| `TOKENSTARS_API_KEY` | TokenStars 控制台的 `sk-…` |
| `TOKENSTARS_MODEL_ID` | 文档里的模型 ID（示例用 `gpt-5.4-nano`） |
| 其余 `TOKENSTARS_*` | 默认已按文档（`https://www.tokenstars.ai/v1/chat/completions`） |

启用：`TEXT_ADAPTER=tokenstars`。GPT 负责「AI 再创作」改写与歌词；不填则用本地规则（demo 可用）。

### B4. 歌词词级对齐（可选）

`ALIGNMENT_ADAPTER=estimated`（默认，界面如实标注「估算同步」）。接入真实对齐模型时切 `http` 并填 `ALIGNMENT_*` 字段映射（`LINES_FIELD / LINE_TEXT_FIELD / LINE_START_FIELD / LINE_END_FIELD` 为必填）。

### B5. Stripe 支付（test mode 即可验收）

| 变量 | 从哪里拿 |
|---|---|
| `STRIPE_SECRET_KEY` | [Stripe Dashboard](https://dashboard.stripe.com/test/apikeys) → Secret key（`sk_test_…`） |
| `STRIPE_WEBHOOK_SECRET` | Stripe CLI：`stripe listen --forward-to localhost:4000/v1/webhooks/stripe` 输出的 `whsec_…` |
| `STRIPE_PUBLISHABLE_KEY` | 同页 Publishable key（`pk_test_…`） |
| `STRIPE_PRICE_ID_DROP_5` / `_PRO_MONTHLY` / `_PREMIER_MONTHLY` / `_MARKET_LICENSE` | 在 Stripe 后台建 4 个价格，金额与 `apps/api/src/seed.ts` 的目录一致：DROP ¥980 一次性 / CREATOR（`pro_monthly`）¥1,980 月 / STUDIO（`premier_monthly`）¥3,980 月 / Licence ¥980 一次性。JPY 是零小数货币，Stripe 的 `unit_amount` 直接写 980，不要乘 100。把 `price_…` 填进来 |

启用：`PAYMENTS_ADAPTER=stripe`、`RUN_MODE=integration`。Webhook 事件至少订阅：`checkout.session.completed`、`invoice.paid`、`customer.subscription.updated`、`customer.subscription.deleted`、`charge.refunded`。

---

## C. 生产上线（AWS）必配清单

部署手册见 `docs/DEPLOY_AWS.md`（Terraform + Helm 全流程）。生产模式会在启动时**强制校验**以下各项，缺一个直接拒绝启动：

- `RUN_MODE=production`、`DATABASE_SSL=true`
- `AUTH_ADAPTER=google` 或 `cognito`（**dev 登录在生产被禁用**）+ `GOOGLE_SESSION_SECRET`
- `MFA_ENCRYPTION_SECRET`（`openssl rand -hex 32`，与其它 secret 不同值）
- `STRIPE_SECRET_KEY` 必须是 `sk_live_…`
- `STORAGE_ADAPTER=s3` / `QUEUE_ADAPTER=sqs`（桶与队列由 Terraform 输出）
- `MUSIC_COMMERCIAL_DELIVERY=true` **仅在签署供应商协议后**开启
- `LEGAL_ENTITY_NAME / ADDRESS / CONTACT`（真实事业主体信息，NetStars 由配置提供）

---

## D. 前端（apps/web）

| 变量 | 说明 |
|---|---|
| `VITE_API_URL` | API 地址。不设时走同源 `/v1`：开发环境由 `apps/web/vite.config.ts` 的代理转给 `http://localhost:4000`，部署时必须设为公网 API 域名——除非 CDN／反向代理已把 `/v1` 转给 API（当前 CloudFront 只有 S3 一个源，没有这条规则）。`vite build` 在未设置时会打印一行提醒 |
| `VITE_DEV_API_PROXY` | 仅开发环境：上面那个代理的目标地址，默认 `http://localhost:4000`。API 换端口或跑在容器里时用 |

界面语言：右上角 中 / 日 / EN 切换（记住选择）；默认跟随浏览器语言。品牌三语标语——zh「让心动，有回声。」/ ja「ときめきに、響きを。」/ en「Let a feeling echo.」

---

## E. 快速自检

```bash
pnpm bootstrap          # 安装 + 音频 fixtures + 数据库 + 迁移 + 种子
pnpm dev                # 起服务，打开 http://localhost:5173
curl localhost:4000/v1/runtime   # 看 adapters 一栏确认哪些是 real、哪些还是 demo
```

`/v1/runtime` 的 `adapters` 字段是事实来源：`google` / `glm` / `stripe` / `s3` 表示已接真，`dev` / `demo` / `simulated` 表示该项仍在演示态。
