# 搜索引擎与大模型收录

> 产品负责人 2026-11-21：「加上 SEO，欢迎大模型、搜索引擎来收录。」广告不做。

## 现状（2026-11-21 实测）

- `https://yuha.studio/robots.txt`、`/sitemap.xml` 不存在（CloudFront 回 S3 的 403 XML）。
- 线上 CDN 的行为：带扩展名的路径（`/assets/*.js`、`/brand/*.png`）直接取 S3 对象，不存在就是 403；
  不带扩展名的路径（`/pricing`、`/legal/terms`、任意 `/xxx`）一律回 `index.html`，200。
  所以放进 `apps/web/public/` 的 `robots.txt`、`sitemap.xml`、`llms.txt` 会被原样服务；
  按路由预渲染的 HTML（`/pricing/index.html`）**不会**，除非改 CDN（见第二阶段）。
- 所有路由共用一份 `index.html`：`<html lang="zh-CN">`、中文的标题和描述，`#root` 是空的。
  会执行 JS 的爬虫（Googlebot、Bingbot）能看到渲染后的页面、按路由的标题；
  不执行 JS 的爬虫（大多数大模型的抓取器：GPTBot、ClaudeBot、PerplexityBot、CCBot）只看到一个空壳。
- 语言只存在浏览器的 localStorage 里，URL 里没有，所以搜索引擎只能收录一种语言。

## 原则

- **歌曲不收录。** 歌是私有的，「公开」只是拿到链接的人能打开（CLAUDE.md）。`/song/…`、分享卡片
  已经是 `noindex`，继续保持；robots.txt 也不让爬虫进入。收录会把一个拿链接才能看的东西变成可以搜到的东西。
- **只收录公开页面**：首页、价格、法律信息、权利说明。创作、作品库、设置、后台、结账、登录都不收录。
- **欢迎大模型。** robots.txt 对所有抓取器开放公开页面，不单独屏蔽任何大模型的抓取器。
- **运营方身份不写进任何文件**，结构化数据里也不写；需要时由 `GET /v1/legal/business-disclosure` 提供。
- 公开页面和私有页面的划分只写在一个地方（`apps/web/src/lib/seo.ts`），robots.txt、sitemap.xml、
  页面的 `noindex` 都从它来，并由测试检查三者一致。

## 第一阶段（本次，不改 CDN）

1. **`?lang=zh|ja|en`**：URL 里的语言优先于浏览器里保存的语言，并保存下来。这样同一个页面有三个可收录的地址。
2. **robots.txt**：允许公开页面，禁止私有区域，给出 sitemap 地址。
3. **sitemap.xml**：每个公开页面 × 三种语言，带 `hreflang` 互指和 `x-default`。
4. **每个页面的 `<head>`**，在浏览器里随路由和语言更新：
   - 公开页面：`description`、`canonical`（带 `?lang=`）、三种语言和 `x-default` 的 `alternate`；
   - 其它页面：`<meta name="robots" content="noindex">`。
5. **不执行 JS 的抓取器能读到的内容**：
   - `index.html` 的 `#root` 里放一段三种语言的简短介绍和公开页面的链接，React 启动后替换掉；
   - `llms.txt`：YUHA 是什么、能做什么、不做什么、公开页面在哪里。价格以价格页为准，不抄进这个文件。
6. **结构化数据**：`index.html` 里一段 `WebApplication` 的 JSON-LD（名称、地址、描述、类别），不含运营方。

## 第二阶段：公开页面预渲染（2026-11-22，不改 CDN）

> 产品负责人：「做吧，做完自己检查直接上线。」起因是大模型的抓取器（GPTBot、ClaudeBot、PerplexityBot）不执行 JS。

**实测问题**：每个地址返回的都是同一个空壳：同样的中文标题、同样的首页描述、`#root` 里只有一段简介。`?lang=` 对它们无效。

**为什么不用 `/ja/pricing` 这种地址**：线上 CDN 把**所有不带扩展名的路径**都回成 `index.html`，桶里有没有同名文件都一样（实测 `/air/` 也回空壳，`/air/index.html` 才是真文件）。
带扩展名的路径按原样取 S3 对象。所以不改 CDN 的唯一做法是让预渲染页的地址带 `.html`。

**做法**
- 构建时用真实的页面组件（`renderToString`）把公开页面按三种语言各渲染一份。写到 `/{zh,ja,en}/index.html`、`/{lang}/pricing.html`、`/{lang}/help/rights.html`、`/{lang}/legal.html`。
  入口是 `apps/web/src/prerender.tsx`，执行脚本是 `apps/web/scripts/prerender.mjs`，由 `pnpm build` 调用。
- 每份文件都有自己的 `<html lang>`、标题、描述、`canonical` 和三种语言的 `alternate`。站内链接改指对应语言的预渲染页，带上构建好的 CSS。
- **这些 `.html` 地址就是规范地址**：sitemap、`canonical`、`alternate`、`llms.txt` 都指向它们。
  原因：大模型搜索返回的是它收录的规范地址，规范地址若是空壳，预渲染就白做了。
- 真人打开 `/ja/pricing.html` 时，`main.tsx` 在路由启动前把地址换回 `/pricing?lang=ja`，`?src=` 之类的参数保留。然后 React 重画整页（不做 hydration，所以两次渲染的差异不会出错）。
- **不预渲染**：条款、隐私、公司信息、特商法。它们写着运营方，运营方只能在运行时从 `GET /v1/legal/business-disclosure` 取，不能进任何文件，构建产物也是文件。这四页仍用 `?lang=`。
- 价格页预渲染的是「一次一首」、税和退订等条款；具体价格来自商品目录，运行时才加载，不抄进文件（与 `llms.txt` 一致）。
- 渲染时没有登录、没有 API、不跑 effect：渲染出来的就是页面加载数据之前的样子。

**测试**：`tests/prerender.test.ts`（每页每种语言一份；正文、标题、描述、地址正确；链接改写；模板不认识就报错）。
`tests/seo.test.ts`（规范地址、`.html` 与应用地址互转、`llms.txt` 和空壳页的链接都是规范地址）。

## 验证

- 测试：robots.txt 禁止的路径和 sitemap 列出的路径不重叠；sitemap 的每个地址都是公开页面；
  私有页面渲染 `noindex`，公开页面渲染 `canonical` 和 `alternate`；`?lang=` 切换语言。
- 上线后：`curl https://yuha.studio/robots.txt` 返回 `text/plain` 而不是 403 XML；
  `sitemap.xml` 能被解析；用 Google Search Console 提交 sitemap（需要运营方账号，由产品负责人操作）。
