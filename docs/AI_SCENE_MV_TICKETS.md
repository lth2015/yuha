# AI 场景 MV：工作票

来源：`docs/AI_SCENE_MV_SPEC.md`（Codex，`7e491ef`）。每张票能单独合并、单独验证。
**开关**：`FEATURE_SCENE_MV_ENABLED` 默认关；内测期只对员工开放（同照片 MV 的员工预览），不收费。
规格要求“先测再定”，所以 T1 的实测结果决定 T6 之后的参数（尺寸、镜头时长、队列上限、价格）。

| # | 票 | 依赖 | 谁 | 完成标准 |
| --- | --- | --- | --- | --- |
| T1 | **dgxv 视频服务 + 测速**（`deploy/dgx/video/`）——代码已写、假后端已测；**dgxv 上未跑** | — | Claude 写；负责人在 dgxv 上跑 `./deploy.sh` 和 `bench.py` | 服务：提交／查询／取片段，一次一个 GPU 任务，不带模型音轨，鉴权，过期清理。测速：冷启动 1 次 + 每配置暖启动 5 次，竖／横、4／8 秒，P50/P95、峰值显存、失败／OOM 全部记录，输出 Markdown 表填回规格第 8 节 |
| T2 | 模型与许可核实 | — | 负责人 + 法务 | 实际模型、权重版本、许可证原文（商用、营收限制、输出使用）；推理代码有无遥测外发。结论写进规格 |
| T3 | 视频 provider 接口——**已完成**：`DemoVideoProvider` 与 `HttpVideoProvider`（只认 HTTPS），同一套契约测试，HTTP 一半直接跑 T1 的 Python 服务 | — | Claude | `packages/providers/src/video/`：`submit / status / fetch` 契约；`demo`（本地 ffmpeg 生成色块片段，供开发和 CI）与 `http`（T1 的服务）两种实现；契约测试 |
| T4 | 任务与镜头的数据层——**已完成**（迁移 0036；删歌／注销／试用清理时一并清除） | — | Claude | 新迁移：`scene_mvs`（所有者、歌曲、选段起止、风格、提示词、状态、版本快照、过期时间）与 `scene_mv_shots`（序号、描述、状态、尝试次数、片段存储键）。状态机：Draft→Queued→Generating→Composing→Ready / Failed / Cancelled；行为测试 |
| T5 | 生成队列（worker）——**已完成**（`apps/worker/src/scene-mv.ts`；尚未挂进 worker 主循环，T7 连同开关一起接） | T3 T4 | Claude | 全局一次一个镜头；每用户最多一个活跃任务；镜头有限重试，只补失败镜头；重启后恢复；取消阻止后续镜头。测试：重复提交、重启恢复、取消、失败返还 |
| T6 | 合成 | T5 | Claude | 4 个镜头按段落／固定长度切点复用剪成选段长度；只用歌曲原音轨；竖屏 720×1280；歌词字幕（与现有视频相同的时间版本）；成片存私有存储，7 天过期（拟议，待 T2/运维确认后才对外承诺） |
| T7 | API | T4–T6 | Claude | 所有者：创建（选段、风格、描述）→ 返回分镜；确认后排队；查询进度；取消；下载（短期签名链接，所有者校验）。歌曲删除／账号删除时一并清除 |
| T8 | 页面 | T7 | Claude | 视频区「AI 场景 MV（内测）」：选段（默认副歌附近 30 秒）、3 个风格、描述、分镜确认、真实阶段进度、离开后回来可续看、完成后预览／下载／分享；封面视频作快速版。check:ui 状态 |
| T9 | 隐私与条文 | T2 | 负责人 + 法务；Claude 起草 | 文字驱动处理的数据、保留期限、处理地点与实际一致；开关打开前完成 |
| T10 | 内测验收 | T1–T9 | 负责人真机；Claude 脚本 | 规格第 8 节：20 条选段画面检查、真机 iPhone／Android、任务恢复、重复提交、取消、失败返还 |
| T11 | 定价 | T1 T10 | 负责人 | 按实测 GPU 分钟定整单价格，进 `docs/PAYMENTS_DESIGN.md` 矩阵；失败不收费 |

**dgxv 实际运行的服务（2026-11-26 负责人提供）不是 T1 写的那个**：`POST /v1/videos`（prompt、duration 1–8 秒、orientation、mute）、`GET /v1/videos/{id}`、`GET /v1/videos/{id}/content`、`GET /health`，请求头 `X-API-Key`；没有取消、没有幂等键。T3 的 HTTP provider 已按它改写；响应字段名（`id`/`status`/`error`）待第一次真实调用确认。用户取消只能停止后续镜头，已在 GPU 上的那段会画完（平台承担）。

不在首版：整首逐秒、口型、人物一致性保证、照片驱动（P3，单独隐私评审）、付费插队、外部视频 API 兜底。
