# 隐私政策修改稿（2026-11）— 待律师审阅（第二版）

> 第一版 2026-11-23；**第二版 2026-11-24**，依据产品负责人转来的意见重写，并逐条对照代码核实了数据流。
> 涉及两个新功能（`docs/GROWTH_SPEC.md` 第三部分「免注册试做」、`docs/PHOTO_MV_SPEC.md`「照片 MV」），
> 以及现有页面已经在做、条文没写的事。
>
> 现行条文在 `apps/web/src/pages/Legal.tsx` 的 `Privacy()`，只有英文版。代码里 `LEGAL_TEXT_REVIEWED = true`
> 表示「这一版经律师审过」；条文一改，这个标记必须改回 `false`，审过后再改回 `true`（同一个提交）。
> 所以这份稿子审完之前，`Legal.tsx` 一个字都不动；两个新功能的开关保持关闭。

## 第二版改了什么

第一版有五个说法，核对代码后**三个不成立、两个要加限定**。第二版不再用它们：

| 第一版的说法 | 核实结果 | 第二版 |
| --- | --- | --- |
| 照片「不保存」 | 服务器收到的不是照片原件，而是浏览器合成好的视频帧（JPEG，带歌词字幕）。帧写进服务器临时目录，编码结束（成功或失败）立即删除；**进程崩溃时会留在容器临时盘上，直到容器被替换，目前没有清扫** | 如实写「临时处理」及各种情况下的清理期限；代码补清扫（见「上线前要改的代码」1） |
| 「不存原始 IP」 | 试做限次记录里确实只有带密钥哈希。**但**「新设备登录」提醒邮件正文里有原始 IP（经邮件服务商发出，留在用户邮箱）；运维日志是否含 IP 取决于 AWS 端配置，仓库里看不到 | 「不存原始 IP」只限定在试做限次记录；登录提醒邮件单独写明 |
| 试做数据「7 天后删除」 | 未注册的 7 天后删除，属实。**注册认领后的试做，设备和网络哈希目前永久保留** | 代码改为认领后也在 7 天时清除（「上线前要改的代码」2） |
| 「全部在 AWS 东京」 | AWS 部分在东京（ap-northeast-1）。但以下不在 AWS：**作曲服务器**（公司自有的 DGX Spark，不在 AWS）、**歌词/意图模型**（TokenStars 网关，后端观测为 Azure OpenAI Japan East，非合同保证）、**Google Fonts**（每个访问者的 IP 发给 Google）、Google 登录、Stripe、CloudFront 全球边缘节点 | 改写第 4 条，逐个列出；Google Fonts 建议改为自托管从而不再列出（「上线前要改的代码」4） |
| 「只用本地存储，不用 cookie」 | 有**一个** cookie：Google 登录时的 `yuha_oauth_state`（HttpOnly，10 分钟，登录完成即清除，防登录劫持，属必要 cookie） | 改为「除一个登录安全所必需的 cookie 外」 |
| 「没有新增处理方」 | 两个新功能本身不新增处理方。但现行第 4 条**本来就漏了** Google Fonts 和自有作曲服务器的位置 | 第 4 条补全 |

这些核实只能覆盖仓库里的代码和部署文件。**生产环境的 ConfigMap 不在仓库里**，以下几项需要运维在 AWS 上确认后才能写进条文
（括号里是能确认它的命令）：

- 邮件服务（SES）的区域（`kubectl -n qa-music get cm qa-music-api-config -o yaml`）。
- S3 / SQS 的区域，同上。
- RDS 自动备份的保留天数（`aws rds describe-db-instances`）。运维文档写的是 14 天，但没有在线上核对过。
- S3 生命周期规则、版本保留（`aws s3api get-bucket-lifecycle-configuration`）。
- 容器日志是否送到 CloudWatch、保留多久、ALB / CloudFront 是否开了访问日志（这些日志会含 IP）。
- 作曲服务器（DGX Spark）的物理位置和国家，以及它到 AWS 之间的传输是否加密（代码里是 HTTP，见「上线前要改的代码」5）。

## 给产品负责人的中文摘要

| # | 改哪里 | 内容 |
| --- | --- | --- |
| 1 | 第 2 条加 **访问数据** | 浏览器随机访客编号、页面路径、来源站点、推广标记 `?src=`。用于统计访问和推广效果。 |
| 2 | 第 2 条加 **试做数据** | 浏览器随机编号 + IP 的带密钥哈希（限次记录里不存原始 IP）；7 天后清除，注册与否都一样。 |
| 3 | 第 2 条加 **照片** | 合成视频帧临时处理，不进存储、不进数据库、不给任何模型；编码结束即删，异常情况下最长 24 小时内删除。 |
| 4 | 第 2 条 service logs 补一句 | 「新设备登录」提醒邮件里含 IP 和浏览器信息。 |
| 5 | 第 4 条 处理方与地点 | 逐个列出，包括自有作曲服务器、TokenStars、Google、Stripe、邮件服务。 |
| 6 | 第 6 条 保存期限 | 分开写：访问事件、浏览器编号、账户来源标记、试做、日志、备份。 |
| 7 | 第 9 条 浏览器存储 | 列出实际存的内容；写明唯一的 cookie。 |
| 8 | 认领流程 | 试做歌曲并入账户改为**用户主动确认**（现在是登录即自动并入，共用设备时可能并入别人的账户）。 |

## 提议的英文条文

以下按条给出完整的新文本；未列出的条款不变。方括号 `[…]` 是运维确认后才能填的事实，**不确认不上线**。

### 2. What we collect — 增加三项（放在 “Operational data” 之后）

> **Visit data:** when you open a page, a random identifier that your browser creates and keeps (not
> your account and not your IP address), the page's path, the host name of the site that linked to it,
> and the campaign tag in the link (for example `?src=…`) if there was one. We use it to count visits
> and to learn which links bring people to YUHA. If you create an account within a day of arriving, the
> campaign tag you arrived with is recorded on the account.
>
> **Trial data:** if you make a song without an account, a random identifier your browser keeps and a
> keyed hash of your IP address. The record we keep to limit free trials holds only that hash, not the
> address itself. We use these only to limit free trials per device and per network.
>
> **Photos:** if you make a photo video, your browser turns the photos you choose into video frames
> (each photo resized, with the song's lyrics drawn on it) and sends only those frames to our server to
> assemble the video. The frames are processed in temporary storage on that server; they are not saved
> to our storage or database, not used for anything else, and not sent to any model provider. They are
> deleted as soon as the video is made or fails, and in any case within 24 hours. The original photos
> do not leave your device.

“Service logs” 一段末尾加：

> When you sign in from a device we have not seen on your account, we email you a notice that includes
> that device's IP address and browser, so you can recognise a sign-in that was not you.

### 4. Who processes your data — 整段替换

> We use these service providers, each only for the purpose stated:
>
> - **Amazon Web Services** (Tokyo region): hosting, database, file storage, queues[, email].
>   Pages are delivered through Amazon CloudFront, which serves them from locations near you.
> - **Our own music server** [location]: turns your description and lyrics into music. It is operated
>   by us, not by a third party.
> - **TokenStars** [location / underlying provider as contracted]: reads your description to plan the
>   song and writes or rewrites lyrics. It receives your description and lyrics, not your account details.
> - **Google**: sign-in with Google (your name, email address and profile picture).
> - **Stripe**: card payments (your email address and the order; card details go to Stripe, not to us).
>
> We do not sell personal data or use advertising or third-party analytics services.

（若 Google Fonts 未按「上线前要改的代码」4 自托管，需在此加一行 Google Fonts：「the site's fonts are
loaded from Google, which receives your IP address and browser information」。）

### 6. Retention — 整段替换

> - **Account data and your songs:** while your account exists. When you delete a song, its audio is
>   deleted after [90] days; when you delete your account, your personal details are removed and your
>   songs are deleted, except records we must keep by law (payments) and the authorship records of songs
>   whose licences were sold.
> - **Songs made without an account:** deleted with their audio and everything entered to make them
>   7 days after they were made, unless you add them to an account before then.
> - **Trial data** (the device identifier and the hash of your IP address): deleted 7 days after the
>   trial, whether or not you then create an account.
> - **Visit data:** deleted after 13 months. The random identifier in your browser stays until you clear
>   your browser's storage; the campaign tag there is kept for 30 days.
> - **The campaign tag recorded on an account:** while the account exists.
> - **Service logs:** [N] days. **Backups:** [N] days, after which deleted data is gone from them too.
> - **Our music server** keeps the description and lyrics it was given, and the audio it made, for
>   [N] days.

（访问数据 13 个月、作曲服务器保留期都是**提议**，需要代码配合，见下。）

### 9. Local storage — 整段替换

> We use your browser's local storage for: your sign-in session; your language; drafts of unsent
> creations; the random visit identifier and, for 30 days, the campaign tag described in section 2; the
> random trial identifier and a trial session, until the trial is added to an account or expires; which
> gift songs you have already opened, so the opening is shown only once; and where to return after a
> payment. We set one cookie, only while you sign in with Google, to protect that sign-in from being
> hijacked; it lasts at most 10 minutes. No advertising or tracking cookies are used.

## 上线前要改的代码（审定前就可以做，开关仍关闭）

条文要说真话，下面几处代码先改，否则条文写了也不成立：

1. **照片临时文件的清扫。** API 启动时、以及每小时，删除临时目录里超过 1 小时的 `yuha-video-*`。
   使「最长 24 小时内删除」在进程崩溃时也成立。
2. **认领后的试做哈希也在 7 天时清除。** 现在只清未认领的。
3. **IP 哈希的密钥。** 现在密钥缺失时会退回一个写在代码里的公开字符串，等于没有密钥（IPv4 可以穷举还原）。
   改为：生产环境没有专用密钥时，免注册试做不启动（返回「暂不可用」），不退回公开字符串。
4. **Google Fonts 改为自托管。** 字体文件放到自己的 CloudFront 上，每个访问者的 IP 就不再发给 Google，
   第 4 条也少一个处理方。
5. **作曲服务器的保存期限和传输加密。** DGX Spark 上的任务记录（含描述、歌词）和音频目前永久保存，
   7 天删除的承诺到不了那里。需要给它加定期清理（建议 30 天，与音频已经存入 S3 的时间对齐），并给它与 AWS
   之间的连接加 TLS。这台机器由产品负责人的同事运维，代码可以由我们写好。
6. **访问数据 13 个月清理。** `analytics_events` 目前永不删除。
7. **认领流程改为用户主动确认**（下一节）。

## 免注册试做的认领流程（对应意见「明确的认领流程」）

现在：试做后在这台浏览器上登录任何账户，试做的歌**自动**并入该账户，不问。共用设备时会并入别人的账户。

改为：

1. 登录后，如果这台浏览器上有未认领的试做，页面显示一条：「这台设备上有一首没注册时做的歌《…》，要加到这个账户吗？」
   按钮「加到我的账户」「不用了」。
2. 只有按「加到我的账户」才并入；按「不用了」则这首歌照常在 7 天后删除。
3. 并入时，账户这一侧重新确认年龄和条款（账户本来就要确认，确认记录写在账户上；试做时的确认不转移）。
4. 一首试做只能并入一次，先确认者得（现有逻辑）。

## 请律师特别看的几点

1. **IP 的带密钥哈希**算不算个人信息（「個人関連情報」或「仮名加工情報」）。做法：HMAC-SHA256，专用密钥只在生产
   环境的密钥存储里，7 天后删除，限次记录里不存原始 IP。
2. **照片里可能有他人和儿童。** 我们只临时处理合成帧，不保存。上传前是否需要提示「请确认你有权使用这些照片」，
   以及使用条款（用户内容）是否需要提到照片。
3. **访问数据保存 13 个月**是否合适。
4. **日文版**：现行隐私政策只有英文。若需要日文正本，这次一起出。
5. **第 4 条的写法**：TokenStars 背后的模型服务商（观测为 Azure OpenAI 日本东部）是否需要写出；
   向境外提供（個人情報保護法第 28 条）是否适用——取决于 TokenStars 与其上游的实际处理地点，需要合同确认。

## 上线顺序

1. 运维确认上面方括号里的事实（区域、备份、日志、作曲服务器位置）。
2. 「上线前要改的代码」1–7 合并上线（开关仍关闭）。
3. 律师审定条文（可能有修改）。
4. 同一个提交里：改 `Legal.tsx` 的 `Privacy()` 和使用条款，`LEGAL_TEXT_REVIEWED` 保持 `true`，
   注释里写明审阅日期和范围（与 2026-10-19 那次的写法一致）。
5. 然后才打开免注册试做和照片 MV 的开关。

---

# 附录：年龄要求（方案 A）— 待律师审阅（第二版）

> 第一版 2026-11-24 上午；第二版同日下午，按产品负责人转来的六点意见改写。
> 方向不变：**免费做歌放宽年龄，付费仍要成年**。审定前，代码和页面一个字都不改。

## 定下来的原则（来自意见 1–6）

| # | 原则 |
| --- | --- |
| 1 | **最低年龄暂定 13 岁**。这是本产品的使用门槛，**不是**日本法上统一的独立订约年龄或个人信息同意年龄。13–17 岁的用户应取得法定代理人的同意，**免注册试做也一样**。 |
| 2 | **购买仅限 18 岁以上，现阶段不设监护人同意的例外**。覆盖额度、订阅、授权和稳定币付款。 |
| 3 | 自报年龄**不当然构成**民法第 21 条的「诈术」。保留独立的年龄确认记录和交易记录，但条款和页面**不写**「谎报年龄则不得撤销或退款」之类的话。 |
| 4 | 个人信息的同意**不能只按年龄划线**。是否需要本人或代理人同意，要结合具体处理内容和本人的理解能力判断；用 Google 账号登录**不替代**这一判断。 |
| 5 | 免费**不等于**条款当然有效。内容许可、禁止行为等仍可能形成义务，需要审查代理人同意的范围和证据。 |
| 6 | **未成年人和年龄未确认者不接收营销邮件**。必要的服务通知（登录提醒、付款通知）与促销分开。 |

## 页面和记录（审定后才做）

| | 现在 | 方案 A |
| --- | --- | --- |
| 做歌前（含免注册试做） | 勾选「我已年满 18 岁」+ 同意条款 | 选择其一：「我已年满 18 岁」或「我 13–17 岁，已取得父母或监护人的同意」；+ 同意条款。未满 13 岁不能继续 |
| 购买前（额度、订阅、授权、稳定币） | 无单独确认（注册时确认过 18 岁） | 每次付款前单独确认「我已年满 18 岁」，记录时间；未成年账户看不到付款按钮，说明「购买需年满 18 岁」 |
| 记录 | `users.age_confirmed_at`、`terms_accepted_at`（只有时间） | 分开记：年龄区间（18+ / 13–17 且有代理人同意）、确认时间、条款版本；每次付款的 18 岁确认写在订单上 |
| 营销邮件 | `marketing_opt_in`（目前没有任何代码发营销邮件） | 13–17 岁和年龄未确认的账户一律不发，即使勾选过；勾选框对他们不显示 |

已经确认过 18 岁的现有账户，保持 18+，不需要重新确认。

## 提议的英文条文

### 使用条款第 2 条（Accounts）— 第一句替换为：

> You must be at least 13 years old to use the Service. If you are under 18, you may use the Service
> only with the consent of a parent or legal guardian, and you may make songs only with the free
> credits included with your account; buying credits, a subscription or a licence, including with
> stablecoins, requires being 18 or older.

### 使用条款第 3 条（Credits, plans and payment）— 末尾增加一句：

> Before each purchase you confirm that you are 18 or older. We keep a record of that confirmation with
> the order.

（按原则 3，**不**加「虚假确认则不得撤销」之类的表述。）

### 隐私政策第 8 条（Children）— 整段替换：

> The Service is not directed to children under 13, and we do not knowingly collect personal data from
> them. Users from 13 to 17 may use the Service with the consent of a parent or legal guardian, and may
> not make purchases. We do not send marketing email to users under 18 or to users who have not
> confirmed their age. If you believe a child under 13 has given us personal data, or that a minor is
> using the Service without consent, contact us and we will delete the data.

## 还需要律师确认的问题

1. **代理人同意的方式和证据。** 13–17 岁用户勾选「已取得父母或监护人同意」是否足够；如果不够，最低要做到什么
   （例如监护人邮箱确认）。免注册试做（没有账户、不收邮箱）时，勾选是否足够。
2. **同意的范围。** 代理人同意应覆盖哪些：注册、做歌、个人信息处理、每首歌附带的使用条件（原则 5）。
   条款里是否要把这些写成一句话让代理人一次同意。
3. **个人信息同意的判断**（原则 4）：本服务处理的内容（邮箱、描述文字、歌词、作品），对 13–17 岁用户
   是否需要代理人同意，还是本人同意即可；这个判断是否要按功能分开（例如照片 MV）。
4. **记录保存**：年龄确认、代理人同意的记录保存多久。
