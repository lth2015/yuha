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

## 第二阶段（需要 SRE 改 CDN）

让不执行 JS 的抓取器也能读到每个页面、每种语言的完整内容：构建时为每个公开页面、每种语言生成静态 HTML，
CDN 按路径和 `lang` 参数返回对应文件，找不到再回 `index.html`。需要一个 CloudFront Function，
在本仓库之外，单独提给 SRE。第一阶段上线、Search Console 里看到收录之后再决定是否需要。

## 验证

- 测试：robots.txt 禁止的路径和 sitemap 列出的路径不重叠；sitemap 的每个地址都是公开页面；
  私有页面渲染 `noindex`，公开页面渲染 `canonical` 和 `alternate`；`?lang=` 切换语言。
- 上线后：`curl https://yuha.studio/robots.txt` 返回 `text/plain` 而不是 403 XML；
  `sitemap.xml` 能被解析；用 Google Search Console 提交 sitemap（需要运营方账号，由产品负责人操作）。
