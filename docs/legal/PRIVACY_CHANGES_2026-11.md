# 隐私政策修改稿（2026-11）— 待律师审阅（第四版）

> 第一版 2026-11-23；第二版 2026-11-24 上午；第三版 2026-11-24 下午，按第一轮意见改写；
> **第四版 2026-11-24 晚**，按第二轮审阅建议（`COUNSEL_RESPONSE_2026-11.md` 第二轮）修改。
> **注意：第二轮回复由产品负责人整理，注明「不能作为日本执业律师的正式审定或上线批准」。**
> 功能开关仍须等执业律师正式审定后才能打开。
>
> **范围：仍然只面向 18 岁以上**（产品负责人 2026-11-24 选定方案①）。这一版只覆盖两个新功能
> （免注册试做、照片 MV）和条文本来就漏写的事；年龄放宽（方案 A）移到附录，作为下一阶段。
>
> 现行条文在 `apps/web/src/pages/Legal.tsx`，只有英文版。代码里 `LEGAL_TEXT_REVIEWED = true` 表示「这一版经律师审过」；
> 条文一改，这个标记必须改回 `false`，审过后再改回 `true`（同一个提交）。审定前 `Legal.tsx` 一个字都不动，两个新功能的开关保持关闭。

## 第三版按律师意见改了什么

| 律师意见 | 第三版的处理 |
| --- | --- |
| 1 HMAC：不能当然认定法律类别；「不存原始 IP」只限限次记录；区分记录 7 天和密钥周期 | 条文不写法律类别，只写事实；「不保存地址本身」限定在限次记录；单写密钥的保存和更换；日志和登录提醒中的 IP 分开写 |
| 2 照片：上传前提示；条款覆盖照片、合成画面、输出视频；改为「不作持久保存」 | 页面已加律师给的提示并要求勾选（服务器同样要求，2026-11-24 已完成，开关仍关）；隐私第 2 条改为临时处理、24 小时上限；使用条款第 4 条增加照片一段 |
| 2 24 小时上限须覆盖重试和缓存 | 已核实：编码不重试；浏览器只发一次请求；响应 `no-store`，CloudFront 不缓存 POST；服务器不留副本；崩溃残留每小时清扫（已上线） |
| 3 访问数据：说明理由，分项期限 | 第 6 条分项：原始访问事件、浏览器编号、账户首次来源、汇总统计各自写；理由写明（跨年度比较推广效果）；提议原始事件改为更短（见「请律师再看」2） |
| 4 TokenStars：不能写「全部在日本」 | 第 4 条不写处理地点，写成「[待合同确认后填入]」；**A1 核实完成前不上线** |
| 5 日文版 | 审定后出日文正本，并加语言版本冲突条款（第 10 条，新增） |
| 9 记录期限分项 | 第 6 条加年龄确认、订单记录的期限（方括号待定） |
| 自动续费 | 本版不新增付款确认条款（仍是 18 岁以上，注册时已确认）；附录的方案 A 下一阶段再按此改 |
| 运维事项可能改变结论 | 方括号里的事实（区域、备份、日志、作曲服务器位置）**确认前不送审定稿** |

## 第四版按第二轮建议改了什么

| 建议 | 第四版的处理 | 状态 |
| --- | --- | --- |
| 4a 试做 7 天删除与作曲服务器 30 天冲突 | 作曲服务器保存期改为 **6 天**（每小时清理，任何副本都在 7 天内删除），条文第 6 条同步 | 代码已改（默认 6 天）；**Spark 上需在 `.env` 加 `RETENTION_DAYS=6` 并重启 music**，无需重建 |
| 4b 每小时清扫不当然保证 24 小时 | 核实：清扫删除的是**超过 1 小时**的临时目录（不是 24 小时），每小时一次，API 启动时也执行一次。只要 API 在运行，崩溃残留最长约 2 小时；Pod 被替换时临时盘随之删除。条文仍写「最长 24 小时」作为上限 | 已核实（代码和测试见 `sweepStaleVideoDirs`） |
| 4c 最终输出视频的保存方式缺失 | 核实：成品 MP4 在服务器临时目录生成，直接返回给用户的设备（`cache-control: no-store`），随临时目录一起删除，服务器不保留。条文第 2 条照片一段补一句 | 条文已补 |
| 4d Google、Stripe 不宜一律称为受托方 | 第 4 条改为「我们使用的外部服务」，分别写各自的角色；Google、Stripe 写明按其自己的政策处理 | 条文已改 |
| 5 访问数据 90 天 + 月度汇总 | **产品负责人 2026-11-24 决定：先保留 13 个月**（后台访问统计按任意日期范围读原始记录，跨年度比较推广效果需要它）。审阅建议优先 90 天 + 月度汇总，作为以后的改进项；条文写 13 个月及理由 | 已决定：13 个月 |
| 6 语言条款 | 只有日文版实际提供时才发布第 10 条；在那之前不写「本政策以日文和英文提供」。补「不限制适用法律赋予的权利」 | 条文已改 |
| 7 HMAC 密钥 | 条文不承诺固定周期；内部另定轮换、吊销、访问控制和事件响应（运维文档） | 待运维文档 |
| 8 年龄确认记录 | 记录确认事实、时间和提示版本；不收集身份证或生日。**现在只记时间，没有记提示版本**，需要补 | 待开发 |
| 9、10 TokenStars | 需写入合同、数据处理附件或有效服务条款；第 4 条按实际法人和处理链路披露，不写「集团旗下服务」 | 待合同材料 |
| 3 员工内部测试 | 员工预览页面写明条件：自愿参与的成年员工、只用本人且有权使用的照片、不用含儿童或他人的照片、不公开视频、测试后确认设备上不留视频 | 已做 |

## 已确认的事实（产品负责人提供，2026-11-24）

以下是**产品负责人的事实说明**，尚未有合同或书面依据；送律师时一并注明。

| 项目 | 当前确认内容 |
| --- | --- |
| TokenStars 归属 | 日本上市企业旗下（名称按合同写入送审稿；本仓库不写，见 CLAUDE.md 关于运营方名称的规则） |
| 训练用途 | 数据不用于训练 |
| 数据保存 | 不保存数据 |
| 处理地点 | 日本境内的 AWS、Azure、GCP |
| YUHA 部署 | AWS 东京区域 |
| 作曲服务器（DGX）物理位置 | 日本东京，办公室 |
| 邮件（SES）、文件存储（S3） | AWS 东京区域（2026-11-25 确认） |
| 数据库备份 | 7 天（2026-11-25 确认） |
| 服务器日志 | 15 天（2026-11-25 确认） |
| ALB / CloudFront 访问日志 | 不开启（2026-11-25 确认） |

**送律师前还需补齐：**

1. **签约主体**：合同上的准确法人名称。「属于某集团」不一定等于与该集团本体签约。
2. **处理范围和承诺依据**：TokenStars 具体接收哪些数据；「不保存、不训练、日本境内处理」是否覆盖网关、上游供应商及其日志；
   是否有合同或书面说明支持。
3. ~~**运维期限**~~ ✅ 2026-11-25 已确认，见上表。

> 日本境内处理是重要事实，但仅凭地点不能直接判定境外第三方提供规则（个人信息保护法第 28 条）不适用；
> 还要看处理主体和合同安排。第 4 条的写法等第 1、2 项有书面依据后再定。

## 提议的英文条文

以下按条给出完整的新文本；未列出的条款不变。方括号 `[…]` 是需要运维或合同确认的事实，**确认前不定稿**。

### 隐私政策 2. What we collect — 增加三项（放在 “Operational data” 之后）

> **Visit data:** when you open a page, a random identifier that your browser creates and keeps (not
> your account and not your IP address), the page's path, the host name of the site that linked to it,
> and the campaign tag in the link (for example `?src=…`) if there was one. We use it to count visits
> and to learn which links bring people to YUHA. If you create an account within a day of arriving, the
> campaign tag you arrived with is recorded on the account.
>
> **Trial data:** if you make a song without an account, a random identifier your browser keeps and a
> keyed hash of your IP address, used only to limit free trials per device and per network. The record
> we keep for that limit holds the hash, not the address itself. (Your IP address can still appear in
> service logs and in sign-in notices, as described below.)
>
> **Photos:** if you make a photo video, your browser resizes the photos you choose and draws them into
> video frames together with the song's lyrics; only those frames are sent to our server. The frames can
> still show people who can be identified. We process them only to assemble your video, temporarily:
> they are not stored persistently, not used for anything else, and not sent to any AI model. They are
> deleted as soon as the video is made, or, if processing fails or is interrupted, within 24 hours at
> most. The finished video is sent straight to your device and is not kept by us. The original photos do
> not leave your device.

“Service logs” 一段末尾加：

> Our servers' logs can include the IP address a request came from. When you sign in from a device we
> have not seen on your account, we email you a notice that includes that device's IP address and
> browser, so you can recognise a sign-in that was not you.

### 隐私政策 4. Services we use — 整段替换

> We use the services below. Some process data for us; others, such as Google and Stripe, also handle
> it under their own terms and privacy policies, which apply to what you give them directly.
>
> - **Amazon Web Services** (Tokyo region): the application, database, file storage, queues and
>   email. Pages are delivered through Amazon CloudFront, which serves them from locations near you.
> - **Our own music server** (in our office in Tokyo, Japan): turns your description and lyrics into music.
>   It is operated by us, not by a third party.
> - **TokenStars** [provider name as given in its published terms]: reads your
>   description to plan the song and writes or rewrites lyrics. It receives your description and lyrics,
>   which can contain personal information if you write any; it does not receive your account details.
>   It handles them as described in its own terms and privacy policy [link].
>   [Only what those published documents state — for example on retention, training and where data is
>   processed — is repeated here; nothing they do not state is promised on its behalf.]
> - **Google**: sign-in with Google, if you choose it. We receive your name, email address and profile
>   picture; Google handles your Google account under its own terms.
> - **Stripe**: card payments. We send your email address and the order; you give your card details to
>   Stripe, not to us, and Stripe handles them under its own terms.
>
> We do not sell personal data or use advertising or third-party analytics services.

### 隐私政策 6. Retention — 整段替换

> - **Account data and your songs:** while your account exists. When you delete a song, its audio is
>   deleted after 90 days; when you delete your account, your personal details are removed and your songs
>   are deleted, except records we must keep by law (payments) and the authorship records of songs whose
>   licences were sold.
> - **Songs made without an account:** deleted with their audio and everything entered to make them
>   7 days after they were made, unless you add them to an account before then.
> - **Trial records** (the device identifier and the hash of your IP address): deleted 7 days after the
>   trial, whether or not you then create an account. The key used to make the hash is kept in our
>   production secret store while free trials are offered, and replaced if it may have been exposed.
> - **Visit data:** individual page views are deleted after 13 months; we keep them that long only to
>   compare how the same campaigns perform from one year to the next. Totals that no
>   longer relate to any browser may be kept longer. The random identifier in your browser stays until you
>   clear your browser's storage; the campaign tag there is kept for 30 days.
> - **The campaign tag recorded on an account:** while the account exists.
> - **Age confirmation:** that you confirmed it, when, and which wording you were shown, kept while your
>   account exists. We do not ask for identity documents or your date of birth.
> - **Service logs:** 15 days. **Database backups:** 7 days, after which deleted data is gone from them
>   too. We do not keep access logs of our load balancer or content delivery network.
> - **Our music server** keeps the description and lyrics it was given, and the audio it made, for 6 days,
>   so that every copy of a song made without an account is gone within 7 days.

（作曲服务器：2026-11-24 已部署清理代码；保存期从 30 天改为 6 天，需在 Spark 的 `.env` 加 `RETENTION_DAYS=6` 并重启 music 后才成立。操作步骤见 `REQUESTS_2026-11-25.md` 第一部分。）

### 隐私政策 9. Local storage — 整段替换

> We use your browser's local storage for: your sign-in session; your language; drafts of unsent
> creations; the random visit identifier and, for 30 days, the campaign tag described in section 2; the
> random trial identifier and a trial session, until the trial is added to an account or expires; which
> gift songs you have already opened, so the opening is shown only once; and where to return after a
> payment. We set one cookie, only while you sign in with Google, to protect that sign-in from being
> hijacked; it lasts at most 10 minutes. No advertising or tracking cookies are used.

### 隐私政策 10. Language（新增，**只在日文版实际发布时**加入）

> This policy is published in Japanese and English, with the same content. If they differ, the Japanese
> version prevails. This does not limit any right you have under applicable law.

（日文版发布之前不加这一条，也不写「以日文和英文提供」。）

### 使用条款 4. Your songs and your content — 末尾增加一段

> If you make a photo video, you confirm before choosing photos that you have the right to use them and
> the images of the people in them, and, where children appear, the permission of their legal guardian
> where the law requires it. The photos, the frames made from them and the resulting video are your
> content under these terms; you are responsible for them, and the rights of the people shown are their
> own, separate from any copyright in the photos.

## 已经完成的代码（开关仍关闭）

| 事项 | 上线 |
| --- | --- |
| 照片临时文件每小时清扫；试做哈希 7 天清除（含已认领的）；哈希密钥无公开回退值；字体自托管；访问数据 13 个月清理；试做歌曲须用户确认才并入账户 | 2026-11-24 13:44 |
| 照片 MV 上传前的使用权提示与勾选（律师给的文字；服务器同样要求） | 本次 |
| 营销邮件：年龄未确认的账户不能开启（服务器端；现在还没有营销邮件，先把门做好） | 本次 |
| 作曲服务器 30 天清理 | 2026-11-24 已在 Spark 上部署（`update.sh`，容器内确认新代码，引擎 v15） |

## 送审前必须先完成的（A 类，代码之外）

1. **TokenStars**：产品负责人决定（2026-11-25）不另行索取书面材料，以注册时同意的公开利用規約和隐私政策为依据。
   第 4 条只引述其公开文件写明的内容，不替对方作未写明的保证（如「全部在日本处理」），并链接其政策。
   待：公开文件的链接或副本。（律师意见 4；条文措辞随修改稿请律师确认）
2. ~~**运维**~~ ✅ 2026-11-25 产品负责人确认：SES、S3 均在东京区域；数据库备份 7 天；服务器日志 15 天；
   ALB、CloudFront 访问日志不开启；作曲服务器在日本东京的办公室。已写入第 4、6 条。
3. ~~作曲服务器重新部署~~ ✅ 2026-11-24 完成。

## 请律师再看的几点（第三版）

1. 上面的条文是否已经落实第一轮意见 1–5。
2. **访问数据期限**：我们的理由是跨年度比较推广效果。另一个做法是原始事件保存 [90 天]、之后只留不可关联的按月汇总。
   哪一种更合适？
3. **语言版本冲突**：日文优先是否合适。
4. **照片提示的文字**是否按意见 2 落实（页面中文 / 日文 / 英文三种）。

## 上线顺序（18 岁以上范围）

1. 完成「送审前必须先完成的」1–2（第 3 项已完成），填好方括号。
2. 律师审定第三版（及日文正本）。
3. 同一个提交里改 `Legal.tsx`（隐私政策、使用条款、日文版），`LEGAL_TEXT_REVIEWED` 保持 `true`，注释写明审阅日期和范围。
4. 然后打开免注册试做和照片 MV（只对 18 岁以上）。

---

# 附录：年龄要求（方案 A）— **下一阶段，暂缓**

> **2026-11-24 产品负责人选定：先维持 18 岁以上。** 律师意见（`COUNSEL_RESPONSE_2026-11.md` 第 6–9 条）要求
> 为 13–17 岁建立代理人独立确认流程、日文版和分项记录期限，方案 A 因此作为下一阶段单独做。以下保留第二版内容供下一阶段参考；
> 其中「每次付款前确认」需按律师意见改为区分新订单、订阅开通或变更与之后的自动续费。

# （第二版原文）年龄要求（方案 A）

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
