# AI BGM Studio：现状分析与最小改动方案（PRD V1.0 第十节第 1–4 步）

2026-11-27 · Claude Code · 基于主干 `58bde44` 只读核查。这份文档只做分析和方案，没有写功能代码。Phase 1 等产品负责人确认第 5 节的待决事项后再开工。

## 1. 可以直接复用的部分

| 能力 | 现有实现 | 用于 BGM 的方式 |
| --- | --- | --- |
| 纯器乐生成，端到端 | API 有能力检查 `supportsInstrumentalOnly`（`apps/api/src/services/generation.ts:153`）；worker 对器乐歌丢掉歌词（`apps/worker/src/pipeline.ts:223,231`）；HTTP 适配器发送 `instrumental: true`（`packages/providers/src/music/http.ts:221`）；DGX 歌词置为 `[Instrumental]`，再加 `instrumental` 标签（`deploy/dgx/music/server/app.py:356,382,416`） | 照用，不新建生成服务 |
| 任务、队列、重试、取消、超时 | `POST /v1/generations` → outbox → worker `runJobStep` | 同一条管线，只加一个业务类型字段 |
| 扣费与失败退款 | 每次生成预留 1 个单位，交付时扣除，失败退回（`packages/db/src/ledger.ts:238`、`apps/api/src/services/delivery.ts:175`、`failJob`）；迟到的成功结果不再扣费 | 照用，不会重复扣费。BGM 收几个单位见第 5 节 |
| 交付检查 | 时长误差不超过 750 ms、近乎静音、空文件、无法解码、声道数（`packages/providers/src/audio/ffmpeg.ts:140-159`） | 满足 PRD 的 ±1 s；削波和人声检查要新增 |
| 母带处理 | DGX `_master`：响度归一到 −14 LUFS、淡入 30 ms、淡出 1.5 s（`app.py:577-640`） | 结尾自然这一点已经有基础处理 |
| 裁剪与淡出导出 | `createExport`：起点、时长、淡出 1 s，同样参数复用已生成的文件，不扣费（`apps/api/src/services/exports.ts`） | 可以用来做 15 s 版本（见第 3 节） |
| 授权快照 | `license_snapshots` 每首一行、写入后冻结：模型、合同版本、许可版本、地区、允许和禁止的用途、`commercial_delivery`（`0001_init.sql:264-289`） | 满足 PRD 3.6"记录模型及许可证版本" |
| 同意记录 | `users.consent_version`（`CONSENT_VERSION`，`packages/contracts/src/common.ts:213`） | BGM 的授权条款可以沿用这套版本化记录 |
| 作品库、试听、下载 MP3 | `tracks` + `GET /v1/tracks` + 歌曲页播放和下载 | 照用；作品库加一个类型标识 |
| 测试方式 | 约 30 个测试文件用 `createHarness()` 加演示音频，通过 `runJobStep` 跑完整生成 | BGM 用同样方式测 |

## 2. ACE-Step 1.5 的真实支持情况（按代码核实，未做实际生成测试）

| PRD 要求 | 现状 | 结论 |
| --- | --- | --- |
| 15 / 30 / 60 秒 | 接口只接受 30 / 60 / 120 / 180 / 240（`SONG_DURATIONS`，`packages/contracts/src/generation.ts:18`；能力表 `apps/api/src/context.ts:178`）；DGX 自己的下限是 10 s（`app.py:69`） | 30 和 60 现在就能做。15 秒有两条路：A. 直接让 DGX 生成 15 s，质量未知，要实测；B. 生成 30 s 再取一段加淡出，用现有导出路径。我建议先测 A，A 不行就用 B，并且在页面上说明 |
| 时长误差 ±1 s | 交付检查已经是 ±0.75 s；DGX 按实际渲染长度输出，不硬截（`app.py:687-697`） | 满足 |
| 纯器乐、无人声 | 只靠标签和 `[Instrumental]`。**没有检测非预期人声**：`docs/OPEN_ITEMS.md:149` 把 AI-07 列为未建；DGX 上有 demucs 人声分离（`separate.py`），但只用于歌词对齐 | 要新增：BGM 渲染完后在 DGX 上测人声能量，超过阈值就标出来，或者重试一次 |
| 节奏 慢 / 中 / 快 | 只是作为文字标签发给模型（"slow tempo" / "mid-tempo" / "fast tempo"，`app.py:387-389`），**没有 BPM 控制** | 页面只能叫"节奏倾向"，不能显示 BPM，也不能承诺精确速度 |
| 风格、情绪、场景 | 风格以标签方式传入；情绪和场景目前由文本模型从描述里提取，取值是 `Scene` 4 种、`Mood` 8 种（`packages/contracts/src/enums.ts:76,81`），和 PRD 的取值不一样 | BGM 不经过文本模型，改为确定性的提示词模板：用户选项 → 英文标签。可控、可测，也省掉一次文本模型调用 |
| 循环播放（实验性） | 完全没有，没有任何接缝或交叉淡化逻辑 | **建议 MVP 不提供**，原因见第 4 节 |
| 削波检查 | 测了 `maxVolumeDb` 但没人用（`ffmpeg.ts:116,124`） | 加一行检查，成本很低 |
| 记录每个任务用的模型版本 | DGX 不按任务返回模型，存下的 `provider_model` 只是环境变量标签 `ace-step`；生产实际是 `acestep-v15-xl-turbo` 加 `5Hz-lm-4B`（`deploy/dgx/music/README.md:3-12`） | 要改：DGX 在任务结果里返回模型和版本，YUHA 写进授权快照 |
| 实际推理成本 | 只记了一个常量 `MUSIC_COST_MINOR_PER_REQUEST`=45（`apps/api/src/config.ts:306`），没有真实的 GPU 时间 | 要改：DGX 返回渲染秒数，YUHA 按任务记录，作为商业验收的成本数据 |
| 商业授权 | `MUSIC_COMMERCIAL_DELIVERY=false`；README 写明许可和产出权利**待核实**（`deploy/dgx/music/README.md:163`） | MVP 只能标为"个人使用 / 预览"。商用要等法务结论，页面不出现版权或独占之类的字样 |

## 3. 最小改动方案（Phase 1）

**原则：同一条生成管线，加一个业务类型字段，不复制服务。**

1. **契约**：`createGenerationRequest` 新增可选的 `bgm` 块，字段为 `scenario`、`genre`、`mood`、`durationSeconds`（15 / 30 / 60）、`tempo`、`note`（自然语言补充）。只要带了 `bgm`，就强制器乐、不传歌词、不选人声。
2. **数据**：一个新迁移：
   - `tracks.kind`（`song` / `bgm`，默认 `song`）
   - `generation_jobs.input` 里保存 BGM 参数（已有 JSON，不改表）
   - `asset_versions` 已经有 `format` 字段，留给 WAV
3. **提示词**：`packages/providers` 新建 BGM 模板：
   - 场景、风格、情绪映射成英文标签，比如 Vlog → "vlog background, unobtrusive"；
   - 固定加上"适合做旁白背景"的约束，比如 "no lead melody dominance, steady groove, soft intro, clean ending"；
   - 用户的补充描述要先过现有的内容审核再拼进去；
   - 有单元测试证明每个选项都会出现在发给模型的标签里，没有静默丢弃的选项。
4. **15 秒**：先用 DGX 实测直接生成 15 s。质量过关就把 15 加进 BGM 允许的时长；不过关就生成 30 s，再用现有导出路径取 15 s 加 1 s 淡出。
5. **质量检查（BGM 专用）**：
   - 时长：已有；
   - 静音：已有；
   - 削波：新增，用已经测出来的 `maxVolumeDb`；
   - 人声：新增，DGX 对 BGM 渲染跑一次 demucs，返回人声能量占比。超过阈值就免费重试一次，还不行就交付，但标"可能含人声"，并计入质量统计。
6. **页面**：新增 `/bgm` 路由和导航入口「AI 背景音乐」：
   - 选项：场景、风格、情绪、时长、节奏倾向、补充描述；
   - 默认值：Vlog、日系治愈、温暖、30 秒；
   - 下方是生成进度，复用现有任务轮询；
   - 结果卡片：试听、时长、风格、生成时间，下载 MP3，"同样配置再来一首"；
   - 授权状态写明"个人使用"；
   - 现有的歌曲创作入口和页面不动。
7. **作品库**：BGM 带标识，可以按类型筛选。
8. **审计**：任务记录写入参数、模型版本（来自 DGX）、渲染耗时、错误码；只有所有者能访问，沿用现有权限检查。
9. **测试**：
   - 契约：`bgm` 块强制器乐，非法时长被拒绝；
   - 管线：演示音频跑通 15、30、60 秒；
   - 提示词：每个选项都生效；
   - 扣费：失败退款、不重复扣；
   - 权限：别人的 BGM 返回 404；
   - 不影响歌曲生成：现有约 30 个生成测试继续通过；
   - `check:ui` 加 `/bgm` 的各个状态，四种宽度、三种语言。

验收时我会提供：生产环境前的演示截图或录像、各项检查和测试结果、实测的生成成功率和耗时。人工评审 30 条需要你们出人；评审表和打分脚本我来准备。

## 4. 不建议放进 MVP 的部分

- **循环播放**：ACE-Step 不保证首尾音乐上能接上。如果只做"检测接缝 + 标记"，大部分结果大概率会被标成不能无缝循环。要做好，需要专门的循环生成或交叉淡化重拼，这是独立的一块工作。建议 Phase 1.5 做实验性开关，先在后台实测接缝通过率，再决定上不上。
- **WAV 导出**：数据结构已经预留，按 PRD 放在后面。
- **Phase 2 / 3**：PRD 已经写明不要提前做。

## 5. 开工前需要产品负责人决定（2026-11-27 已定，见文末）

1. **价格**：BGM 每次扣几个单位？现在不分时长，都是 1 个单位。15–60 s 的 GPU 成本明显低于 2–4 分钟的歌。任何价格改动都要先进 `docs/PAYMENTS_DESIGN.md`。
2. **15 秒的做法**：先实测 A（直接生成），不行再用 B（截取 30 秒）。是否同意？
3. **循环播放**：是否同意不放进 MVP？
4. **授权措辞**：MVP 页面只写"个人使用"。商用表述等法务结论。是否同意？
5. **排期**：歌词自动同步目前是最高优先级。BGM 是排在歌词这一批之后，还是并行？并行的话，worker 和 DGX 的上线窗口要错开。

### 决定（产品负责人 2026-11-27：“去做吧”，由 Claude 统一调度）

1. **价格**：先不改，每次仍扣 1 个单位，和歌一样。不改价格就不用改 `PAYMENTS_DESIGN.md`。有了实测成本后，单独提价格方案。
2. **15 秒**：先实测 A（DGX 直接生成 15 s）；A 不行就用 B（生成 30 s 后截取，加淡出）。
3. **循环播放**：不放进 MVP。
4. **授权**：MVP 只写“个人使用”，商用等法务结论。
5. **排期**：与歌词同步并行开发；两边涉及 worker 或 DGX 的批次错开上线窗口。

## B2：质量检查（2026-11-27 实现，叠在 #161 上）

**削波和人声都在 DGX 上对原始渲染测，不在交付的 MP3 上测。** 核查发现：DGX 的母带处理把每首都压到 -2.5 dBTP（`app.py` `MASTER_TP`），所以 YUHA 在交付文件上测到的 `maxVolumeDb` 每首都约是 -2.5 dB，看不出削波。上面第 5 节说"用已有的 `maxVolumeDb`"是错的，改为：

- **DGX**（`deploy/dgx/music/server/quality.py`）：每次渲染后出一份 `report`：
  - 引擎和模型名；
  - 渲染耗时；
  - 峰值和削波比例：在满刻度上连续 3 个以上采样点才算削波；
  - 纯器乐时另外跑一次 demucs，给出人声能量占比和"听到人声的秒数"。

  测量失败不影响交付。
- **YUHA**：
  - worker 按 `MUSIC_REPORT_FIELD` 读这份报告，BGM 交付时存进 `tracks.bgm.quality`；
  - 页面只拿到结论 `bgmVoiceHeard`，只给所有者，原始数字不出服务器。公开链接的访客看到的 `bgm` 只有选项（`bgmChoices`）；
  - 结论在读取时按 `BGM_VOICE_SECONDS_MAX`（默认 2 秒）算，调阈值对已生成的 BGM 也生效。
- **页面**：听到人声时，结果卡片上给出提醒，三种语言。

**这次没做、要等数据的：**

- **人声超标自动免费重试一次**：阈值还没校准，没校准就自动重试只会白烧 GPU。先收集数据，等 30 条人工评审定下阈值再开。
- **削波**：只记录，不提示用户，也不拦截。
- **阈值本身**：要等 dgxa 更新后真实渲染一批，结合人工评审来定。
