# 音乐邀请函（Music Gift Invitation）：代码审查结论与实施方案

PRD V1.1（2026-11-27）的 Step 1 和 Step 2，基于主干 `12d1434` 之后的代码。**合并和上线都要经人工审核**（PRD 第十二节）。

## Step 1 审查结论：已有什么，缺什么

| PRD 要的能力 | 现有实现 | 结论 |
| --- | --- | --- |
| 送歌入口 | 创作页的「送给某个人」：`dedication` 记录对象、场合、留言（120 字）和语言；有内容审核 `screenDedication`；支持事后编辑（`POST /v1/tracks/:id/dedication`） | **复用**。邀请函是另一层东西，不改动 dedication |
| 收礼页 | 收礼人在 `/song/:id` 上看到送礼头部、节日开场（礼物盒、贺年卡）和「我也写一首」（`WriteOneToo` → `/create?gift=1&occasion=…&src=share-…`） | 组件和入口**复用**。但前提是**整首歌必须设为公开**，链接就是歌曲 ID |
| 不可预测的分享令牌、单独撤销、同一首歌可以有多份 | **完全没有**。只能整首取消公开，所有链接一起失效 | **新建** |
| 系统分享、复制链接、LINE | `ShareMenu` 走 `navigator.share`；`lib/share.ts` 有 `copyText` 和 LINE intent | **复用** |
| 封面 | `CoverArt` 用 `cover_seed` 生成；`lib/sleeve.ts` 定配色 | **复用**，三个主题在它上面加配色和动效 |
| 无登录播放 | 公开歌的 `previewUrl` 是母带的短期签名链接（`DOWNLOAD_URL_TTL_SECONDS`，默认 300 秒）；过期后前端重新取（`lib/preview-url.ts`） | 方式**复用**：先校验令牌，再签一个短期链接。没有永久链接 |
| 统计 | `analytics_events` + `trackEvent`（只记匿名 ID）；`page_view` 已有爬虫过滤；`users.acquisition_source` 记录注册来源 | **复用**。邀请函的事件要新增，目前一个都没有（`gift_opened` 只写在文档里，代码里不存在） |
| 访问频率限制 | `@fastify/rate-limit`，需要按路由开启；`/v1/share/*` 和 `GET /v1/tracks/:id` **都没开** | 新接口一律开启 |
| noindex | `seo.ts` 的 `PRIVATE_PREFIXES` 和 robots；公开页之外的页面都加 noindex | `/gift/` 加进去 |
| 删除 | 删歌时清掉 dedication 和分享卡；删账号时清空文字 | 删歌、删账号时**同时撤销邀请函并清空留言** |
| 日志 | 只脱敏查询参数里的密钥（`log-redaction.ts`） | **补**：路径里的 `/gift/<令牌>` 也要脱敏 |

## Step 2 实施方案

### 数据（迁移 0041 `gift_invitations`）

| 字段 | 说明 |
| --- | --- |
| `id` | CHAR(36) |
| `track_id` | 外键，随歌曲删除而删除（ON DELETE CASCADE） |
| `owner_id` | 创建者 |
| `recipient_name` | 最多 30 字 |
| `sender_name` | 最多 30 字，可为空 |
| `message` | 最多 300 字 |
| `theme` | `warm` / `romantic` / `celebration` |
| `token_hash` | CHAR(64)，唯一。存的是令牌的 SHA-256，**不存明文**；令牌是 32 字节加密安全随机数（base64url，43 个字符），只在创建时返回一次 |
| `status` | `active` / `revoked` |
| `created_at`、`updated_at`、`expires_at` | `expires_at` 第一版可以为空，表示不过期 |
| `revoked_at` | 撤销时间 |

同一首歌可以建多份邀请函。歌曲本身的生成记录、编辑记录都不碰；邀请函**不要求歌曲公开**。

### 接口

| 方法和路径 | 谁能调用 | 做什么 |
| --- | --- | --- |
| `POST /v1/tracks/:id/gifts` | 仅所有者；按人限频 | 校验输入，三段文字都过内容审核；返回 `{id, url, …}`，**令牌只在这里出现一次** |
| `GET /v1/tracks/:id/gifts` | 仅所有者 | 这首歌的邀请函列表，不返回令牌 |
| `PATCH /v1/gifts/:id` | 仅所有者 | 修改未撤销的邀请函，令牌不变 |
| `POST /v1/gifts/:id/revoke` | 仅所有者 | 撤销，立即生效 |
| `GET /v1/gift/:token` | 公开，按 IP 限频 | 返回称呼、署名、留言、主题、歌名、时长、`coverSeed`、风格、歌词。**不返回任何内部 ID、用户信息或存储路径** |
| `GET /v1/gift/:token/audio` | 公开，按 IP 限频 | 校验令牌有效、未撤销、歌曲未删除且可交付，然后返回 `{url, expiresAt}`，即 5 分钟的签名链接。撤销后立刻返回 404 |
| `POST /v1/gift/:token/events` | 公开，按 IP 限频 | 记录 `view`、`play_start`、`play_complete`、`cta_click`，过滤爬虫，同一访客同一天同一事件只记一次 |

令牌无效、已撤销、歌曲已删除，一律返回 `NOT_FOUND`，不区分是哪种情况，防止被试探。页面上分别给出友好的说明。

### 页面

- **送礼人**（歌曲页「做视频」区旁边新增「音乐邀请函」卡片）：填称呼、署名、祝福语（300 字，显示剩余字数）、主题，然后预览、生成，得到链接，复制或系统分享；下方是已建邀请函列表，每份可单独撤销。卡片上写明「持有链接的人都能打开，链接可能被转发」。
- **收礼人** `/gift/:token`：手机优先。
  1. 开场：「有人为你写了一首歌。」，下面是称呼、封面、歌名、署名。
  2. 播放器：播放 / 暂停、拖动、时长、重播，点击后才开始播放。
  3. 祝福语。
  4. 「你也有想把一首歌送给的人吗？」和「我也想送一首歌」按钮，指向 `/create?gift=1&src=gift-invite`。
  5. 底部低调写「Made with YUHA」。

  不弹注册，不插营销。三个主题是配色加轻量 CSS 动效；系统设置了「减少动态效果」时不播放动画。

### 统计（转化漏斗）

- 服务端记录：邀请函创建、`view`、`play_start`、`play_complete`、`cta_click`。
- 前端记录：分享操作；收礼人带 `src=gift-invite` 进入创作页时记 `gift_create_entered`。
- 新注册用户的来源会记成 `gift-invite`，沿用现有 `acquisition_source`。这样就能算出"每 100 次有效收礼访问 → 进入创作 → 完成歌曲"。
- 所有事件不记文字内容，也不记令牌。

### 安全

- 令牌：加密安全随机，只存 hash；日志里对路径脱敏。
- 所有者校验：沿用 `getTrackForUser`。
- 输入校验：zod 加长度限制；三段文字都过审核。
- 防 XSS：React 渲染文本，不使用 `dangerouslySetInnerHTML`。
- 频率限制：公开接口按 IP，创建接口按用户。
- 收礼页设 noindex，并在 robots 里禁止 `/gift/`。
- 公开接口只返回白名单字段。
- 撤销后，新的播放授权立即被拒。已经签出的 5 分钟链接到期前仍然有效，这是"不能保证完全收回"的部分，会如实写进说明。

### 测试

- 接口测试：创建、所有者校验、令牌只出现一次且不可枚举、hash 存储、撤销后接口拒绝、删歌和删账号后失效、私密歌曲也能送、公开接口没有内部字段、限频、事件去重和爬虫过滤、日志脱敏。
- `check:ui`：收礼页（正常 / 已撤销 / 无效链接）和送礼卡片，4 种宽度 × 3 种语言。
- 真实浏览器：手机宽度下不登录，打开、播放、拖动、跳转创作页。
- 回归：现有的 `gift-and-share` 等测试保持通过。
