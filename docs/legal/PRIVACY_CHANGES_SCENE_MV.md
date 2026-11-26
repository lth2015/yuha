# 隐私政策修改稿：AI 场景 MV — 待负责人和律师审阅（草稿）

> 2026-11-26，Claude 起草（工作票 T9，`docs/AI_SCENE_MV_TICKETS.md`）。
> 规格要求：**功能对所有人打开（`FEATURE_SCENE_MV_ENABLED=true`）之前**，这里的条文要审定并上线。
> 员工内测期间开关关着，普通用户用不到，这份草稿可以和内测并行审。
> 格式同 [PRIVACY_CHANGES_2026-11.md](PRIVACY_CHANGES_2026-11.md)：先列已核实的事实，再给条文。条文只写事实里有的。

## 已核实的事实（对照代码，2026-11-26）

| 事实 | 依据 |
| --- | --- |
| 用户可以写一句画面描述（可选，≤ 300 字），服务端据此和所选风格生成 4 段分镜文字，用户可修改 | `apps/api/src/services/scene-mv.ts` |
| 交给视频模型的**只有分镜文字**（英文提示词）。不交歌词、照片、账号信息、歌曲音频 | `apps/worker/src/scene-mv.ts` 的提交参数：prompt、时长、竖屏 |
| 视频模型在**我们自己运营的服务器**上（LTX-2.5，DGX Spark）。不经过第三方 AI 服务 | 模型服务负责人的接口说明（2026-11-26） |
| 合成在我们的 AWS 东京区服务器上：画面 + 歌曲原声 + 歌词字幕 | `apps/worker/src/scene-mv-compose.ts` |
| 成片私有保存 **7 天**，只有歌曲所有者能下载（10 分钟有效的签名链接） | `KEEP_DAYS = 7`；`ttlSeconds: 600` |
| 分镜片段在合成后（不论成败）立即删除 | `dropShots` |
| 视频服务器上的每个任务（含提示词）：YUHA 取回后、失败后、取消或删除时都会立即要求删除；服务器自身最长保留 7 天 | 本次修改；接口说明「服务器保留 7 天后自动删除」 |
| 失败、取消、未开始的草稿：7 天后连同描述和分镜一起删除 | `expiredSceneMvs` |
| 删歌、注销账号、试用到期：立即停止生成、清掉描述和分镜文字，再删文件和记录 | `removeSceneMvsOfTrack` |
| 日志不记描述、分镜、歌词：只记任务 id、状态、原因代码 | 本次修改后核对 `scene-mv.ts`、`scene-mv-compose.ts` 的全部日志 |
| 视频服务器返回的错误原因只存成固定代码，不存原文 | `failureCode` |
| **YUHA 与视频服务器之间是明文 HTTP**（产品负责人为 PoC 选择），只允许 YUHA 的两个出口 IP 访问 | `VIDEO_ALLOW_INSECURE_SELF_HOSTED`；SRE 清单 |

## 提议的英文条文

### 隐私政策 2. What we collect — 增加一项

> **AI scene videos:** if you make an AI scene video, the description you write for it (optional) and the
> shot descriptions made from it and the style you choose, which you can edit before it starts. Only the
> shot descriptions are given to the video model; your lyrics, photos, account details and the song's
> audio are not. Please do not describe real, identifiable people.

### 隐私政策 4. Services we use — 在「Our own music server」后增加

> - **Our own video server** [location to confirm]: turns shot descriptions into short video clips. It is
>   operated by us, not by a third party, and receives only the shot descriptions.

### 隐私政策 6. Retention — 增加

> - **AI scene videos:** the finished video is kept privately for 7 days, for you to download, and then
>   deleted with the descriptions written for it. Descriptions for videos that failed, were cancelled or
>   were never started are deleted 7 days later. The clips the video is assembled from are deleted as soon
>   as it is made. Our video server deletes each clip and its description once we have collected it, or
>   when it fails or is cancelled, and in any case within 7 days. Deleting the song or your account
>   deletes its AI scene videos straight away.

## 送审前要确认的（负责人）

1. **视频服务器在哪里**：条文里的 `[location to confirm]`。音乐服务器写的是「our office in Tokyo, Japan」；视频服务器是否同一处。
2. **模型和许可**（工作票 T2）：LTX-2.5 的许可证原文、商用和输出使用条件；推理代码有没有向外发送数据（遥测）。条文里「operated by us」以此为前提。
3. **7 天是否对外承诺**：规格里写的是「拟议」。代码已经按 7 天执行，条文一旦发布就是承诺。

## 请律师看的几点

1. **明文传输**：分镜文字在 YUHA（AWS 东京）和视频服务器之间不加密传输，只靠来源 IP 白名单保护。需要在政策里说明吗？还是视为内部系统之间的传输，以安全措施条款概括？我们的建议是：在 PoC 期间用员工内测，**对所有人开放之前改成 HTTPS**。
2. **用户在描述里写了真实人物**：我们提示不要写，但无法阻止。描述只用于生成并在 7 天内删除，这样的处理是否足够？
3. **成片里的歌词字幕**：歌词本来就属于用户的歌曲数据，成片和歌曲一起受保护。这里不需要另写吗？
