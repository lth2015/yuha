# 官方 BGM 批次导入

## 导入入口

管理员打开 `/admin/marketplace`，选择 DGXA 的批次文件夹。页面读取 `manifest.csv`，从 `masters/` 和 `covers/` 找到对应文件。如果另存了盘点报告，也可以选入 JSON。页面逐首列出可导入项和问题。原始风格、情绪和场景照原文保存，无法自动匹配的曲库分类可在页面选择。点击导入后逐首创建私有草稿，失败项可以单独重试。审核和上架沿用现有流程。

## 数据和文件

- 从清单保留系列、原始分类、引擎、模型版本、原始 seed、prompt、生成时间和备注。授权状态默认待确认，可读取明确记录的状态。封面原文件独立保存在私有存储，管理员可在后台查看。`generation/` 中的生成记录留在源批次。
- 支持 60 秒及以上的 MP3 和 PCM WAV。母带按原字节保存，单独生成最长 60 秒的 MP3 试听。报告如提供，按曲目 ID 和文件名匹配，上传时以实际音频校验 SHA-256 和时长。
- 同一批次目录名和曲目 ID 决定导入来源。相同文件和内容可重试。冲突保留原记录并返回错误。旧 `catalog.json` 批次和既有草稿照常可用。
- 浏览器逐首发送，管理员权限和 MFA 按现有后台规则校验。上传后的曲目只有完成原有审核上架流程才会出现在访客目录。

## 验收

1. 用包含 MP3、WAV、封面和引号换行 prompt 的测试批次跑清单和上传。
2. 在真实测试存储比对 WAV 原字节，确认母带路径和生成资料未出现在访客 API。重复上传返回原曲目，错误散列不创建草稿。
3. 在浏览器从选文件夹、浏览问题、导入、打开封面和试听走到草稿列表。覆盖无权上传和缺失文件场景。
4. 生产的正式 30 首由运营验收后导入和上架。

## 操作命令

在 DGXA 或能读取批次的机器执行现有只读盘点。为了保留原文件，建议把报告写到批次旁边，或命名为 `inventory.json` 放在批次根目录。

```sh
python3 deploy/dgx/music/server/bench_official_inventory.py --json ~/yuha-official-bgm/batch-01 > ~/yuha-official-bgm/batch-01/inventory.json
pnpm marketplace:bgm --dir /absolute/batch-01 --only 01,02
pnpm marketplace:bgm --dir /absolute/batch-01 --apply --only 01,02
```

浏览器路径在后台展开「导入 BGM 批次」。选择批次目录后，页面会读取其中的 `inventory.json`。报告在别处时用单独的文件选择框。正式批次可分几次上传，每首母带上限 96 MiB、封面上限 4 MiB。CLI 可用 `--report` 指定独立报告，用 `--apply --all-candidates` 导入可用曲目。CLI 留空 `--apply` 时只读文件与报告。

导入以 `master` 的 SHA-256 识别原字节，以目录名加编号识别批次来源。保留同一个目录名即可重试。标签可在浏览器选定，CLI 可在原清单追加 `genre`、`catalog_scenario`、`catalog_mood` 列指定曲库标签。可选的 `license_status` 接受 `pending`、`cleared` 或 `restricted`。这只保存来源授权记录，访客仍只获得试听。批次导入不会读取 `generation/` 内容。
