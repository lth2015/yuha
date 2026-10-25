# @yuha/air · 空气作曲

第一阶段规格：`docs/AIR_COMPOSITION_SPEC.md`（#26）。独立静态应用：不依赖
api / db / providers，不发任何请求，`apps/web` 不引用它，不进入 iOS 包。

## 现在的内容：#27 iPhone 第一声测试

**不需要电脑**：同一页面已发布为 claude.ai 托管的 HTTPS 页面（私有，需登录有权限的
账号打开）。用 `#none`、`#audio-session`、`#silent-element`、`#both` 结尾的链接直接
打开对应方案。重新生成：`pnpm --filter @yuha/air artifact`，输出
`apps/air/dist/artifact.html`。托管页运行在嵌入框架里，每行的 `framed` 列会注明。

本机测试（局域网）：

```bash
pnpm install
pnpm --filter @yuha/air phone   # 局域网 HTTPS（自签名证书），端口 5180
```

1. iPhone 与电脑连同一 Wi-Fi，用 Safari 打开终端里 `Network:` 那一行的
   `https://…:5180/`，证书警告选择继续访问（自签名）。
2. 按页面上的步骤测：先「对照」+ 静音键开（应听不到），再 A、B、A + B；
   切换方案会重新加载页面，记录保存在这台手机的浏览器里；
   然后静音键关；再换浏览器、iPad、桌面。
3. 每行必须显示 `HTTPS yes`，否则那一行无效（audioSession 可能只对安全
   上下文开放）。
4. 「复制证据」，贴到 #27。页面给出的 GO / NO-GO 是按规则算出的建议，
   结论由产品负责人确认。

延迟是估计值（代码路径 + 浏览器自报输出延迟），不是声学延迟。
