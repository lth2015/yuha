# PR #122 · Codex 独立评审（2026-11-25）

结论：**建议修改后再评审，不合并。** 本次只交报告和合成证据，不修改 Claude 的实现。

- PR：[生日／旅行照片 MV 落地页](https://github.com/lth2015/yuha/pull/122)。
- 评审 head：`36c36dd35c518104065bd471685bc8ff9796b47e`；base（PR #121）：`a4b9f3f67d0f3bee735d85ea821c9ff2dd6b9d1d`；抓取时 master：`aad99d77337e21440fc211d56f088e7c372d1517`。
- 范围：上述 head/base 间的 13 个文件、PR 正文验收清单、`docs/ITERATION_EN_JA_MV.md`。没有把 PR #121 的全部统计实现视为已经评审。
- 环境：独立云端、本地 demo API/worker、真实 Linux Chromium 的移动视口模拟、系统 ffmpeg。只使用虚构账号、本次合成歌曲及已有明确标注的合成 QA 图片；无生产请求、真实支付、DGX 或真实用户照片。

## 需要处理

### [中] PR122-01：已有场景测试失败，合并检查尚未通过

- 现象：`pnpm test tests/scenes.test.ts tests/seo.test.ts tests/prerender.test.ts tests/page-title.test.ts tests/photo-video.test.ts` 退出 **1**；**1 个文件失败、4 个通过；2 个测试失败、60 个通过**。
- 位置：`tests/scenes.test.ts:23` 仍固定六个旧场景；`:27` 仍要求所有标题等于场景 name；`:53`、`:55`、`:58` 仍期望旧生日标题、无语言后缀的 src 和旧 OG 标题。后面这些断言会被前面的失败遮住，并非改掉首个期望就完成。
- 应该：更新测试以覆盖新增 travel、生日／旅行 SEO 标题及实际带语言的按钮；保留对完整路由、预渲染、OG、语言和来源的实质断言，补充 MV/FAQ 及开关情形。
- 规则：改动的行为与测试期望不能互相矛盾；不能把失败的必需检查记为通过。
- 版本：上述 head。本轮没有改测试替 Claude 消除失败，也未重复运行无关全量套件。

### [中] PR122-02：新增 FAQ 无条件承诺免费额度和免注册试做，也无视照片 MV 开关

- 现象：在浏览器仅对 `/v1/runtime` 注入 `guestTrialEnabled=false`、`freeTrialEnabled=false`、`freeTrialUnits=0`、`photoVideoEnabled=false`、`photoVideoPreview=false`。原有试做按钮正确消失，但新增 FAQ 仍说 “New accounts get free songs, and you can try one song without signing up”，照片 MV 步骤也仍照常展示。六份静态 HTML 同样包含无条件的免费承诺。
- 位置：`apps/web/src/lib/i18n-en.ts:1163` 及中日对应条目；`apps/web/src/pages/Scene.tsx:78`、`:100` 只看 `scene.mv`。现有 hero 的 `canTry` / `trialUnits` 已按 runtime 判断，新增内容没有沿用。
- 应该：浏览器按真实功能和额度给出说明；无法读取 runtime 的静态 HTML 使用有条件、不会因开关变化失实的措辞。MV 暂停时说明不可用，不能继续承诺可立即制作。不要为了广告文案打开功能开关。
- 规则：服务关闭某项能力时，落地页不能仍无条件承诺可以使用。
- 证据：[开关关闭截图](visual-previews/pr122-review-20261125/flags-off-en-390.png)、`landing-results.json` 的 `flags-off`。这是响应夹具验证，不代表生产当前关闭；本地真实 API 的关闭拒绝用例也在 `photo-video.test.ts` 通过。

### [中] PR122-03：试做可免注册，但 MP3 和 MV 需要注册认领，新增说明遗漏这个前提

- 现象：真实走日文旅行页 →「登録せずに 1 曲試す」→ 首页年龄／条款确认 → 生成交付。歌曲页无 MP3 下载按钮、无照片输入，明确提示注册并保存后才可制作视频。用该游客会话请求该歌 exports，返回 **403 FORBIDDEN**。
- 位置：新增 `scene.mv.step3` / `scene.faq.formats.a`（英文 `i18n-en.ts:1153`、`:1168`，中日同改）只说歌曲就绪后选照片、下载 MP3；同时 FAQ 强调可以免注册试做，未解释后续边界。
- 应该：明确写出“免注册可试做歌曲；注册并将试做歌曲加入账户后，可下载 MP3 和制作照片 MV”。注册并非付款，避免把两者混为一谈。
- 规则：落地页描述的操作步骤应包含实际强制要求的注册／认领前提。这里指出的是文案缺口，不要求放开游客导出权限。
- 证据：[游客歌曲页](visual-previews/pr122-review-20261125/guest-song-ja-390.png)、`guest-results.json`。这是本次实际生成的虚构歌曲，不是仅根据代码推断。

### [中] PR122-04：新来源标记只覆盖制作按钮／starter，免注册入口仍遗漏场景与语言

- 现象：全新浏览器、没有外部 referrer 或 src，打开日文旅行页，再点试做。日语和旅行示例文字正确带到首页，但 `yuha.source` 为空；实际 `/v1/trial/start` 只发送 deviceId、ageConfirmed、termsAccepted，没有 source。因此这条试做不能按 `scene-travel-ja` 纳入统计。
- 位置：本次修改的 `Scene.tsx:46`、`:62` 给 `sceneCreateHref` 传了 lang，而另一条 `tryFirst` 分支（`:26–32`）只保存文字并 `navigate('/')`。该分支的根因早已存在，本 PR 新增旅行场景并扩展来源标记时仍未覆盖它，不冒充为新引入的底层回归。
- 应该：无既有 first-touch 时，试做入口也携带场景／语言标记；已有 X 或 SEO 来源时保留原来源。补覆盖“无来源”和“已有广告来源”两种情况的测试，不覆盖 first-touch。
- 规则：同一场景页的两条创作入口，都应能进入本轮约定的语言／场景漏斗。
- 证据：`landing-results.json` 的 `scene-trial-entry`、`guest-results.json` 的实际请求字段。已有来源的广告访客并非必然丢失来源，本发现只针对上述无来源情形。

## 已核实与限制

| 验收项目 | 结果与证据边界 |
| --- | --- |
| 构建与本地启动 | `pnpm build` 退出 0；幂等 migrate 无待应用迁移，seed 成功；API ready，runtime 为 demo/local-rules/demo-local/local/simulated。没有重置开发库或修改锁文件、保存的环境配置。 |
| 六份实际构建 HTML | zh/ja/en × birthday/travel：标题、描述、canonical、四个 hreflang（含 x-default）、sitemap 和场景 OG 图片地址符合预期；无 JS 即含 MV 文本和 5 条 FAQ。见 `landing-results.json` 的六条 static-head。 |
| 页面和跳转 | 2 场景 × 3 语言 × 360/390/768/1280 共 24 页，无横向溢出；实际点击主 CTA 和 3 个 starter 共 24 次，登录 next 保留 src／starter／生日 occasion，语言保留。没有把仅到达登录页算作真实 OAuth 验收。 |
| 严格局部布局检查 | 从未改动的 `scripts/check-ui.mjs` 提取其完整 audit 函数，用独立临时 harness 对 2 场景 × 3 语言 × 360/393/768/1280 的顶部／底部执行：**24 视图、0 problems、0 warnings，退出 0**。见 `layout-audit.json`。这是局部检查，不是完整 `pnpm check:ui`；没有改原脚本或降低断言。 |
| 视频长度、照片和费用 | 真正点击 30 秒／60 秒／整首可选控件中的整首，确认选中；确认照片权利后选 3 张合成素材，实际导出 **120.000 秒、720×1280、H.264/AAC、18,655,046 bytes** 的 MP4 并下载。点击制作到结果出现 **8.25 秒**，制作前后可用额度均为 1；不是只检查按钮。`media-summary.json`。3–10 张上限及选项由实现与通过的照片视频测试交叉核实，没有声称实际上传了全部数量组合。 |
| 照片处理 | 实现确实在浏览器缩小、合成帧，服务器临时编码，finally 删除；崩溃遗留目录有启动／每小时清理，相关清理及编码测试通过。没有生产运维审计，不能据此保证生产所有异常均已满足 24 小时承诺；保留运维确认。 |
| 分享与音乐使用 | FAQ 中个人分享及禁止音频素材转售与现行 Terms §4 的方向一致；Terms 另有付款、逐歌使用条件和平台范围前提，建议 FAQ 加“以该歌曲的使用条件为准”。这是产品文案核对，不是律师审定。 |
| 示例视频 | 当前没有真实示例视频，页面不显示占位视频；符合 PR 声明，但迭代的真实示例与广告素材尚未完成，不可标记整个投放迭代完成。 |
| 其他检查 | `pnpm check:i18n`、`pnpm check:stewardship` 均退出 0；5 文件定向测试结果为 60 通过／2 失败，见 PR122-01。 |

**仍需实机／生产许可的验收**：iPhone Safari、Android Chrome 上的整首制作耗时、HEIC/方向、原生文件选择和“保存到相册／Photos”。Linux Chromium 此次只显示 Download，没有可分享文件的原生按钮；成功下载 MP4 不能算成保存相册已通过。“通常一分钟以内”缺真实手机和生产样本支持，建议先移除此具体耗时承诺，或待有代表性测量后限定适用条件。也未验证真实模型歌曲生成速度、真实唱词同步、Google OAuth、生产 CDN、搜索引擎实际索引或付费广告表现。

证据目录：[pr122-review-20261125](visual-previews/pr122-review-20261125/)。原始测试日志、自动化脚本和导出 MP4 留在云端 `/workspace/.yuha-tools/review-20261125/`，不提交媒体与任何登录凭据。仓库指定的 Matt Pocock code-review 插件当前不在可用技能中，也未在本机找到；已手工复核 diff、验收证据和报告，不声称该插件已运行。

本次不合并、不部署、不修改公开权限，不替 Claude 改写其分支。待 Claude 给出修订 SHA 后，优先复核上述四项及新增回归测试；实机验收作为独立明确的投放前置条件。
