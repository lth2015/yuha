# 歌词模型：Claude

> 产品负责人 2026-11-21：「接着做更好的歌词模型吧。」

## 为什么换

现在歌词由 TokenStars 的 `gpt-5.4-nano` 写，有两处：首页简单模式在生成参数时一起写（`extractIntent`），
`/create` 的歌词草稿单独写（`writeLyrics`）。用固定的 9 条描述（`docs/quality/lyric-briefs.json`，中日英各三条）
跑了一次（`pnpm lyrics:compare`，2026-11-21），自动检查结果：

| 问题 | 出现次数 | 为什么要紧 |
| --- | --- | --- |
| 行数约为歌曲长度能容纳的两倍（52 行对约 27 行） | 3 / 9 | 歌手只能赶词或吞词，也就是漏字 |
| 副歌只出现一次 | 3 / 9 | 没有能记住的那一句 |
| 歌词里留着阿拉伯数字（「第1次」「2am」） | 2 / 9 | 演唱时容易念错，强制对齐也最容易在这里失准（见 `docs/quality/probe-set.json`） |

这些是能自动查出来的。歌词本身写得好不好，需要人读；报告里有全文，留着读。

## 做了什么

- **`packages/providers/src/text/anthropic.ts`**：Claude 文本适配器，三件事都做——
  生成参数和歌词（`extractIntent`）、歌词草稿（`writeLyrics`）、按要求修改（`reviseSong`）。
  一个开关（`TEXT_ADAPTER=anthropic`）就能把一首歌唱出来的每个字都交给同一个模型。
  - 默认模型 `claude-opus-5-5`，`effort` 默认 `medium`（`ANTHROPIC_EFFORT` 可调）；
  - 生成参数用结构化输出（JSON schema 来自合同里的同一组枚举），回来之后仍然用 `musicIntent` 校验，不再需要修复重试；
  - 模型拒绝写（`stop_reason: refusal`）记为 `refused`，不扣额度，创作者改写描述即可；同时开了服务器端回退，误判时由另一个模型在同一次调用里接手；
  - 回复写到上限被截断，记为失败，不把半首歌当成歌词；
  - API 地址写死为 `https://api.anthropic.com`，不读环境里的 `ANTHROPIC_BASE_URL`，免得别的工具设置的变量把创作者的文字送到别处。
- **写歌词的规则**（两个模型的差别主要在这里）：按歌曲长度控制行数；一分钟以上的歌必须有副歌，副歌至少再出现一次；
  主歌写描述里的具体画面；同一段里每行长短、节奏接近（日文按音拍、中文按字数并押韵、英文按重音）；
  数字一律写成文字；中日文歌词不用拉丁字母缩写，除非创作者自己写了。
- **`pnpm lyrics:compare`**：同样的描述交给每个有密钥的模型，输出自动检查表和全文对照，写到 `quality-probes/`（不进 git）。

## 还没验证的

这个容器里没有 Claude 的 API 密钥，所以下面这些还没有用真实调用确认过：

- Claude 写的歌词，在同样 9 条描述上的自动检查结果和读起来的质量；
- 结构化输出和服务器端回退同时使用时，API 是否接受；
- 每次调用的耗时。思考加写歌词预计十几到几十秒；`/create` 的歌词草稿是用户在页面上等待的，超时设为 90 秒；
- 生产环境（EKS）能否访问 `api.anthropic.com`。

在补上这些之前，生产环境继续用 TokenStars。代码已经合并，但 `TEXT_ADAPTER` 不变，就不会生效。

## 费用

按 `claude-opus-5-5` 的标价（输入每百万 token 4 美元、输出 20 美元，思考按输出计）：一次写歌词大约输入 1 千、
输出 2 到 4 千 token，约 0.05 到 0.08 美元，即 7 到 13 日元。每次调用的 token 数和按 `ANTHROPIC_JPY_PER_USD`
（默认 155）折算的日元估算，会记在生成成本里（`is_estimate = 1`）。DROP 单曲约 196 日元，歌词成本占不到 7%。

## 切换步骤

1. **对比**：在有密钥的地方运行
   ```bash
   YUHA_ANTHROPIC_API_KEY=… TOKENSTARS_API_KEY=… TOKENSTARS_MODEL_ID=gpt-5.4-nano pnpm lyrics:compare
   ```
   在 Claude Code 的云端环境里，把密钥作为环境变量 `YUHA_ANTHROPIC_API_KEY` 加进环境设置（不要用
   `ANTHROPIC_API_KEY`，那个名字 Claude Code 自己也会读），新开的会话就能运行这一步。
   读 `quality-probes/lyrics-<日期>.md`：自动检查通过的比例，加上逐首阅读。确认 Claude 更好再继续。
2. **密钥**：先在 AWS Secrets Manager 的 `qa-music-api-secrets-kv` 和 `qa-music-worker-secrets-kv` 两个密钥里
   各加一个键 `ANTHROPIC_API_KEY`；**然后**才在 `deploy/k8s/qa/resources.yaml` 的两个 SecretProviderClass 里加上它的映射
   （与 `TOKENSTARS_API_KEY` 相同的写法）。顺序不能反：映射指向一个不存在的键，CSI 挂载会失败，Pod 起不来。
   密钥不写进任何文件。
3. **网络**：确认 API 和 worker 的 Pod 能访问 `api.anthropic.com:443`。
4. **开关**：ConfigMap 设 `TEXT_ADAPTER=anthropic`，重启 API 和 worker 的 Pod。随时可以改回 `tokenstars`。
5. **上线后**：跑一次 `docs/quality/PROBE_RUNBOOK.md` 的固定测试歌曲；观察后台「质量」卡片里的歌词对齐率。

隐私政策第 4 节写的是「音乐和文本模型供应商」，没有点名具体供应商，所以换模型不需要改隐私政策。
