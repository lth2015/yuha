# 给 Claude Code：T8 前端完成，请接续 T7 联调

2026-11-26。回复 `CODEX_SCENE_MV_UI.md` 的页面交接任务。

**T8 前端已完成，真实 T7 / GPU 联调尚未完成；请勿据此打开公开功能。**

- 交付分支：`codex/scene-mv-ui`，基准 `df61255`。只读核对 T7 `21dd4fd`；没有合并或修改你的后端、队列、迁移与合成代码。
- 已实现：独立 AI 场景入口、歌曲选段试听、三幅原创风格示意、可选描述、可编辑分镜与确认、等待与恢复、取消、失败重试、历史成片、预览／下载／可用时系统分享。中日英字典齐全，功能关闭时不显示入口也不请求场景接口。
- 相关测试：3 文件、45 测试通过，退出码 0。完整 `check:ui`：500 视图、0 problems、6 warnings，退出码 0；包括七个新增状态、四种宽度和三种语言的 84 个组合。构建、类型、字典、orphan、对比度与 stewardship 检查通过。
- Chromium 实际操作验证了选段播放器、分镜确认顺序、离开再返回恢复、取消交互、失败提示、测试视频播放下载和删除。场景服务使用契约 fixture，视频为合成测试文件；不代表真实任务或 LTX 质量已验收。
- 设计和完整边界：[CODEX_SCENE_MV_UI_DESIGN.md](CODEX_SCENE_MV_UI_DESIGN.md)。[手机配置预览](visual-previews/scene-mv-ui/config-zh-390.png)、[桌面配置预览](visual-previews/scene-mv-ui/config-zh-1280.png)、[生成中](visual-previews/scene-mv-ui/progress-zh-390.png)、[成片](visual-previews/scene-mv-ui/ready-zh-390.png)。证据全部来自合成数据。

## 请你接续处理

1. **先修复本地 MP4 的 Content-Type**：`apps/api/src/routes/files.ts` 当前将非 WAV 文件统一返回 `audio/mpeg`，包括 T6 生成的 MP4。应正确返回 `video/mp4`，并实际 GET 签名链接、播放视频回归。前端会拒绝错误媒体类型，没有强制转换掩盖问题。S3 的 MIME／CORS 也需实际验证。
2. 用真实 T7 接通前端，核实所有者权限、全用户唯一活跃任务、跨页面恢复、取消后不再提交下一镜头、成片过期清理。当前浏览器 fixture 只证明前端交互，不能替代这些服务端验收。
3. 实际接口为 `othersInProgress`，页面不会把它当作准确排队位置。草稿 detail/list 已有 prompt，前端可恢复；busy 同时兼容标准 envelope 和早期 flat 形状。
4. T7 的预设分镜正文目前是英文，公开前请确认中／日文说明策略；再完成真实 GPU 质量和 iPhone／Android 保存与分享验收。

未合并 master、未部署、未打开功能，未改锁文件、环境配置或已应用迁移。本文件随任务分支推送，供异步交接；是否另已成功发送 GitHub 通知以聊天回执为准。
