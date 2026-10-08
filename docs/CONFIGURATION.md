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
| `GOOGLE_REDIRECT_URI` | 本地填 `http://localhost:4000/v1/auth/google/callback`；部署时填 `https://<该环境的 API 域名>/v1/auth/google/callback`。**必须与控制台里登记的「已获授权的重定向 URI」一字不差**（Google 是逐字节比对，多一个斜杠就算另一个 URI），而且必须是 **API 的路径**，不是前端的 `/auth/google/callback`——那条路由也真实存在（是 API 拿到一次性 code 之后把浏览器送回去的地方），所以最容易填错。填错时 Google 在它自己的页面上报 `redirect_uri_mismatch`，请求根本到不了我们这边：没有日志、没有失败的登录记录，只有地址栏里那一行。因此启动时会校验路径、协议，以及 origin 是否和 `PUBLIC_API_URL` 一致，不对就拒绝启动 |
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
| `STRIPE_WEBHOOK_SECRET` | Stripe CLI：`stripe listen --forward-to localhost:4000/api/webhooks/stripe` 输出的 `whsec_…`。必须是 `whsec_` 开头的 endpoint signing secret，启动时会校验前缀（不会打印值） |
| `STRIPE_PUBLISHABLE_KEY` | 同页 Publishable key（`pk_test_…`） |
| `STRIPE_PRICE_ID_DROP_5` | Stripe 里的 **「DROP — 5 songs」**，¥980 一次性 |
| `STRIPE_PRICE_ID_PRO_MONTHLY` | Stripe 里的 **「CREATOR — 15 songs / month」**，¥1,980 每月。注意变量名是内部 price key（`pro_monthly`），和控制台显示的 CREATOR 不是一个词 |
| `STRIPE_PRICE_ID_PREMIER_MONTHLY` | Stripe 里的 **「STUDIO — 45 songs / month」**，¥3,980 每月。同上，内部叫 `premier_monthly` |
| `STRIPE_PRICE_ID_MARKET_LICENSE` | Stripe 里的 **「Licence — one song」**，¥980 一次性 |
| `STRIPE_API_VERSION` | 固定为 `2025-03-31.basil`。不填时用 SDK 自带的版本（现为 `2025-02-24.acacia`），而 webhook 的 payload 形状依赖它——升一次依赖就会悄悄改变线上事件的结构。启动时校验格式，低于 `2025-03-31` 直接拒绝；生产模式不填也拒绝 |

JPY 是零小数货币，Stripe 的 `unit_amount` 直接写 980，不要乘 100。

**命名对不上这件事，靠校验而不是靠记性。** 变量名来自内部 price key，Stripe 控制台显示的是营销名，两套词不一样，而 CREATOR 和 STUDIO 又只差价格——填反是很自然的手误，代价是客户买 STUDIO 被扣 ¥1,980（Checkout 按 Stripe 的 Price 收，订单行里记的是目录金额，webhook 的金额校验会在**扣款之后**才抛错）。所以 `pnpm seed` 和 `pnpm check:stripe-prices` 会把每个 Price 读回来，比对金额、币种、计费周期（含 `interval_count`）、含税方式和是否 active，不一致就拒绝；两个变量填了同一个 id、或两个 id 其实属于 Stripe 里同一个 product，也会单独点出来。

**改了价格 id 之后必须重新 seed。** Checkout 读的是 `product_catalog.stripe_price_id`（`getActiveProduct` → `createCheckout`），**不是**环境变量;而写这一列的只有 `pnpm seed`。所以「改 ConfigMap、滚 pod」这条路只动了变量、没动数据库,每一笔结账仍然用旧的 Price——客户被按旧价扣款,订单行里记的是目录金额,webhook 的金额校验在扣款之后才抛错。`pnpm check:stripe-prices` 现在会把这一列和配置一起比对,不一致就报 `stale` 并要求 `pnpm seed`;在加这个比对之前,它会在这种情况下打四个勾。

**但要说清楚它到底保证了什么。** 这两个都是**人去跑的命令**：CI 不跑（CI 没有线上 Stripe key），pod 启动也故意不跑（第三方超时不该拦住一个本来正常的部署），而改价格 id 的实际发布路径是「改 ConfigMap、滚 pod」——两个都不经过。所以这是一道**有人跑就能抓住**的检查，不是「填反了发不出去」。改价格 id 之后请手动跑一次 `pnpm check:stripe-prices`。

内部 price key 没有跟着改名，因为它是 `product_catalog` 的主键、也是 `orders` / `subscriptions` 的外键——那是一次数据迁移，而且改完也只是降低手误概率。

启用：`PAYMENTS_ADAPTER=stripe`、`RUN_MODE=integration`。Webhook 的路径、要勾的 14 个事件、payload 格式与 API 版本见 [STRIPE_WEBHOOK.md](STRIPE_WEBHOOK.md)——那份是唯一的清单，这里不再抄一份会和它漂移的短名单。

### B6. 运营台的额度上限（都有默认值，不填也能跑）

发放额度和补偿额度都是真金白银——一个 credit 就是一次生成，也就是供应商成本。下面六个键是唯一能限制它们的东西，之前**只有代码默认值、没有任何部署入口**（Helm 的 ConfigMap 是写死的清单，没有透传），现在 ConfigMap、`values.yaml`、`deploy/envs/*.yaml` 和 `.env.example` 都有了。

| 变量 | 默认 | 含义 |
|---|---|---|
| `ADMIN_GRANT_MAX_UNITS` | 100 | 单次赠予上限。**0 = 完全关闭赠予功能** |
| `ADMIN_GRANT_MAX_UNITS_PER_DAY` | 500 | 每个运营**每人**滚动 24 小时的赠予总量。**0 = 取消这个上限**（注意和上面那个 0 的含义相反） |
| `ADMIN_GRANT_VALIDITY_DAYS` | 90 | 赠予额度的有效期天数，也是运营可以往下调的上限。必须 ≥ 1 |
| `ADMIN_COMPENSATION_MAX_UNITS_PER_DAY` | 2000 | 补偿的每人每日总量。**0 = 取消**。比赠予宽，因为真出故障时要一次补很多人；补偿单次本来就封顶 20 |
| `PURCHASE_CAP_JPY_PER_DAY` | 50000 | 单个客户滚动 24 小时的购买金额上限（分）。**0 = 取消** |
| `PURCHASE_CAP_ORDERS_PER_DAY` | 20 | 单个客户滚动 24 小时的下单次数上限。**0 = 取消** |

负数会在启动时被拒绝，并且报错信息会说清楚这个键的 0 是「关闭功能」还是「取消上限」。

---

## C. 生产上线（AWS）必配清单

部署手册见 `docs/DEPLOY_AWS.md`（Terraform + Helm 全流程）。生产模式会在启动时**强制校验**以下各项，缺一个直接拒绝启动：

- `RUN_MODE=production`、`DATABASE_SSL=true`
- `AUTH_ADAPTER=google` 或 `cognito`（**dev 登录在生产被禁用**）+ `GOOGLE_SESSION_SECRET`
- `MFA_ENCRYPTION_SECRET`（`openssl rand -hex 32`，与其它 secret 不同值）
- `STRIPE_SECRET_KEY` 必须是 `sk_live_…`
- `STORAGE_ADAPTER=s3` / `QUEUE_ADAPTER=sqs`（桶与队列由 Terraform 输出）
- `MUSIC_COMMERCIAL_DELIVERY=true` **仅在签署供应商协议后**开启
- `TRACK_RETENTION_DAYS=90` 歌曲被作者删除后，音频还保留多久可恢复；到期由 worker 的 maintenance 循环真正删除存储对象。处于未结权利申诉、或已被他人购买授权的歌不受影响。设 0 表示永不删除
- `MUSIC_ALLOW_INSECURE_SELF_HOSTED=true` 只用于自托管模型服务器（局域网 GPU 机器，地址形如 `http://192.168.x.x:8000`）。它关掉的是音频抓取的 https 检查和私有地址检查，且只对已经写进 `MUSIC_ALLOWED_AUDIO_HOSTS` 的 host 生效。`loadConfig` 在 `RUN_MODE=production` 下直接拒绝这个开关
- `LEGAL_ENTITY_NAME / REPRESENTATIVE / ADDRESS / CONTACT / PHONE`（真实事业主体信息，
  由配置提供，代码里没有任何默认值可以冒充它）。运营主体是个人事业主 **<redacted: operator name>**
  （`redacted-operator@example.invalid` / <redacted: operator phone>）。五个字段都在那里（住所：<redacted: operator address>，2026-10-02 补齐）。
  注意：填满这五项只是让「事业主体」不再是占位符，**不代表条款已经过法务审阅** ——
  那由 `Legal.tsx` 的 `LEGAL_TEXT_REVIEWED` 常量决定，见 `docs/OPEN_ITEMS.md` §4。
  生产模式在 NAME / ADDRESS / CONTACT 任一为空时拒绝启动（SEC-13）。

**按账号的购买上限**（可选,有默认值,不配也会生效）:

- `PURCHASE_CAP_JPY_PER_DAY`（默认 `50000`）滚动 24 小时内**已付**金额上限
- `PURCHASE_CAP_ORDERS_PER_DAY`（默认 `20`）滚动 24 小时内**新建**订单数上限

两个数字针对的是两种不同的滥用:盗刷成功是**金额**(单数少、每笔都是真钱),
测卡是**次数**(大量尝试、几乎都失败,所以金额上限看不到它)。任一设 `0` 即关闭。
默认值刻意宽松——¥50,000 一天是五十个 DROP 包,真实客户到不了而盗卡者会到;
挡住真实购买本身也是一种失败。被挡住的真实客户由操作台直接发放次数来补偿,
那条路径不走订单、因此不受上限约束,且有审计行和经手人。
实现在 `apps/api/src/services/purchase-cap.ts`,三个下单入口共用;
`tests/purchase-cap.test.ts` 里有一条脚本化不变量,保证 `apps/api` 里除它之外
不得直接调用 `insertOrder`——否则新加的购买入口会静默绕过上限。

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
