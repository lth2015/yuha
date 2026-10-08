# YUHA 部署到 AWS 生产环境 — SRE 任务清单

面向大连 SRE 团队。QA 环境的清单在 [DEPLOY_QA_CN.md](DEPLOY_QA_CN.md)，英文细节
在 [DEPLOY_AWS.md](DEPLOY_AWS.md) 和 [../deploy/runbook.md](../deploy/runbook.md)。

---

## ⛔ 先读这一段：**今天不能部署生产，而且这是设计如此**

这不是脚本没写好，也不是哪一步漏了。是三件事同时成立：

1. **`deploy/envs/production.yaml` 的第一段注释就写着**：本文件今天无法部署。
   因为没有签署音乐服务商协议，`music.adapter` 仍然是 `demo`，而生产模式
   **拒绝用假音乐适配器启动**。卖合成音频正是这个拒绝要防止的事。

2. **[LAUNCH_READINESS.md](LAUNCH_READINESS.md) 的结论是「尚未具备收费条件，而且
   差得远」**，其中五节标着 BLOCKED：音乐版权、经营主体与法务、支付、基础设施
   账号、成本模型。

3. **这些阻塞项没有一项是 SRE 能解决的。** 它们是商务合同和法律审查。

> 所以这份清单的用途是：**当上述阻塞解除后**，技术侧按什么顺序执行；以及
> **现在就能做的**——在 QA 上把生产形态彩排一遍，把属于 SRE 的那部分风险提前
> 消化掉。请不要把它读成"照着做就能上线"。

### 不是 SRE 的阻塞项（给运营方和业务方）

| 阻塞 | 现状 |
| --- | --- |
| 音乐服务商企业/OEM 协议 | ✗ 未签署 —— 一切商业化的前提 |
| 面向消费者的条款、隐私政策的日本律师审查 | ✗ 仅草稿，UI 上已标注为草稿 |
| 经营主体确认 | ✗ 未确认 |
| 预付额度是否属于 **前払式支払手段** | ✗ 未裁定 —— **结论可能改变产品形态** |
| 退款政策与 資金決済法 / 特商法 / 消费者法的对齐 | ✗ 仅草稿 |
| 真实成本数据（目前是保守假设值） | ✗ 仅假设 |

详见 LAUNCH_READINESS.md 第 8 节「工作顺序」：**1 音乐协议 → 2 法务审查 →
3 真实成本 → 4 账号 → 5 工程缺口 → 6 产品验证**。在 1–3 完成之前，这个项目
不得被对外报告为"可以收费"。

---

## 1. 生产与 QA 的技术差异

这部分是 SRE 最需要知道的。Terraform 只在 `environment == "production"` 时分叉：

| 项目 | QA / staging | 生产 |
| --- | --- | --- |
| EKS API 端点 | 公开 | **私有** |
| 部署 runner | GitHub 托管 `ubuntu-latest` | **必须自建 runner**（见 2.1） |
| RDS | 单 AZ，备份 3 天 | **Multi-AZ**，备份 14 天 |
| NAT 网关 | 单个（省钱） | **每 AZ 一个** |
| Secrets Manager 恢复窗口 | 0 天（立即删除） | **30 天** |
| EKS 节点组 | min/desired = 1 | min/desired = 2 |
| 删除保护 | 关 | **开** —— `terraform destroy` 会被拒绝 |
| 触发方式 | 手动 `workflow_dispatch` | **推送 `v*` 标签**，或手动选 production |
| Stripe 密钥 | `sk_test_…` | **必须 `sk_live_…`**（见下） |

### 1.1 自建 runner 是硬性前提

生产的 EKS 端点是私有的（`compute.tf:17`），**GitHub 托管的 runner 连不上**。
`deploy.yml` 已经为此做了防护：如果仓库变量 `DEPLOY_RUNNER_PRODUCTION` 为空，
它会**立刻报错并说明原因**，而不是在几分钟后超时失败、看起来像一次故障。

- [ ] 在 VPC 内部署一台自托管 runner（EC2 或 EKS 上的 ARC）
- [ ] 它需要能访问私有 EKS 端点
- [ ] 把它的 label 填进仓库变量 `DEPLOY_RUNNER_PRODUCTION`

---

## 2. 启动时的生产门禁（可提前自查）

`loadConfig` 在 `RUN_MODE=production` 下会**逐条检查并拒绝启动**。这份列表可以
在部署前当 checklist 用，不必等 Pod 崩了再看日志：

- [ ] 认证适配器**不是** `dev`
- [ ] 音乐适配器**不是** `demo` ← **当前被这条挡住**
- [ ] 支付适配器**是** `stripe`（不能是模拟）
- [ ] 存储**是** `s3`
- [ ] 文本适配器**是** TokenStars（AI-01）
- [ ] **`DEV_AUTH_SECRET` 必须不存在**（设了就拒绝启动）
- [ ] `GOOGLE_SESSION_SECRET` 已设置且**非空**
- [ ] Stripe 密钥**不是** `sk_test_` 开头
- [ ] `DATABASE_SSL=true`
- [ ] **`MUSIC_ALLOW_INSECURE_SELF_HOSTED` 必须不存在** —— 它会关掉 provider
      音频 URL 的 https 与私有地址检查（SEC-05）
- [ ] `LEGAL_ENTITY_NAME` / `LEGAL_ENTITY_ADDRESS` / `LEGAL_ENTITY_CONTACT`
      三项都非空且**不是占位值**（SEC-13，特商法披露）
- [ ] `MUSIC_COMMERCIAL_DELIVERY=true` 与 demo 音乐适配器**互斥**（SEC-09）。
      代码挡住的是「适配器是假的却声称商业交付」；签协议是这件事的业务前提，
      不是代码判断的对象

> 这些是有意设计成"大声失败"的。一个配错的发布**不会**半可用地跑起来。

---

## 3. 清单（阻塞解除之后）

### 阶段 0 — 前置条件

- [ ] 0.1 LAUNCH_READINESS.md 第 1、2、3 节已由业务方确认解除
- [ ] 0.2 QA 环境已完整跑通并稳定运行至少数日（见 DEPLOY_QA_CN.md）
- [ ] 0.3 生产 AWS 账号（**与 QA 分开的账号**，不是同账号不同环境）
- [ ] 0.4 生产域名 + Route 53 托管区 + **ap-northeast-1** 的 ACM 证书
- [ ] 0.5 Stripe **生产**账号已完成商户审核，拿到 `sk_live_…`、`whsec_…`
      和四个生产 price id
- [ ] 0.6 Google OAuth 生产凭据，回调地址指向生产域名

### 阶段 1 — Terraform 状态后端

- [ ] 1.1 生产用独立的 state 桶与锁表（**不要和 QA 共用**）
- [ ] 1.2 `backend "s3"` 配置并 `terraform init`

### 阶段 2 — 基础设施

- [ ] 2.1 `terraform plan -var environment=production -var-file=production.tfvars`
- [ ] 2.2 **逐项人工审阅 plan**。生产资源带删除保护，建错了不好拆
- [ ] 2.3 `terraform apply`
- [ ] 2.4 记录全部 output（同 QA 清单 2.5）
- [ ] 2.5 确认 RDS 确实是 Multi-AZ、确认删除保护已开

### 阶段 3 — 密钥

- [ ] 3.1 Secrets Manager 建 `loopscene-production/database`（属性 `url`，
      **连接串必须启用 SSL**）
- [ ] 3.2 建 `loopscene-production/app`，七个属性同 QA，但全部换成生产值
- [ ] 3.3 **确认 `DEV_AUTH_SECRET` 没有被写进任何一处**
- [ ] 3.4 `GOOGLE_SESSION_SECRET` 为随机 32 字节以上，且**确认不是空字符串**

> 2026-10-04 修了一个相关缺陷：键存在但值为空时，`??` 兜底接不住空串，会话会
> 用**空密钥**签名。生产模式的守卫能挡住（它用 `!` 判断），所以生产会拒绝启动
> 而不是悄悄不安全——但请在配的时候就填对，不要靠守卫兜底。

### 阶段 4 — 集群内

- [ ] 4.1 安装 External Secrets Operator
- [ ] 4.2 `deploy/cluster/external-secrets.yaml` 里 `__ENVIRONMENT__` 替换为
      `production` 后 apply
- [ ] 4.3 确认 `yuha-runtime` Secret 七个键齐全

### 阶段 5 — GitHub 侧

- [ ] 5.1 建名为 **`production`** 的 Environment
- [ ] 5.2 **配 Required reviewers** —— 生产部署应当有人工审批
- [ ] 5.3 仓库变量 `AWS_DEPLOY_ROLE_ARN` 指向生产账号的 OIDC 角色
- [ ] 5.4 仓库变量 **`DEPLOY_RUNNER_PRODUCTION`** 填自建 runner 的 label
- [ ] 5.5 确认整条流水线**没有任何静态 AWS access key**

### 阶段 6 — 填 production.yaml

- [ ] 6.1 填入阶段 2.4 的全部 Terraform 输出（项目同 QA 清单阶段 6）
- [ ] 6.2 `runMode` 改为 **`production`**
- [ ] 6.3 `music.adapter` 改为真实适配器 **（需协议签署后）**
- [ ] 6.4 `music.commercialDelivery` 设为 `true` **（需协议签署后）**
- [ ] 6.5 法务信息（entityName / representative / address / contact / phone）
      替换为**律师确认过**的正式内容
- [ ] 6.6 复核 `limits.*`：生产的日预算、并发数、限流是否仍然合适

### 阶段 7 — 发布

- [ ] 7.1 确认目标 commit 的 CI 为绿
- [ ] 7.2 打标签 `git tag v1.0.0 && git push origin v1.0.0`
      —— 推 `v*` 标签会触发生产部署
- [ ] 7.3 流水线会先跑完整 CI，再构建推镜像、按 digest 固定、`helm upgrade`
- [ ] 7.4 **数据库迁移由 Helm hook 执行**。生产首次迁移前请先确认 RDS 已有快照

### 阶段 8 — 发布后

- [ ] 8.1 全部 Pod Running，流水线末尾的服务可达性检查通过
- [ ] 8.2 用**真实卡**完成一次最小金额购买，确认额度到账、账本正确
      （这是 LAUNCH_READINESS 里 PAY-03 / PAY-12 要求"真的验一次"的部分）
- [ ] 8.3 Stripe 生产 webhook 指向生产域名，确认签名校验返回 200
- [ ] 8.4 确认监控告警已接通（`infra/terraform/monitoring.tf`，`alert_email`）
- [ ] 8.5 确认 CloudWatch 指标发布 —— **注意：这一项在 docs/OPEN_ITEMS.md
      中仍是未完成项**

---

## 4. 回滚与事故

- ECR 仓库是**不可变（IMMUTABLE）**的，重新部署同一 commit 不会覆盖镜像
- 回滚用 `helm rollback`，不要用"重新部署旧 tag"
- **迁移不会自动回滚。** 如果一次发布包含迁移，回滚前先确认该迁移是否向后兼容
- 详见 [../deploy/runbook.md](../deploy/runbook.md) 的 Rolling back 和
  「When production will not deploy」两节

---

## 5. 这份清单不覆盖的事

- 商务与法务阻塞项的解除（不是 SRE 的工作，见第 0 节）
- 真实刷卡扣款的完整验收（只在 Stripe 测试模式做过）
- S3 保留期清扫与账户删除作业在真实 S3 上的行为（代码完成，**未在 S3 验证过**）
- 容量规划与压测（LAUNCH_READINESS 记为未做）
- 真机读屏无障碍测试

---

## 6. 现在就能做的事

在等待阻塞解除期间，以下工作可以推进，并且会显著降低真正上线那天的风险：

1. **在 QA 上做一次"生产形态彩排"**：自建 runner、私有端点、Multi-AZ 都可以在
   QA 账号里先搭一遍，验证流程而不涉及真实金钱
2. **把 Terraform 状态后端配好**（两个环境都需要，且越早越好）
3. **验证监控告警链路**：`alert_email` 是否真的收得到
4. **演练一次回滚**：在 QA 上故意发一个坏版本，走完 `helm rollback`
5. **压测**：QA 环境足尺，可以在不花真钱的前提下得到容量数据

---

有任何一步卡住，请把**完整的 plan / 流水线日志**发回来。这套东西从未在真实
AWS 账号上执行过，上下文比结论有用。
