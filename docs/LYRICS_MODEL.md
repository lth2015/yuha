# 歌词模型

> 产品负责人 2026-11-21：「接着做更好的歌词模型吧。」随后决定：用 ChatGPT 的模型，贵一点也可以——
> 换 TokenStars 上的模型只改一个配置，换供应商（Claude）要 SRE 配密钥、走流程。

## 结论

**把 `TOKENSTARS_MODEL_ID` 从 `gpt-5.4-nano` 改成 `gpt-6-luna`。** 同一个 TokenStars 账号，同一个密钥，
同在 Azure 日本东区处理，不用 SRE。

## 怎么比的

9 条固定描述（`docs/quality/lyric-briefs.json`，中日英各三条），用 `pnpm lyrics:compare` 交给每个模型写歌词，
自动检查四件事：行数和歌曲长度相称、副歌回来、没有阿拉伯数字、中日文没有拉丁字母。2026-11-21 的结果：

| 模型 + 提示词 | 自动检查全部通过 | 中位耗时 |
| --- | --- | --- |
| `gpt-5.4-nano` + 旧提示词（当时的生产设置） | 3 / 9 | 4 秒 |
| `gpt-5.4-nano` + 新写词规则 | 6 / 9 | 4 秒 |
| **`gpt-6-luna` + 新写词规则** | **9 / 9** | 13 秒 |

旧提示词下 nano 的问题：3 首行数约为歌曲能容纳的两倍（歌手只能赶词或吞词），3 首副歌只出现一次，
2 首留着阿拉伯数字（「第1次」「2am」，演唱容易念错，强制对齐也最容易在这里失准）。

逐首读过：luna 的歌词更短、更像歌，副歌有一句能记住的话，细节来自描述本身（「七号线慢慢驶向终点」「コンビニの水はぬるく」）。
nano 用了新规则仍然偏长、偏散。

另外，luna 用同一套提示词生成歌曲参数（`extractIntent`，首页简单模式的歌词就在这一步写）也正常返回，
带不带 `response_format` 都可以，约 12 秒。

## 改了什么

- **写词规则**（`packages/providers/src/text/lyric-craft.ts`），所有文本适配器共用：
  每一行都用描述的语言；按歌曲长度控制行数；一分钟以上的歌必须有副歌，副歌至少再出现一次；主歌写描述里的具体画面；
  同一段每行长短、节奏接近；数字写成文字；中日文不用拉丁字母缩写，除非创作者自己写了。
  - 第一版规则里有日文示例，nano 因此给三条英文描述写了日文歌词。加上「每一行都用描述的语言，示例不决定语言」之后，
    英文描述重新得到英文歌词。这一条是读结果读出来的，自动检查只报了「语言不符」，所以检查里保留了语言一项。
- **只接受默认温度的模型**（`gpt-6-luna` 对 temperature 0.4/0.8 返回 400）：适配器收到这种 400 后去掉 temperature 重试一次，
  之后这个进程不再发送。换模型只改 `TOKENSTARS_MODEL_ID`，不用另配开关。400 不计费。
- **推理模型的输出预算**：每次请求的 `max_tokens` 多留 2000，给模型看不见的推理用；只是上限，不推理的模型不多花钱。
- **超时**：`TOKENSTARS_TIMEOUT_MS` 默认从 20 秒改为 60 秒。luna 写一首两分钟的歌要 8 到 15 秒。
- **Claude 适配器**（`TEXT_ADAPTER=anthropic`）也在代码里，现在不用。哪天需要再比较，按本文最后一节加密钥即可。

## 切换步骤

1. 在 API 和 worker 的 ConfigMap（`qa-music-api-config`、`qa-music-worker-config`）里：
   - `TOKENSTARS_MODEL_ID=gpt-6-luna`；
   - 如果设了 `TOKENSTARS_TIMEOUT_MS`，改成 `60000`（没设就用新的默认值）。
2. 重启 API 和 worker 的 Pod（ConfigMap 只在 Pod 启动时读取）。
3. 验证：在 `/create` 写一首有人声的歌，看歌词；第二天看后台「质量」卡片的歌词对齐率，
   以及 TokenStars 账单里每次调用的实际费用（`TOKENSTARS_COST_MINOR_PER_REQUEST` 目前按 1 日元估算，
   luna 更贵，看到账单后按实际调整）。
4. 想退回：把 `TOKENSTARS_MODEL_ID` 改回 `gpt-5.4-nano`，重启。

## 再比较一次

```bash
TOKENSTARS_API_KEY=… TOKENSTARS_COMPARE_MODELS=gpt-5.4-nano,gpt-6-luna pnpm lyrics:compare
```

报告写到 `quality-probes/lyrics-<日期>.md`（不进 git）：自动检查表，加上每首歌词全文，供人阅读。
加上 `YUHA_ANTHROPIC_API_KEY=…` 也会把 Claude 一起比。在 Claude Code 的云端环境里，用这个名字而不是
`ANTHROPIC_API_KEY`，因为后者 Claude Code 自己也会读。

如果以后要在生产用 Claude：先在 AWS Secrets Manager 的 `qa-music-api-secrets-kv`、`qa-music-worker-secrets-kv`
里加键 `ANTHROPIC_API_KEY`，**然后**才在 `deploy/k8s/qa/resources.yaml` 的两个 SecretProviderClass 里加映射
（顺序反了 CSI 挂载会失败，Pod 起不来）；确认 Pod 能访问 `api.anthropic.com:443`；ConfigMap 设 `TEXT_ADAPTER=anthropic`。
隐私政策第 4 节写的是「音乐和文本模型供应商」，没有点名具体供应商，所以换模型不需要改隐私政策。
