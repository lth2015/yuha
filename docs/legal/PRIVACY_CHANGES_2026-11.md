# 隐私政策修改稿（2026-11）— 待律师审阅

> 2026-11-23 起草。产品负责人：方案 A，「代码先做、开关关闭，条文律师审过再上线」。
> 涉及两个新功能（`docs/GROWTH_SPEC.md` 第三部分「免注册试做」、`docs/PHOTO_MV_SPEC.md`「照片 MV」），
> 另外补上现有页面已经在做、但条文没有写的一件事（访问统计和推广来源，2026-11-21 起）。
>
> 现行条文在 `apps/web/src/pages/Legal.tsx` 的 `Privacy()`，只有英文版。代码里 `LEGAL_TEXT_REVIEWED = true`
> 表示「这一版经律师审过」；**条文一改，这个标记必须改回 `false`，审过后再改回 `true`**（同一个提交）。
> 所以这份稿子审完之前，`Legal.tsx` 一个字都不动。

## 给产品负责人的中文摘要

| # | 改哪里 | 为什么 |
| --- | --- | --- |
| 1 | 第 2 条「收集什么」加 **访问数据** | 11 月 21 日起，浏览器里存了一个随机访客编号和推广来源（`?src=`），用来统计访问和推广效果。条文目前没写。 |
| 2 | 第 2 条加 **试做数据** | 免注册试做：浏览器随机编号、IP 地址的带密钥哈希（不存原始 IP），只用来限次，7 天删除。 |
| 3 | 第 2 条加 **照片** | 照片 MV：照片只用来合成视频，**不保存**、不交给任何 AI 模型，视频做好即删。 |
| 4 | 第 6 条「保存期限」加试做的歌 | 不注册的试做，7 天后连同音频删除；注册了就并入账户。 |
| 5 | 第 9 条「浏览器存储」改写 | 现行条文说「只存登录状态和草稿」，实际上还存了语言、访客编号、推广来源、打开过的礼物歌、结账返回地址。 |

不新增任何第三方处理方：全部在 AWS 东京区域内（第 4 条不变）。不用 Cloudflare，没有人机验证服务。

## 提议的英文条文

以下按条给出**完整的新文本**；未列出的条款不变。

### 2. What we collect — 增加三项（放在 “Operational data” 之后）

> **Visit data:** when you open a page, a random identifier that your browser creates and keeps
> (not your account, and not your IP address), the page's path, the host name of the site that
> linked to it, and the campaign tag in the link (for example `?src=…`) if there was one. We use it
> to count visits and to learn which links bring people to YUHA. If you create an account, the
> campaign tag you first arrived with is recorded on the account.
>
> **Trial data:** if you make a song without an account, a random identifier your browser keeps and
> a keyed hash of your IP address (we do not store the address itself). We use them only to limit
> free trials per device and per network, and delete them after 7 days.
>
> **Photos:** if you make a photo video, the photos you choose are sent to our servers only to
> assemble that video. They are not stored, not used for anything else and not sent to any model
> provider; they are deleted as soon as the video is made.

### 6. Retention — 第二段之后加一段

> A song made without an account, together with what you entered to make it, is deleted with its
> audio 7 days after it was made, unless you create an account before then, in which case it
> becomes part of that account.

### 9. Local storage — 整段替换

> We use your browser's local storage, not cookies, for: your sign-in session; your language; drafts
> of unsent creations; the random visit identifier and, for 30 days, the campaign tag described in
> section 2; the random trial identifier; which gift songs you have already opened, so the opening
> is shown only once; and where to return after a payment. No advertising or third-party tracking
> cookies are used.

## 请律师特别看的几点

1. **IP 的带密钥哈希**算不算个人信息（日本个人信息保护法的「個人関連情報」或「仮名加工情報」）。
   做法：HMAC-SHA256，密钥只在生产环境的密钥存储里，7 天后删除；不保存原始 IP。
   服务器的访问日志里本来就有 IP（运维用途），这一点现行第 2 条 “service logs” 已经涵盖。
2. **免注册试做也要求先确认 18 岁以上并同意条款**（勾选），与注册用户相同。条款里的「账户」相关表述
   是否需要为「未注册的试做」补一句（例如第 1 条 “By creating an account or using the Service you agree”
   已经写了 “or using”，可能已经足够）。
3. **照片里可能有他人和儿童。** 我们不保存照片，但上传时是否需要提示「请确认你有权使用这些照片」，
   以及条款第 4 条（用户内容）是否需要提到照片。
4. **访问数据的保存期限**目前没有上限（与其他使用事件一起保存）。是否需要写一个期限，例如 13 个月。
5. 日文版：现行隐私政策只有英文。若需要日文正本，这次一起出。

## 上线顺序

1. 律师审定条文（可能有修改）。
2. 同一个提交里：改 `Legal.tsx` 的 `Privacy()`，`LEGAL_TEXT_REVIEWED` 保持 `true`，
   注释里写明审阅日期和范围（与 2026-10-19 那次的写法一致）。
3. 然后才打开免注册试做和照片 MV 的开关。
