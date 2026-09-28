# YUHA 下一步任务清单

> **这是一份带日期的快照，不是权威文档。** 「还有什么没做」的权威来源是
> [`OPEN_ITEMS.md`](OPEN_ITEMS.md)。本文件恰恰是因为那份文档有 6 处与代码
> 相反才写出来的（见下面第 2 条）。等第 2 条做完、`OPEN_ITEMS.md` 与事实
> 对齐之后，**请删掉本文件**——否则仓库里会有两份互相矛盾的「待办」，
> 也就重演了本文件正在抱怨的那个问题。

**生成时间**：2026-09-28 10:20 JST
**仓库状态**：分支 `yuha`，HEAD = `26e7799`，工作区干净，已与 `origin/yuha` 同步。标签只有 `v0.1.0`。
**本地环境**：API / worker / web 与 MySQL 仍在运行。适配器：`payments: stripe`（真实沙盒）、`text: tokenstars`（真实密钥）、`music: demo-local`（模拟）、`auth: dev`。

本清单中每一条「现状」都是刚才跑命令或读数据库确认过的，不是沿用昨晚的记忆。标注「未核实」的地方就是真的没核实。

---

## 今天建议做的事（按优先级）

### 1. 走通订阅的真实支付 —— 建议今天第一件事

**现状（已核实）**：`subscriptions` 表 **0 行**。订单表里 `pro_monthly` 有 2 条、`premier_monthly` 有 1 条，**全部是 `pending`**，没有任何一条 `paid`。

**为什么是现在做**：昨天验收把一次性购买（DROP ¥980）的整条链路跑穿了——付款、webhook、发额度、退款、收回额度，全部对着数据库确认过。但订阅这一半**一次都没有对着真实 Stripe 跑过**。而订阅才是更大的生意假设（¥1,980 / ¥3,980 每月 vs ¥980 一次性）。

具体没验证的东西：`invoice.paid` → `subscription_period` 批次发放、期末失效不结转、取消后到期前仍可用，以及上周写的防重复订阅拦截 `SUBSCRIPTION_ALREADY_ACTIVE`（`apps/api/src/services/billing.ts`）——它**只有单元测试**，真实 Stripe 上从没触发过。订阅开关 `subscriptionsEnabled` 现在是 `true`，环境就绪，今天做成本最低。

**怎样算做完**：
- `subscriptions` 表出现 1 行 `status=active`，`current_period_end` 有值
- `entitlement_batches` 出现一条 `source='subscription_period'`，`granted_units` 等于该档位的额度（CREATOR 15 / STUDIO 45）
- 订阅状态下再点另一档的订阅按钮，API 返回 `SUBSCRIPTION_ALREADY_ACTIVE`，且 `orders` **没有**新增行
- 取消后 `cancel_at_period_end=1`，且额度到期末仍可用

---

### 2. 修正 `docs/OPEN_ITEMS.md`（半小时，价值高）

**为什么是现在做**：CLAUDE.md 明确写着「代码与之矛盾的 scope decision，比没有 decision 更糟」。这份文档现在有 6 处与实际情况相反，任何人（包括我）照着它做判断都会判断错。

已核实的 6 处偏差：

| 行 | 文档说 | 实际 |
| --- | --- | --- |
| 55 | TokenStars 缺 Base URL / API key / 模型 id，「AI-01 未验证」 | 已用真实密钥验证通过，`tests/tokenstars.test.ts` 12 条测试在跑 |
| 56 | Stripe 缺账号 / 测试密钥 / webhook secret / price id，「PAY-03、PAY-12 阻塞」 | 全部具备，端到端跑通，`webhook_events` 有 5 条 `processed` 且 `signature_verified=1` |
| 69 | 对比度「未测量」，UI-14 阻塞重设计 | `scripts/check-contrast.mjs` 每次都在测 8 个 token × 3 个背景面 |
| 75 | 订阅 checkout 未走通，因为「订阅默认关闭」 | 理由已失效：`subscriptionsEnabled=true`。**结论本身仍成立**（见第 1 条），但原因写错了 |
| 98 | §5「明确不做」里列着 **lyrics、vocals** | 与 CLAUDE.md「Full songs, with vocals」及 `vocalMode`（`packages/contracts/src/generation.ts:124`）正面冲突 |
| §3 | 「配置了 `DAILY_BUDGET_MINOR` 但没有代码在达到上限时拒绝生成」 | 已实现：`assertWithinDailyBudget` 在 `generation.ts:149` 被调用，抛 `BUDGET_EXCEEDED` |

**怎样算做完**：上述 6 行改完，并且 §2 的 AWS 一行重新核实过（见第 5 条）。

---

### 3. 用耳朵听一遍（5 分钟，只有你能做）

**现状（已核实）**：昨天无法验证。浏览器窗格没有音频输出设备——AudioContext 报告 `state: "running"`，但它自己的时钟在 2 秒墙钟时间里只推进 **0.006 秒**。只确认到 Chrome 把 MP3 解码到 `readyState 4`、`duration 180`，文件本身是 4,321,532 字节、192kbps、正好 180.000 秒的真 MP3。

**为什么是现在做**：这是核心承诺链条上**唯一**还没被任何方式验证过的一环，而且机器换了就能做。注意听的是「有没有声音、是不是 3 分钟、有没有人声」，**不是**听音乐好不好——现在是 `music: demo-local` 合成样本，不代表最终音质。

**怎样算做完**：在 `/song/:id` 点播放，听到声音且进度条走动；下载的 MP3 用本地播放器打开能放完。

---

### 4. 给 `BUDGET_EXCEEDED` 补一条测试

**现状（已核实）**：功能已实现并接入，但 `tests/` 里搜不到 `BUDGET_EXCEEDED`，**没有任何测试覆盖**。

**为什么是现在做**：这是唯一挡在「上游成本失控」前面的闸门，而它现在没有回归保护。顺手就能补，且第 2 条要改文档时正好需要确认它的真实状态。

**怎样算做完**：`pnpm test` 中出现一条断言——花费达到上限时创建生成返回 `BUDGET_EXCEEDED`，且**没有**产生额度预留（读 `ledger_entries` 确认，不是看返回值）。

---

### 5. 核实 AWS 到底 apply 了没有

**现状**：`docs/OPEN_ITEMS.md` §2 说 Terraform 只 `validate` 过、Helm 只渲染过，**什么都没 apply**。`deploy/` 目录存在（`cluster`、`envs`、`runbook.md`、`README.md`）。**这一条我没有核实**——没有 AWS 凭据，也不该替你去连你的账号。

**为什么是现在做**：如果确实没 apply，那么部署相关的一切（S3、SQS、监控、回滚、恢复）都还是纸面上的，这会影响你对「离上线还有多远」的判断。花几分钟确认，比继续猜有价值。

**怎样算做完**：能说出 `terraform state list` 有没有输出。

---

## 需要你拍板的（不是工程问题）

这些我不能替你决定，但都卡着后面的事：

- **展示名不一致**。商品目录、定价页、购买历史统一是 **STUDIO / CREATOR**，而 Stripe 规格书写的是 **PRO / PREMIER**（内部 key 也是 `premier_monthly` / `pro_monthly`）。用户看到的是 STUDIO / CREATOR。要不要统一？改哪边？
- **税码 `txcd_10000000`** 对这项服务是否正确——税务判断。
- **特商法**：`Checkout.tsx` 里还有 19 条文案挂在 baseline 上，`/legal/tokushoho` 上有 3 行「要法務確認」。
- **客户端错误上报的接收端**未定（`apps/web/src/lib/report.ts` 已经写好，但不知道往哪发）。
- `docs/OPEN_ITEMS.md` §4 的既有条目：退款政策、预付额度是否属于**前払式支払手段**、失效补偿天数、法人与条款隐私政策的占位符。其中「前払式支払手段」的结论**可能会改变产品形态**，建议早问。

---

## 暂不建议今天做

- **3DS 放弃场景**（`4000 0025 0000 3155`）——优先级低于订阅主路径，做完第 1 条再补。
- **给 `26e7799` 打标签**——建议等订阅验收完一起打，那时才是一个完整的「支付全链路已验证」节点。
- **`/setup-matt-pocock-skills`**（CLAUDE.md 提到 `docs/agents/*.md` 未生成）——不阻塞任何事。
- **OPEN_ITEMS §3 的其余零散欠账**：CloudWatch 指标未上报、`preview_10s` 客户端未 POST（已核实：只在 `packages/db/src/reporting.ts:235` 的查询里出现，客户端确实没发）、账号删除执行任务、软删除音轨的 S3 清理、屏幕阅读器测试。都是真的，但都不阻塞当前主线。

---

## 环境提醒

- **`.env` 有意不纳入 Git**。换机器需要重新配置 Stripe 密钥、TokenStars API key、Google OAuth 凭据。`whsec_` 用 `stripe listen` 输出的即可（按账号固定，不会每次变）。
- **额度现状**：`empty@example.jp` 因退款验证是 **0**，`creator@example.jp` 是 **12**。要做第 1 条订阅验收，用哪个账号都行——订阅会自己发额度。
- 启动：`pnpm install && pnpm db:up && pnpm dev`，webhook 转发另开一个终端跑 `stripe listen`。
