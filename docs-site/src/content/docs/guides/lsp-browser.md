---
title: "LSP 语言服务器与浏览器控制"
icon: "🌐"
---

**LSP** 提供语言服务器代码智能（诊断、定义、引用、重构）；**browser** 通过 CDP 控制 Chromium。

---

## 1. LSP — 语言服务器集成

连接语言服务器，提供代码智能功能：

| Action | 说明 |
|--------|------|
| `diagnostics` | 获取诊断信息（错误/警告） |
| `definition` | 跳转到定义 |
| `references` | 查找所有引用 |
| `hover` | 悬停信息（类型/文档） |
| `symbols` | 文件/工作区符号列表 |
| `rename` | 重命名符号 |
| `rename_file` | 重命名文件（更新引用） |
| `code_actions` | 可用代码操作 |
| `type_definition` | 跳转到类型定义 |
| `implementation` | 查找实现 |
| `status` | 语言服务器状态 |
| `reload` | 重新加载 |
| `capabilities` | 服务器能力 |
| `request` | 原始 LSP 请求 |

### 常用示例

```javascript
lsp({ action: "diagnostics", file: "src/auth/login.ts" })
lsp({ action: "definition", file: "src/auth/login.ts", line: 42, symbol: "validateToken" })
lsp({ action: "references", file: "src/auth/login.ts", line: 42, symbol: "validateToken" })
lsp({ action: "rename", file: "src/auth/login.ts", line: 42, symbol: "validateToken", new_name: "verifyToken", apply: true })
lsp({ action: "symbols", file: "*" })  // 工作区符号
```

### 自动诊断

插件注册了 **LSP 自动诊断**：文件编辑后自动触发诊断检查，及时暴露类型与语法错误。

## 2. browser — 浏览器控制

通过 CDP 控制 Chromium，支持命名标签页、截图和页面内 JavaScript 执行：

| Action | 说明 |
|--------|------|
| `open` | 打开/附加浏览器标签页 |
| `close` | 关闭标签页（`all: true` 关闭全部） |
| `run` | 在页面中执行 JavaScript |
| `guide` | 返回工具内置浏览器 SOP（Turnstile 配方、CDP 坐标陷阱、跨域 iframe、文件上传、attach 配置） |

### 选择模式：抓取 vs 登录/验证

| 场景 | 推荐模式 | 说明 |
|------|----------|------|
| 纯抓取（无登录/验证码） | `visible: false`（默认 headless） | 自动化指纹轻、速度快 |
| 需登录态 / CAPTCHA / 真实指纹 | `visible: true` + `app.attach_user_profile` | 接管用户日常浏览器，保留登录态与指纹 |

> **重要**：纯 stealth 补丁不足以通过 Cloudflare managed challenge / Turnstile。遇到验证码场景务必使用 attach 模式接管真实浏览器。

### attach 模式：接管用户已开浏览器

attach 模式连接用户日常浏览器（已保留登录态、cookie、扩展、指纹），pi 不启动新实例、不复制 profile。

**步骤**：

1. 以调试端口启动 Chrome（需先完全退出当前 Chrome）：

   ```bash
   # Windows
   chrome --remote-debugging-port=9222 --user-data-dir="C:/Users/<you>/AppData/Local/Google/Chrome/User Data"
   # macOS
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/Library/Application Support/Google/Chrome"
   # Linux
   google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/google-chrome"
   ```

2. 在 pi 中 attach：

   ```javascript
   browser({
     action: "open",
     url: "https://example.com",
     visible: true,
     app: {
       attach_user_profile: true,
       user_profile_dir: "C:/Users/<you>/AppData/Local/Google/Chrome/User Data",
     },
   })
   ```

若探测不到调试端口，open 会报错并附带启动命令提示。pi 不会自动启动或复制用户 profile。

### run code 中的高级能力

run code 接收 `page`（puppeteer Page）、`browser`（puppeteer Browser）和 `tab`（高层 helper）。除 `tab.observe/click/extract/screenshot` 等基础能力外：

| 能力 | 入口 | 说明 |
|------|------|------|
| 原生 CDP domain 调用 | `await tab.cdp(method, params)` | 直接调用任意 CDP method，如 `Page.captureScreenshot`、`Network.getCookies`、`DOM.setFileInputFiles`；返回原始 JSON |
| 会话级 Cookie 读写 | `tab.cookies.get/set/delete` | 管理任意域 cookie；attach 模式下可直接复用用户登录态 |
| 文件上传 | `await tab.uploadFile(selector, ...paths)` | 向 `<input type=file>` 上传本地文件（路径相对 cwd） |
| 跨域 iframe 执行 JS | `await tab.evalInFrame(matcher, fn, ...args)` | matcher 为 url 子串/正则/谓词；puppeteer frames 持有跨域执行上下文 |
| closed Shadow DOM 穿透 | `await tab.pierce(selector)` → `{x,y}` | puppeteer `pierce/<sel>` 引擎穿透 **open** shadow；closed shadow 是 Chrome 限制，需 CDP `DOM.getDocument({pierce:true})` 兆底 |
| 物理坐标点击 | `await tab.cdpClick(x, y, {hoverMs?})` | CDP Input 三事件序列（moved→pressed→released）；canvas/非DOM/hover 依赖组件 |
| autofill 释放 | `await tab.autofillRelease(selector)` | bringToFront + cdpClick + 补 input/change 事件 |
| 下载弹窗绕过 | `await tab.setDownloadBehavior(dirPath)` | CDP `Browser.setDownloadBehavior` allow，避免“下载多个文件”弹窗阻塞 |
| 批量 CDP（$N 引用） | `await tab.cdpBatch([{method,params},...])` | 一轮多命令，后续 params 可用 `"$N.path"` 引用前序结果（0-indexed） |

示例：

```javascript
// 原生 CDP：后台 tab 全页截图（无需 bringToFront）
const { data } = await tab.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });

// Cookie 读写（需先导航到目标域）
await tab.cookies.set({ name: "token", value: "abc", domain: "example.com" });
const cs = await tab.cookies.get({ domain: "example.com" });
await tab.cookies.delete({ name: "token" });

// 文件上传
await tab.uploadFile("#file-input", "./report.pdf", "./cover.png");
```

> **高危 CDP method 警示**：`Page.crash`、`Browser.close`、`Target.disposeBrowserContext` 会终止浏览器会话，调用前请确认意图。

### 常用示例

```javascript
// 打开页面（命名标签页，可复用）
browser({ action: "open", url: "http://localhost:3000", name: "app" })

// 执行 JS + 截图
browser({
  action: "run",
  name: "app",
  code: "await page.screenshot({ path: 'screenshot.png' }); return document.title;"
})

// 设置视口
browser({ action: "open", url: "...", viewport: { width: 1920, height: 1080 } })

// 关闭
browser({ action: "close", name: "app" })
browser({ action: "close", all: true })
```

### 配置项

| 参数 | 说明 |
|------|------|
| `app.path` | 自定义 Chromium/Chrome/Edge 可执行文件路径 |
| `app.cdp_url` | 连接已有浏览器 CDP 端点 |
| `app.attach_user_profile` | attach 用户已开浏览器（需配合 `app.user_profile_dir`） |
| `app.user_profile_dir` | 用户 Chrome user-data-dir（须以 `--remote-debugging-port` 启动） |
| `wait_until` | 导航等待策略（load / domcontentloaded / networkidle0 / networkidle2） |
| `dialogs` | 对话框处理（accept / dismiss） |

## 下一步

- [MCP 集成](/guides/mcp) — 其他协议连接
- [网络搜索与深度研究](/guides/smart-search) — 外部信息检索
- [权限系统](/guides/permissions) — 只读工具豁免列表（含 lsp 类操作）
