# YUHA 独立用户旅程审计 · 2026-11-24

任务：Claude / `YUHA-CL-20261124-010`，协作收件箱 [#88](https://github.com/lth2015/yuha/issues/88)。先交报告，不改运行代码。

## 基准与方法

- 固定源码基准：`31b1aee48cf437f639e78e0a419f7d8696ed847c`（PR #109）。审计分支 `codex/ux-audit-20261124`。
- 这是 **本地 demo 验收**，不是生产验收。没有读取生产用户、真实订单或钱包，没有真实支付、DGX 调用、合并、部署或修改生产开关。
- 真实 Chromium 浏览器交互，主视口 **390×844** 和 **360×780**，中文优先；日文、英文及 **1280×900** 桌面抽查。浏览器为 Linux Chromium 的触控/移动视口模拟，不是实机 iPhone/Safari。没有可用的共享桌面控制工具，本次采用项目 Playwright 和截图检查。
- 本地使用 dev auth、local-rules 文本、demo-local 合成音频、local storage/queue、simulated payments。测试账号为仓库的演示身份及新建的 `ux-…@example.test` 虚构账号。照片使用已有 `scene-photo` 目录中明确标注的合成 QA 图片和自有插画，没有真实人物照片。
- 主旅程开启本地进程的 `FEATURE_GUEST_TRIAL_ENABLED`、`FEATURE_PHOTO_VIDEO_ENABLED`、`FEATURE_FREE_TRIAL_ENABLED`，每新账号赠送 2 首；不编辑 `.env` 或已保存环境配置。
- 先独立走旅程，再读相关代码解释现象。截图中的歌曲、名字、报告号和订单均为本地演示数据。
- Claude 在任务中已指出草稿不清空、AI 再创作缺歌词帮助，并保留 `Home.tsx`、`Create.tsx`、`generations.ts` 的编辑权。下表明确标记已知项；本分支不编辑这些文件，也不应用 PR #110 的动作排列/照片预览改动。

## 发现

严重度：`blocks` = 此旅程无法继续且无可见恢复路径；`confusing` = 状态/文案不一致、需额外绕行；`polish` = 不影响完成的呈现问题。以下没有将演示模型的词曲质量、估算同步或无系统分享面板误记为产品缺陷。

| ID / 严重度 | 页面 / 流程 | 复现步骤 | 实际发生 | 应有行为 / 建议 | 证据与归属 |
| --- | --- | --- | --- | --- | --- |
| UX-01 · confusing | 试做 → 注册 → 接受认领 | 游客从首页生成；在歌曲页点「注册并保存」；用新演示账号注册；在认领提示中点「加到我的账户」 | 提示「已加到你的账户」，但当前同一歌曲页仍显示「没有找到 / 可能已被删除」。进入作品列表后可以找到并打开该歌，归属实际已成功 | 认领完成后刷新该歌曲的数据/错误状态，或直接进入已认领的歌曲；不要把成功认领与“可能已删除”同时展示 | [截图](visual-previews/ux-audit-20261124/04-claim-success-not-found-390.png)。`TrialClaimAsk.tsx` 成功后只刷新 me/额度；`SongDetail.tsx` 的 load 依赖 id，不会因这次归属变化重新读取。新发现，不改代码 |
| UX-02 · confusing | 试做 → 注册 → 拒绝认领 | 另一独立游客生成后点注册；提示中选「不用了」 | 本机试做凭据按设计被忘记，但地址仍是原私密试做歌曲，立刻留下「没有找到」。作品列表为空，歌并未被加到账户 | 明确说明未加入及后续保留规则，导航到作品列表或首页等有效地址；拒绝是用户选择，不应呈现成找歌失败 | [360 截图](visual-previews/ux-audit-20261124/15-decline-not-found-360.png)。同一认领交接边界的另一分支；新发现 |
| UX-03 · confusing · 已知项 | 成功生成 → 再次创作 / 草稿生命周期 | 工作室填描述、歌词、标题与赠言，成功生成；从作品列表再进 `/create`。首页成功生成后也返回首页 | 工作室仍带回上一首的描述、标题和歌词；首页仍带回已生成的文字。完成页主要有打开歌、分享和作品列表，没有明确的成功后「重新来一首」入口。工作室手动清空并确认后可以清空 | 规定成功提交/完成后的草稿消费边界；失败时保留，成功后给出清晰的新创作入口，避免把旧内容当成未完成草稿 | [完成页](visual-previews/ux-audit-20261124/08-studio-delivered-390.png)、[返回工作室](visual-previews/ux-audit-20261124/23-completed-studio-draft-360.png)、[首页](visual-previews/ux-audit-20261124/14-home-draft-after-delivery-390.png)。Claude 已声明在修，本次为独立复核，不重复提出实现 PR |
| UX-04 · confusing | 首页 → 作品列表 → 首页 | 输入描述，选择「纯音乐」，去作品列表，再返回首页 | 描述仍在，但「纯音乐」被取消，回到默认「含人声」。继续按生成会得到与离开前选择不同的声乐模式 | 同一未提交草稿应同时保留描述与关键创作选择，或明确提示哪些设置重置，不只保存文字 | [360 截图](visual-previews/ux-audit-20261124/22-home-vocal-reset-360.png)。日志记录 `instrumentalPressed: false` 且描述保留。`Home.tsx` 仅保存 prompt，instrumental 初始化 false；该文件属于 Claude 编辑范围 |
| UX-05 · confusing | 工作室 → 歌词日配额耗尽 | 使用已达到歌词草稿配额的演示账号，重新进入工作室后点「先写三版歌词看看」 | API 因 24 小时草稿上限拒绝；页面只说「请求太频繁」「稍等片刻再试；同时进行的生成数量有上限」，按钮也未解释歌词日配额已不足 | 区分歌词配额与生成并发限制，显示剩余/所需草稿数和适当恢复说明；跨页面重新挂载也应能表达额度不足，不引导短时间反复重试 | [截图](visual-previews/ux-audit-20261124/07-lyric-quota-message-390.png)。默认 `LYRIC_DRAFTS_PER_DAY=10`；`routes/lyrics.ts` 抛出带 limit/needed 的 RATE_LIMITED；中文通用提示把原因解释成并发。不是因为没有生成额度 |
| UX-06 · confusing · 已知项 | 歌曲 → AI 再创作 | 打开自有人声歌，点「AI 再创作」 | 进入 `/create?edit=`，只有「要改哪里」文本框及生成/放弃，没有可编辑歌词、三版歌词或逐行帮助。普通工作室中的这些工具在该入口全部消失 | 复用合适的 AI/歌词辅助，或明确区分“只写修改指令”的限制并提供可回到歌词编辑的入口，不让同一创作能力在再创作时突然缺席 | [截图](visual-previews/ux-audit-20261124/13-recreate-no-lyric-tools-390.png)。实际工具节点数 0；Claude 已声明在修，未评价未发布修复效果 |
| UX-07 · confusing · 仅本地 demo 已确认 | 播放 → 跳到歌词后段 / 拖动进度 | 演示歌开始播放后，点击较后的歌词行，或把进度控制移向后段/末尾 | 在本次 Chromium/local-storage 组合中，播放时间回到约 0–1 秒，未可靠跳到选定段落；不能完成后段歌词跟随验收。对同一音频发 Range bytes=1000-1999，得到 200、全长 1,441,521 bytes，无 Content-Range/Accept-Ranges | 本地媒体交付应支持浏览器可靠 seek；先核实 Range 支持及播放器事件，补本地媒体交互回归。不能由此断言生产 S3 也有同样问题 | `routes/files.ts` 直接发送完整 Buffer，未处理 Range；`coverage-results.json` 保留交互及响应头观测，未包含签名 URL。该路由只在 local adapter 注册，生产需另验 |
| UX-08 · polish / 可访问性 | 歌曲播放按钮暂停状态 | 在同一歌页播放，再暂停，检查按钮的可见文字及读屏名称 | 可见文字「试听」、播放三角图标，但 aria-label 为「暂停」；读屏用户得到与下一步动作相反的名称 | aria-label 与可见文字/playing 状态一致，不以“当前选中这首歌”代替“正在播放” | `SongDetail.tsx:464` 按 active 计算 label，正文/图标却按 playing 计算；实际 DOM 观测为 text=试听、ariaLabel=暂停，记录于 `coverage-results.json` |

本轮复现的主链路均可通过可见导航或重新打开页面恢复，没有确认到无任何恢复路径的 `blocks` 问题。不能据此断言所有未测组合均无阻断。

## 旅程覆盖及实际结果

| 范围 | 本轮操作和结果 | 边界 |
| --- | --- | --- |
| 初访 / 游客试做 | 中文首页写描述；年龄与条款各自勾选后按钮可用；真实提交并取得 60 秒演示歌；等待途中离开作品入口再回首页，恢复生成状态并到达歌曲；「我的试做」可返回歌曲 | 没有真实 GPU 或演唱质量判断；首页普通歌曲 2 分钟与试做 1 分钟有分开说明 |
| 认领 yes/no | 两个独立游客分别测试，新账号认领后有作品、剩余 1 次；拒绝时账号作品为空且忘记本机 guest 凭据 | UX-01/02 的落地页状态不连贯；没有尝试读取其他账号的数据 |
| 登录 / 退出 / consent | 通过页面登录 `creator@example.jp`，账户菜单退出，确认登录入口恢复；另用合成的 `GET /v1/me` 未确认状态显示 ConsentGate，按钮最初禁用，勾选后真实 POST 确认并消失 | ConsentGate 的初始未确认状态为浏览器响应夹具；不代表验证了真实 Google OAuth |
| 首页例子和声乐模式 | 自己输入后点 mood 保留原文字；清空后点另一 mood 会填入例子；选择纯音乐实际生成另一首 120 秒演示歌 | UX-04 的跨页选择丢失；不把 demo 的合成音频当成真实无歌词/有人声验收 |
| 工作室参数与重载 | 实际操作时长 0:30/1:00、女声、预设和自定义风格、自己的歌词、插入副歌、能量、可见性、生日赠言；重载后设置保留。记录包含 female、30 秒、acoustic/soft rock、energy 0.85、public | 没有穷举所有时长 × 风格 × 声部组合 |
| 三版歌词 / 单行改写 | 新演示账号取得三张不同角度卡，选择一版落入自己的歌词框；在行上定位并取得 3 个替代，选择后仅替换该行；实际用该歌词生成完成 | 仅验证 local-rules 工程交互，不评价 TokenStars 的质量、拒绝或超时行为 |
| 草稿 / 失败 / 再试 | 未提交草稿重载保留；手动「清空草稿」取消时不变、接受确认后清空。通过 demo fault marker 生成可控技术失败：显示额度已退回、任务号和重试入口；重试回填原描述 | 失败是明确的本地 fault injection；不是生产故障证据。成功后的问题见 UX-03 |
| 播放 / 同步歌词 | 通过播放按钮，页面计时推进到 0:02，播放器可暂停；人声歌曲歌词显示估算同步及调时入口；LRC 实际下载成功 | 未实际听完歌曲；没有确认真人演唱/漏字/音质或真实 alignment 精度；后段 seek/跟随验收受 UX-07 影响，不能标为通过。估算同步标注准确 |
| 改名 / MP3 / 发布 | 改名并保存；浏览器下载 MP3；ffprobe 读取音频 60.029 秒、1,441,521 bytes。先收回链接，独立游客访问被拒；再公开后游客可打开 | 首次点击后立即读文本的瞬态值没有作为结论；正式结果以等待按钮变化及 API private 状态为准 |
| 访客 / 收歌人 | 360 宽独立无登录浏览器看到生日称呼和赠言，未显示改名/删除/主人 MP3 按钮；「我也写一首」带 birthday 和 share-birthday 来源 | 未使用真实收件人或真实共享链接；不声称验证了社交平台抓取器 |
| 分享链接 / 卡片 / 视频 | 分享菜单显示链接及本地地址提示；实际服务端分享卡 PNG 返回 200；制作分享视频，浏览器取得 MP4 | 系统原生分享面板、Clipboard 权限、X/LINE/Facebook 发布未验证；卡片见 [合成示例](visual-previews/ux-audit-20261124/share-card-demo.png) |
| 照片 MV | 未勾权利确认时 file input 禁用；勾选后选择 3 张合成素材；真正发请求合成、预览并下载。ffprobe：30.000 秒，720×1280，H.264/AAC，4,501,708 bytes | [390 视口预览](visual-previews/ux-audit-20261124/12-photo-preview-viewport-390.png)中视频高约 533 px、下载可见。没有把 PR #110 尚未应用的高度调整当成本轮已验收；真实 EXIF/手机 HEIC/原生文件选择器/系统分享面板未测 |
| 报告问题 / 删除 | 提交虚构「其他」问题，页面出现报告号和记录；对另一首本次新建的歌曲，先取消删除确认，仍留在原页；再确认删除，进入作品列表，GET 该歌为 404 | 未提交真实客户工单，不删除预置歌曲；[删除后](visual-previews/ux-audit-20261124/24-library-after-delete-360.png) |
| 无额度 → 价格 → checkout | 两首免费歌用尽后首页禁止再次生成并给获取额度入口；真实走 DROP 模拟付款，勾选前支付禁用，模拟成功后 0→5 次 | [确认](visual-previews/ux-audit-20261124/17-checkout-confirm-390.png)、[完成](visual-previews/ux-audit-20261124/18-checkout-complete-390.png)。不验证真实 Stripe/稳定币/续订；本地 subscriptions 开关关闭 |
| 账单 / 设置 / 语言 | 账单显示 2 次试用耗尽、5 次购买到账和逐歌账本记录；营销选项修改、重载后保留并恢复为不接收；通过账户菜单切日文账单、英文作品列表，再切回中文 | [日文 360](visual-previews/ux-audit-20261124/20-billing-ja-360.png)。未改密码/绑定 Google、申请删除账户或真人 MFA，以免把范围扩大为账户管理验证 |
| 场景页 | 6 页 × zh/ja/en，分别在 390/360/1280 视口实际打开并点击主按钮；18 次目标和来源参数均正确保留到登录 next；memory 没有 gift=1；无横向滚动 | [中文](visual-previews/ux-audit-20261124/scene-zh-390.png)、[日文](visual-previews/ux-audit-20261124/scene-ja-360.png)、[英文桌面](visual-previews/ux-audit-20261124/scene-en-1280.png)。只抽查主入口，未声称每条场景 starter 都独立生成歌曲 |
| 空状态 / 网络错误 | 拒绝认领后作品列表展示无作品；浏览器故意中断产品请求，价格页显示网络错误，恢复请求后产品和购买入口恢复；故障生成有已退款及重试说明 | 网络错误为注入故障；恢复验证通过重新载入页面完成，不宣称已验证所有页面的 retry 按钮 |

## 验证和环境限制

- 最新基准已按冻结锁文件安装依赖并完成 `pnpm build`，幂等迁移及 seed 成功；未重置开发库，未改源代码和锁文件。已有 demo 数据保留。
- 使用系统 Chromium 的临时启动适配器跑原版 `scripts/check-ui.mjs`，适配器位于 checkout 外；没有修改检查规则或略过断言。
- 第一轮布局准备遇到 `MFA_REQUIRED`：seeded admin 没有二次验证，而 runner 需要该身份建立夹具。本地 demo 使用支持的 `ADMIN_MFA_REQUIRED=false` 重新准备；这个设置在 production 被配置校验拒绝。它只为演示夹具服务，不是生产绕过。
- 下一轮原始配额下，多个视口共用 creator，反复制作歌词耗尽默认 10 次/24h 配额，`writeThreeVersions` 等待不到卡片而退出 1。该轮不能称为布局全通过；也促成了 UX-05 的独立复现。没有清除数据库配额记录。
- 最终布局轮使用仅进程级的 `LYRIC_DRAFTS_PER_DAY=1000`、`GUEST_TRIAL_PER_NETWORK=100`、`GUEST_TRIAL_DAILY_LIMIT=100`、`GENERATION_RATE_LIMIT_PER_HOUR=1000`，避免矩阵夹具自身耗尽业务配额。主旅程的配额、无额度及错误结论均来自提高配额之前；不能用最终矩阵证明生产限次。
- 最终完整布局矩阵：**376 page views、4 problems、6 warnings，退出码 1**。4 项分布在 `home-xmas @ tablet-768 [zh]` 的标题/说明和 `song-guest-owner @ tablet-768 [zh]` 的赠送额度说明/注册按钮，均报告被底部 tabbar 遮挡。不能声称 UI 全绿。
- 游客歌曲页及 home-xmas 分别隔离复测（原脚本 `--only song-guest-owner`、`--only home-xmas`）：**各 8 views、0 problems、0 warnings、退出码均为 0**，包括同一个 768×1024 视口。没有改断言、隐藏元素或应用修复；故原矩阵提示保留为待复查的时序/状态相关现象，不直接冒充稳定复现的产品阻断，原 376 视图运行仍为失败。
- 原矩阵失败截图：[home-xmas](visual-previews/ux-audit-20261124/layout-full-home-xmas-tablet-768.png)、[游客歌曲页](visual-previews/ux-audit-20261124/layout-full-song-guest-tablet-768.png)。隔离复测通过没有覆盖或替换原结果。
- 可复核的原始布局输出：[376 视图完整运行](visual-previews/ux-audit-20261124/layout-full.txt)、[游客页隔离复测](visual-previews/ux-audit-20261124/layout-guest-repeat.txt)、[home-xmas 隔离复测](visual-previews/ux-audit-20261124/layout-xmas-repeat.txt)。
- 这些检查脚本的失败截图会先滚回顶部再截图，不能仅从 full-page PNG 中固定 tabbar 的位置证明“滚到底也不能操作”。原始日志、截图和局部复测需要一起解读。
- 主旅程操作日志及原始导出媒体在当前云端 `/workspace/.yuha-tools/ux-audit-20261124/`；公开 PR 只提交本文、截图和不含凭据的摘要。其他环境不自动获得该本地目录。
- 本分支只写报告与证据，不改产品逻辑，故不重复运行与审计无关的全量单元测试。未用历史全量测试结果替代本基准验证。
- 已对发现、复现步骤、截图链接、合成数据范围、断言边界及暂存文件清单做手工证据审阅；`git diff --check` 与 `pnpm check:stewardship` 通过。当前聊天未安装仓库命名的 Matt Pocock code-review 插件，不声称执行了该插件，也不将本次报告视为任何产品代码的发布评审。

## 交接建议

1. 优先修复 UX-01/02 的注册—认领—歌曲落地页衔接，并分别用 yes/no 分支回归；这是本轮最直接的旅程缺口。
2. Claude 继续其已认领的 UX-03/06；同时将 UX-04 的声乐选择纳入 Home 草稿方案。涉及文件归属先在 #88 或相应 PR 声明，避免双方重写同一文件。
3. UX-05 应区分错误原因，不仅换一个通用错误标题。测试应覆盖配额在另一页面耗尽后再进入工作室的情形。
4. PR #110 的动作排列、照片预览高度和后续修复，应在其最终提交上复核；本报告不把未运行代码标为通过。
5. 真实移动 Safari 的文件选择、HEIC/方向、Web Share、下载保存路径，以及真实模型/对齐质量，留作明确的设备/生产许可测试，不以 headless Chromium 代替。
6. 对 UI 矩阵的两个 768px 遮挡提示继续检查滚动、异步内容及 fixture 状态，不能靠反复跑到绿就删除原失败；UX-07/08 分别作为本地媒体交付与可访问性的独立小任务处理。

GitHub GraphQL 和 REST 评论接口在本环境均返回 Forbidden，ACK 文本已准备但未发送；不声称 Claude 已收件或在线。报告将优先通过独立 Git 分支交付；PR/RESULT 评论是否成功，以实际返回值为准。没有合并、部署或修改公开权限。
