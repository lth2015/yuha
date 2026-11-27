# YUHA 音乐生成服务商业许可核查报告

2026-11-27 · Claude Code 核查 · **本报告不是法律意见**。正式结论和条款变更须经律师和产品负责人人工审核。

**核查范围**：DGX 上 YUHA 音乐服务实际部署的组件。依据有两类：一是仓库里的部署配置；二是各组件官方 GitHub、Hugging Face、PyPI 页面的原文，本次核查时读取（读取日期 2026-11-26，UTC）。本报告不评估 TokenStars 等其他供应商。

## 结论摘要

1. **阻断项：歌词对齐使用的 Meta MMS 强制对齐模型（`torchaudio.pipelines.MMS_FA`）是 CC-BY-NC 4.0，即非商用许可。** 生产上每首有人声的新歌交付后都要跑歌词对齐，DGX 默认的对齐方法是 `ALIGN_METHOD=forced`，用的就是这个模型（`deploy/dgx/music/server/app.py:80, 893-897`）。在付费服务中使用非商用许可的权重，按字面理解与许可冲突。**这是本次核查最需要先处理的问题，独立于网站文案。**
2. **ACE-Step 1.5**（代码和 3 个模型）的许可证均为 MIT，模型卡上明确写着生成的音乐可以商用。但这句话属于模型卡的宣传文字，不在许可证正文里；MIT 许可明确不担保不侵权；各来源都没有说明**输出归谁**。
3. **其余组件**都是宽松许可：Whisper（MIT，含权重）、demucs（MIT）、Qwen3 基座（Apache-2.0）、cutlet / fugashi / unidic-lite（MIT / BSD）。但 **htdemucs 的训练数据含仅限学术用途的曲目**（MUSDB18 中的 MedleyDB 部分），存在来源风险。
4. **网站文案**：建议的中日文措辞本身是稳妥的，没有承诺独占著作权，也没有担保不侵权。但它比现行条款第 4 节放宽了（明确包括广告等商业内容），所以**必须同时修改每首歌冻结保存的使用条件记录和 `MUSIC_COMMERCIAL_DELIVERY` 设置**，否则条款和记录互相矛盾。**在第 1 条解决、律师审核之前，建议不发布。**

## 一、实际部署的组件

| 组件 | 版本 / 依据 | 状态 |
| --- | --- | --- |
| ACE-Step 1.5 代码（`acestep15` 服务） | `docker-compose.yml:40` 固定在提交 `ca1e85fe9430179831e6bc6be790c332190a3866`（读取时也是 `main` 的最新提交） | **已确认**（以仓库配置为准） |
| 渲染模型 `acestep-v15-xl-turbo` / `acestep-v15-xl-sft` | `docker-compose.yml:49-50` | 模型名**已确认**。**权重版本没有固定**：首次启动时从 HF 下载到 `~/.cache/acestep15`。读取时 HF 上的最新版本是 turbo `d4a0b288…`、sft `d06de46b…`；**DGX 上实际是哪一版，尚待上机确认** |
| 规划模型 `acestep-5Hz-lm-4B`（基于 Qwen3-4B） | `docker-compose.yml:52` | 模型名**已确认**；权重版本**尚待确认**（HF 最新 `0a3ec94b…`） |
| ACE-Step 1.5 主包（VAE、`Qwen3-Embedding-0.6B` 文本编码器） | 随 1.5 一起下载 | 版本**尚待确认**（HF 最新 `19671f40…`） |
| ACE-Step v1（旧引擎，仍装在 `music` 容器里） | `Dockerfile:5` 的 `ACE_STEP_REF=main`，**没有固定版本**；生产用的是 `ENGINE=v15`（README 记录于 2026-11-22） | 已不在生产渲染路径上；实际提交**尚待确认** |
| 歌词对齐 MMS_FA | `forced.py:365`；`ALIGN_METHOD` 默认 `forced` | **已确认在用**。生产 `.env` 是否改过 `ALIGN_METHOD`，**尚待上机确认** |
| Whisper（对齐的后备路径） | `Dockerfile:53` `openai-whisper`，未固定版本 | 在用 |
| demucs `htdemucs`（人声分离） | `Dockerfile:57`、`separate.py:32` | 在用 |
| cutlet / fugashi / unidic-lite（日文读音） | `Dockerfile:45` | 在用 |

上机确认要运行的命令（不修改任何东西）：

```bash
cd ~/yuha-spark && grep -E '^(ENGINE|ALIGN_METHOD)=' .env
ls ~/.cache/acestep15            # 各模型目录
find ~/.cache/acestep15 -name '*.json' -path '*refs*' -o -name 'main' | head   # HF 缓存里的版本号
docker compose exec -T music pip show openai-whisper demucs torchaudio | grep -E 'Name|Version'
```

## 二、逐项许可证（摘录原文）

| 组件 | 许可证原文 | 关于商用的原文 | 关于输出、禁止用途的原文 | 来源 |
| --- | --- | --- | --- | --- |
| ACE-Step 1.5 代码 | "MIT License / Copyright (c) 2026 ACEStep … to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies" | 许可证正文对输出没有说法 | README："we encourage users to verify the originality of generated works, clearly disclose AI involvement … The authors are not responsible for any misuse of the model, including but not limited to copyright violations"；**未说明输出归谁** | github.com/ace-step/ACE-Step-1.5 @ `ca1e85f`：LICENSE、README.md |
| `acestep-v15-xl-turbo` / `-xl-sft` | 模型卡元数据 `license: mit`；仓库里**没有 LICENSE 文件** | "**Commercial-Ready:** Trained on legally compliant datasets. Generated music can be used for commercial purposes." | 未说明 | huggingface.co/ACE-Step/acestep-v15-xl-turbo（`d4a0b288`）、/acestep-v15-xl-sft（`d06de46b`） |
| `acestep-5Hz-lm-4B` | `license: mit`，"License: [MIT]" | "You can strictly use the generated music for **commercial purposes**." | 未说明。基座："Pretrain from: Qwen3-4B" | huggingface.co/ACE-Step/acestep-5Hz-lm-4B（`0a3ec94b`） |
| Qwen3-4B（基座）、Qwen3-Embedding-0.6B | `license: apache-2.0`，"Apache License Version 2.0, January 2004" | Apache-2.0 允许商用；**再分发**权重时要附许可证并保留 NOTICE | — | huggingface.co/Qwen/Qwen3-4B（`1cfa9a72`） |
| ACE-Step v1 / `ACE-Step-v1-3.5B` | Apache-2.0 | 未说明 | 模型卡 "Out-of-Scope Use"："Generating copyrighted content without permission … Misrepresenting AI-generated music as human-created" | github.com/ace-step/ACE-Step（`1bee4c9f`）；HF `82cd0d7b` |
| **MMS_FA（歌词对齐）** | **"under CC-BY-NC 4.0 License"**（torchaudio 文档）；**"The MMS code and model weights are released under the CC-BY-NC 4.0 license."**（fairseq MMS README） | **非商用** | 许可证没有说明对齐结果（时间戳）是否受约束 | docs.pytorch.org/audio/stable/generated/torchaudio.pipelines.MMS_FA.html；github.com/facebookresearch/fairseq/blob/main/examples/mms/README.md（`3d262bb2`） |
| openai-whisper | "Whisper's code and model weights are released under the MIT License." | MIT | — | github.com/openai/whisper（`86098128`） |
| demucs / htdemucs | MIT | MIT | README："`htdemucs` … Trained on MusDB + 800 songs." MUSDB18 中的 MedleyDB 曲目为 "BY-NC-SA 4.0 … can only be used for academic purposes" | github.com/facebookresearch/demucs（`e976d93e`）；sigsep.github.io/datasets/musdb.html |
| cutlet / fugashi / unidic-lite | MIT；MeCab 和 UniDic 为 BSD | 宽松许可，需保留版权声明 | — | github.com/polm/*（版本号见文末） |

各来源原文的本地副本保存在本次会话的临时目录，未提交进仓库。复核时直接打开上面的链接，以表中的提交号或版本号为准。

## 三、五个问题的结论

| 问题 | 结论 | 分类 |
| --- | --- | --- |
| 能否做商业 SaaS（付费使用生成服务） | ACE-Step 1.5、Whisper、demucs、Qwen 都是 MIT 或 Apache，允许。**MMS_FA 是 CC-BY-NC，不允许**，而它就在付费服务的交付流程里 | **存在限制**（MMS_FA） |
| 能否付费生成音乐 | 同上。生成本身（ACE-Step）允许；交付后的歌词对齐用了 MMS_FA | **存在限制** |
| 用户能否商用生成的音乐 | ACE-Step 1.5 模型卡宣传文字写"可以商用"；许可证正文没有关于输出的条款；**输出归谁没有任何来源说明**；不担保不侵权 | 模型方声明**已确认**；权利归属和可登记性**尚待律师确认** |
| 能否做 BGM 授权（商城出售许可） | 模型方不限制，但 YUHA 能授予的只能是"使用许可"，不能是"著作权"。纯 AI 生成的音乐在日本法下能否成立著作权、归属于谁，需要律师意见 | **尚待确认** |
| 能否交第三方发行（TikTok / 流媒体） | 模型许可不禁止；各平台有自己的 AI 音乐政策、披露要求和内容识别规则。ACE-Step 文档要求"clearly disclose AI involvement"，v1 模型卡禁止把 AI 音乐冒充人类演奏 | **存在限制**（必须披露 AI 生成、按渠道逐一核对） |

## 四、MMS_FA 的处理建议（需要产品负责人决定）

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A. 立即止损 | 在 DGX 的 `.env` 里设 `ALIGN_METHOD=whisper`，只用 Whisper（MIT）对齐，然后重启 `music` 服务 | 对齐质量可能下降，Whisper 对歌声的效果比强制对齐差；正在做的逐行信心也依赖强制对齐 |
| B. 替换为可商用的强制对齐模型 | 换成许可明确允许商用的模型，候选是 NVIDIA NeMo Forced Aligner 或 Apache/MIT 许可的 wav2vec2 / CTC 模型。**候选模型的许可都要先逐个读原文核实**，我还没有核实 | 1–2 周，需要跑盲听基准做对比 |
| C. 取得商用许可 | 联系 Meta 取得 MMS 的商业授权 | 不确定能否取得 |

我的建议是 **A 先做，同时开始 B**。A 只改一个环境变量，不改代码，可以随时改回来。这一步要你确认，因为它会影响正在打磨的歌词同步质量。另外还有一个法律问题：以前用 MMS_FA 生成的时间轴怎么处理（比如是否需要重新对齐），需要律师意见。

## 五、网站商业使用说明

### 现状和矛盾点

- 条款第 4 节（`apps/web/src/pages/Legal.tsx:143`，目前**只有英文版**）：可用于 "personal and creator content, including monetised posts on the platforms the plan states"。禁止 "resell the audio itself as a music or stock product"、"present it as a human performance"、"train competing music models"。
- 条款第 6 节：已经写明不保证商用适用、使用记录不等于著作权登记或不侵权担保。
- 每首歌在生成时会冻结一份使用条件记录：
  - `MUSIC_COMMERCIAL_DELIVERY` 关闭时，记录写的是「動作確認・プレビューのみ（商用配信の許諾は未取得）」，即"仅作动作确认 / 预览"（`apps/api/src/services/delivery.ts:58`）；
  - 开启时，写的是 `TERMS_ALLOWED_USES`（`apps/api/src/context.ts:107`）。
  - **生产上这个开关实际是什么值，尚待确认**：`resources.yaml` 里没有，在 ConfigMap 或密钥里。如果是关闭，那么现在每首付费歌的记录写"仅预览"，而条款写"可用于创作者内容"，**两者已经矛盾**。
- 页面上的现有文案：导出页的"使用条件记录"栏、BGM 页（未合并的 PR）写的"仅限个人使用"。
- 我没有找到 FAQ 页面。权利申诉页（`/help/rights`）的 SEO 描述写着"商用需要什么"，但正文没有讲商用。

### 建议修改（暂不发布，等律师审核）

1. **条款第 4 节**，替换第一段，中文、日文按你给的原文。**英文对照**（建议）：
   > Subject to the YUHA Terms of Service and applicable law, you may use music generated with YUHA for personal and commercial purposes, including video soundtracks, advertising and other commercial content. Permission to use music commercially does not mean that you obtain exclusive copyright in it, and is not a warranty that the music is original, does not infringe third-party rights, or can be registered for copyright.

   第二段的禁止项保留，建议再加一句："Music distributed through third-party platforms must be disclosed as AI-generated where the platform or law requires it."
2. **语言版本**：律师意见第 5 条已建议准备日文版。这次的中文、日文条款应当和日文版条款一起审核，并写明语言版本冲突时以哪个为准。
3. **使用条件记录**：把 `TERMS_ALLOWED_USES` 改成和第 4 节一致，例如加上 "Commercial content including video soundtracks and advertising"。在生产打开 `MUSIC_COMMERCIAL_DELIVERY=true` 之前，**必须先完成第四节的 MMS_FA 处理**。记录按歌冻结，旧歌的记录不追溯修改；但对外说明里要写清楚"以生成时的记录为准"。
4. **BGM 页**：许可解决之前，保持"仅限个人使用"。许可解决之后，改成和条款第 4 节一致的一句话，并链接到条款。
5. **不做的事**：不承诺独占、完整的著作权；不把用户作品放进 YUHA 的素材库或拿去发行（BGM 方案已写明这一点，代码里也没有这样的路径）；不改动生成和歌词编辑功能，不动已有的生成记录。

## 六、未解决的法律风险

1. MMS_FA 是非商用许可，而生产正在使用它（见第四节）。
2. 纯 AI 生成的音乐在日本能否成立著作权、归属于谁、能否登记，需要律师意见。在此之前，YUHA 只授予"使用许可"。
3. 训练数据来源：ACE-Step 1.5 只是在模型卡上自称使用了合法数据，没有任何担保；htdemucs 的训练数据含仅限学术用途的曲目；v1 的训练数据来源未说明。
4. 风格相似导致的侵权：ACE-Step 自己也提示了这一风险，并把责任推给使用者。YUHA 在条款第 6 节已经做了免责，但面向商用销售时，可能还需要内容检查（相似度、内容识别）。
5. 第三方发行：各平台的 AI 政策、披露要求、内容识别（Content ID）规则，要按渠道逐一核对（Marketplace 修订文档第 6 条）。
6. 模型权重版本没有固定：首次启动时下载最新版，许可证和模型卡日后可能变化。建议把实际下载的版本号记入仓库，并写进每首歌的使用条件记录（BGM 方案 B2 已经计划由 DGX 回报模型版本）。
7. 再分发义务：只要不对外分发权重就不涉及。如果以后对外分发（例如本地版），要附上 Apache-2.0 许可证和 NOTICE。
8. 已经卖出的歌，是在"仅预览"记录或旧条款下交付的，条款变更不追溯；对外说明要讲清楚。

---

来源版本号（读取时）：

| 来源 | 版本 / 提交号 |
| --- | --- |
| ACE-Step-1.5 | `ca1e85fe9430179831e6bc6be790c332190a3866` |
| HF xl-turbo | `d4a0b288b83ebb7e25a8c0b32c573c22e134e8ee` |
| HF xl-sft | `d06de46b4622f781cf07f4a013a67d591ca52819` |
| HF lm-4B | `0a3ec94b557aea7d508da38b31cfe7341f6ff737` |
| HF Ace-Step1.5 | `19671f406d603126926c1b7e2adc169acbcade22` |
| HF Qwen3-4B | `1cfa9a7208912126459214e8b04321603b3df60c` |
| ACE-Step v1 | `1bee4c9f5b43e30995f8d4d33b3919197ce1bd68` |
| HF v1-3.5B | `82cd0d7b6322bd28cd4e830fe675ddb6180ce36c` |
| fairseq | `3d262bb25690e4eb2e7d3c1309b1e9c406ca4b99` |
| whisper | `86098128c0b4f24f0e2aa2994de830614b474227` |
| demucs | `e976d93ecc3865e5757426930257e200846a520a` |
| cutlet | `83c4c49a2bf3d1a515bdd9331939555633eceac0` |
| fugashi | `1576b66a2bf8173da50e1930791f0dcb96111590` |
| unidic-lite | `11f69cce1e4498b0232e65c9e0ca38cb5fdc9bf9` |
