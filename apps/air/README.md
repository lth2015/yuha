# @yuha/air · 空气作曲

第一阶段规格：`docs/AIR_COMPOSITION_SPEC.md`（#26）。独立静态应用：不依赖
api / db / providers，不发任何请求，`apps/web` 不引用它，不进入 iOS 包。

| 页面 | 内容 |
| --- | --- |
| `index.html` | 演奏：触控 → 引擎 → 声音与光（#28、#29）；一次演奏最长 30 秒，回放 / 重来（#30） |
| `probe.html` | #27 iPhone 第一声测试（静音键 Go / No-Go） |
| `render.html` | 仅开发用：离线渲染试听录音，不进入构建 |

## 结构

- `src/engine/`：纯逻辑的草图引擎，唯一的测试缝（`tests/air-engine.test.ts`、
  `tests/air-session.test.ts`）。不接触 DOM、音频、时钟或 `Math.random`。
  `session.ts` 决定一次演奏的起止，并只把 20 Hz 降采样后的帧（按下与抬起
  总是保留）交给引擎；草图记录的正是这些帧，所以回放的音乐事件与现场逐项
  相同。
- `src/play/`：触控输入、合成器、光效与演奏页面（薄适配层）。`gesture-math.ts`
  是触控到「张开程度 / 两指距离」的纯函数换算（`tests/air-gesture.test.ts`），
  演奏和离线渲染共用。
- `src/audio/unlock.ts`：iPhone 静音键下让 Web Audio 发声（#27 验证：静音
  `<audio>` 循环有效）。
- `src/probe/`：#27 测试页。

## 命令

```bash
pnpm --filter @yuha/air dev            # 本机开发，端口 5180
pnpm --filter @yuha/air phone          # 局域网 HTTPS（自签名证书），供真机访问
pnpm --filter @yuha/air artifact:play  # 演奏页打包为单文件 → dist/play.html
pnpm --filter @yuha/air artifact:probe # 测试页打包为单文件 → dist/artifact.html
node apps/air/scripts/render-air.mjs <输出目录> [seed...]   # 在 apps/air 目录下运行：30 秒试听 WAV
```

单文件页面用于发布到 claude.ai 托管（HTTPS，手机可直接打开）。托管页运行在
嵌入框架里：只有 `#token` 形式的锚点能传进页面，不显示浏览器对话框。

试听录音用与演奏完全相同的引擎和合成器离线渲染，所以听到的就是手指会弹出的。
