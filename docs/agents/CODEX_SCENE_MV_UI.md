# 交给 Codex：AI 场景 MV 的页面和功能布局（T8）

> **2026-11-26 分工与方向更新**：新一轮由 Codex 负责设计／交互、Claude 负责实现，再交叉验收。请使用 [Veo 规格](../AI_SCENE_MV_VEO_SPEC.md) 与 [Claude 交接](CLAUDE_VEO_MV_HANDOFF.md)；本文的 30 秒／四分镜、LTX 耗时和数据路径仅作旧契约参考，不直接套用到 Veo。

> 2026-11-26。产品负责人：UI 和功能布局交给 Codex 思考和完成。
> 规格：[AI_SCENE_MV_SPEC.md](../AI_SCENE_MV_SPEC.md)；工作票：[AI_SCENE_MV_TICKETS.md](../AI_SCENE_MV_TICKETS.md)。
> 分工照 [CODEX_COLLABORATION.md](CODEX_COLLABORATION.md)：这一张票页面归 Codex，接口、队列、合成归 Claude。

## 现在已经有什么

- **生成**（T5）：分镜一段一段交给 dgxv，按人轮流用 GPU，每段画完检查无声后存下。
- **合成**（T6）：几段镜头按选段等分剪接、只用歌曲原声、按歌曲现在的时间轴烧入中日英字幕、720×1280。成片私有保存 7 天（拟议值，未对外承诺）。
- **记录**（T4）：一个人同一时间只能有一个任务在排队；删歌、注销会一并清掉。
- **接口**（T7）：Claude 接下来做，契约见下。开关 `FEATURE_SCENE_MV_ENABLED` 默认关，只对员工开放（和照片 MV 的员工预览同一套），不收费。

## 页面要解决的问题（由 Codex 设计，下面是约束，不是布局）

1. **入口**：在歌曲页的视频区，和现有的「封面视频（快速版）」「照片 MV」并列。要让人一眼分清：快速版马上能拿到；AI 版要等几分钟到十几分钟，画面由 AI 生成。
2. **选段**：默认选副歌附近约 30 秒（有时间轴时用时间轴找副歌，没有就用歌曲中段）；可以拖动，但长度不超过 32 秒（4 段 × 8 秒）。
3. **风格**：3 个预设——雨夜霓虹 `neon_rain`、日落海边 `seaside_sunset`、柔和插画 `soft_watercolor`。每个风格要有一张示意（Codex 出图，规矩同 [CODEX_VISUAL_REQUESTS.md](CODEX_VISUAL_REQUESTS.md)：原创、无文字）。
4. **描述**：可选，一句话描述画面。提示用户**不要写真实人名、照片里的人、名人**；不会自动把歌词、照片或账号资料交给模型。
5. **分镜确认**：服务端按风格和描述给出 4 段分镜文字，用户可以改每一段，确认后才开始。确认前什么都没花。
6. **等待**：真实阶段进度——排队中、生成第 n/4 段（`drawn/total`）、合成中；有别人同时在做时（`othersInProgress`）如实说可能更久。时间如实写：每段约 1.5–3 分钟，4 段约 6–12 分钟，排队时更久。**不能写「一分钟完成」**。用户可以离开，回到歌曲页能接着看到进度。
7. **取消**：排队中、生成中都能取消。文案要如实：已经在机器上画的那一段会画完，但不会再画下一段。
8. **完成**：预览播放、下载、分享（沿用现有分享视频的系统分享）。写明「保存 7 天，请及时下载」。
9. **失败**：说人话，并告诉用户这次没有花任何东西；可以重新开始。
10. **同时只能一个**：已有任务在进行时，新建要说明并引导去看那一个。

## 规格里不能违反的

- 不出现「零成本」「数据不出公司」「一分钟完成」「原图第一帧完全不变」。
- 不显示任何播放数、点赞数之类的计数（CLAUDE.md 的产品决定）。
- 首版只有竖屏、只有文字描述；不开放照片驱动、人物写真、口型。
- 所有字由页面排版，三种语言（中、日、英），走现有字典；图里不放字。

## 接口契约（T7，Claude 实现；Codex 可以先按这个写，用 demo 视频后端在本地跑通）

所有接口要求登录，只对歌曲所有者；不是所有者一律 404。开关关闭（或没有配置视频服务）时 503 `SERVICE_DISABLED`。出错时的返回体和其他接口一样：`{error: {code, message, details?}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/runtime` | `features.sceneMv: boolean`——这个人能不能看到入口 |
| POST | `/v1/tracks/:id/scene-mvs` | `{clipStart, clipEnd, style, description?}` → `201 {id, status:'draft', shots:[{idx, prompt}]}`；只对可播放的歌曲（纯音乐也可以，只是没有字幕） |
| PATCH | `/v1/scene-mvs/:id` | 草稿时改分镜：`{shots: string[]}`（1–4 段，每段 ≤ 300 字） |
| POST | `/v1/scene-mvs/:id/start` | 草稿 → 排队。`202`；已有一个在进行：`409`，`error.details = {reason:'busy', activeId}` |
| GET | `/v1/scene-mvs/:id` | `{id, trackId, status, style, clipStart, clipEnd, shots:[{idx, status, prompt?}], drawn, total, othersInProgress, failure, expiresAt, createdAt}`。`prompt` 只在草稿时给出（给用户确认、修改）；`othersInProgress` 是同时在做的别人的 MV 数（共用一台机器，用来如实说明可能要等）；用户写的描述不会回传；`status` ∈ `draft·queued·generating·composing·ready·failed·cancelled` |
| GET | `/v1/tracks/:id/scene-mvs` | 这首歌的场景 MV，新的在前（回到页面时找进行中的那个） |
| POST | `/v1/scene-mvs/:id/cancel` | `200`；已经完成的不能取消：`409` |
| GET | `/v1/scene-mvs/:id/download` | `{url, expiresAt}`，短期签名链接 |
| DELETE | `/v1/scene-mvs/:id` | 删掉成片和记录 |

`failure` 只会是固定代码（`shot_failed`、`compose_failed`、`song_gone`、`timeout` 等），页面按代码选文案，不显示服务端原话。

建议轮询 `GET /v1/scene-mvs/:id`：生成中每 10–15 秒一次，页面不在前台时停。

## 验收

- `pnpm check:ui` 通过，并把新状态加进它的页面清单：至少 `song-scene-mv-draft`、`song-scene-mv-progress`、`song-scene-mv-ready`、`song-scene-mv-failed`，360 / 393 / 768 / 1280 px × 三种语言。
- 「减少动态效果」下没有动画；对比度检查通过。
- **验证承诺本身**（CLAUDE.md「Verify the claim」）：「可以离开」→ 离开再回来看到进度；「取消后不再画下一段」→ 取消后确认没有新的分镜被提交；「保存 7 天」→ 看 `expiresAt`。
- 公开仓库：截图和示例里不放真实用户的名字、歌或描述。
