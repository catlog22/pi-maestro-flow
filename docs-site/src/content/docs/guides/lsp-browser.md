---
title: "LSP 语言服务器与浏览器控制"
icon: "🌐"
---

**LSP** 提供语言服务器代码智能（诊断、定义、引用、重构）；**browser** 通过 managed/profile/CDP 或显式 extension 通道控制 Chromium。

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
lsp({ action: "symbols", file: "*" })
```

插件注册了 **LSP 自动诊断**：文件编辑后自动触发诊断检查。

## 2. browser — 通道、可见性、所有权与能力

browser 支持命名标签页、截图和页面内 JavaScript。四个概念不要混用：

- **channel**：`managed | profile | cdp | extension`
- **visible**：Pi 启动的浏览器进程是否可见；默认 managed 为 headless
- **ownership**：`owned | borrowed`；决定 close 是否关闭真实资源
- **capabilities**：当前命名 tab 真实支持的 API

默认没有变化：省略 channel/CDP/profile 选择器时使用 `managed` headless。扩展永远不会自动接管；断连也不会 silent fallback。

| Action | 说明 |
|--------|------|
| `open` | 打开或附加命名标签页 |
| `close` | 关闭/释放标签页（`all:true` 处理全部命名 entry） |
| `run` | 在命名 tab 上执行 host JavaScript |
| `guide` | 返回 browser SOP registry/index 或指定 topic |
| `status` | 显式启动/探测 bridge，返回 live 连接和命名 tab 元数据 |

### Canonical channel

| channel | 选择方式 | ownership | 能力 |
|---------|----------|-----------|------|
| `managed` | 默认，或 `app.channel:"managed"` | `owned` | 完整 Puppeteer page/browser + tab helper |
| `profile` | `app.channel:"profile"` + `app.user_profile_dir`；旧 `attach_user_profile` 兼容 | `borrowed` | 完整 Puppeteer/CDP helper，复用用户 profile |
| `cdp` | `app.channel:"cdp"` + `app.cdp_url` | `borrowed` | 完整 Puppeteer/CDP helper，附加已有端点 |
| `extension` | 必须显式 `app.channel:"extension"` | 绑定已有 tab 为 `borrowed`；按 url 创建为 `owned` | 有限 adapter，见下文 |

新旧 selector 冲突会 fail closed。例如 `channel:"managed"` 不能同时传 `cdp_url`。

### managed 与 profile

纯抓取使用默认 managed headless：

```javascript
browser({ action: "open", name: "scrape", url: "https://example.com" })
```

登录态/CAPTCHA/真实指纹优先 profile：

```javascript
browser({
  action: "open",
  name: "daily-profile",
  url: "https://example.com",
  visible: true,
  app: {
    channel: "profile",
    user_profile_dir: "C:/Users/<you>/AppData/Local/Google/Chrome/User Data"
  }
})
```

若 profile 已有 `DevToolsActivePort`，Pi 复用它；否则 Pi 以 `--remote-debugging-port=9222` 和该 user-data-dir 启动 Chrome，再通过 Puppeteer CDP 连接。该 profile 浏览器是 borrowed，close 不终止它。纯 stealth 不足以通过 Cloudflare managed challenge / Turnstile。

`visible` 不是 channel。它控制 Pi 启动的 managed/profile 进程；对已存在的 CDP/profile 附加无效，extension 明确拒绝。

### extension — 显式有限 adapter

先运行 `/install browser-bridge`。安装流程要求：

1. `browser({action:"status"})` 启动 bridge 并生成 `~/.pi/browser-bridge.json`。
2. 在扩展 popup 中复制配置文件的实际 port 和 token。
3. 再次用 status 确认 `bridge.authenticatedConnected:true`。

借用已有 tab：

```javascript
browser({
  action: "open",
  name: "daily-extension",
  app: { channel: "extension", target: "example.com" }
})
```

按 `url` 创建 owned tab：

```javascript
browser({
  action: "open",
  name: "owned-extension",
  url: "https://example.com",
  app: { channel: "extension" }
})
```

每个命名 entry 固定保存 `tabId`。borrowed close 只释放名称，owned close 关闭真实 Chrome tab。

extension run 只支持：

- `page.url/title/goto/evaluate`
- `browser.pages`
- `tab.url/title/goto/evaluate`
- `tab.cdp/cdpBatch`
- `tab.cookies.get/set/delete`
- `tab.tabs`
- `tab.screenshot`（CDP PNG）

它不是 Puppeteer Page：ElementHandle、request interception、frame event、`tab.observe/click/fill/extract`、upload、OCR/detect 等未实现 API 会确定性报错并列出支持清单。断连不会改用 managed 浏览器或另一个 tab。

> ⚠️ 扩展可执行页面 JS/raw CDP；首帧 token 是授权边界。安装时还默认启用动态 DNR 规则剥离所有站点的 CSP 响应头。不能接受该风险时不要安装或禁用扩展。详见包内 `optional/BROWSER-BRIDGE-SETUP.md`。

### live status 与静态安装状态

```javascript
browser({ action: "status" })
```

status 会显式启动 bridge server，并返回：

- `bridge.serverStarted` / `listeningPort` / `state`
- `bridge.authenticatedConnected`
- 认证扩展当前报告的 `bridge.tabCount`
- `namedTabs[]` 的 `name/channel/ownership/capabilities`

只有 status 是 live 证据。`/install list` 的 `installed` 只表示存在合法的历史 verified marker 和合法配置；它不表示扩展此刻在线。单独的 `browser-bridge.port` 文件甚至不算 installed。

### managed/profile/cdp 的高级 helper

这些 entry 的 run code 接收真实 Puppeteer `page`/`browser` 与完整 `tab` helper：

| 能力 | 入口 |
|------|------|
| 原生 CDP | `tab.cdp(method, params)` |
| CDP batch | `tab.cdpBatch([{method,params},...])` |
| Cookie | `tab.cookies.get/set/delete` |
| 文件上传 | `tab.uploadFile(selector, ...paths)` |
| 跨域 iframe | `tab.evalInFrame(matcher, fn, ...args)` |
| Shadow DOM 定位 | `tab.pierce(selector)` |
| 坐标点击 | `tab.cdpClick(x, y, {hoverMs?})` |
| DOM 观察/提取 | `tab.observe()` / `tab.extract("probe")` |
| 变化检测 | `tab.snapshot()` / `tab.diff(before)` |
| OCR/UI detect | `tab.ocr()` / `tab.detect()`（依赖本机已验证模型） |

高危 CDP method（如 `Page.crash`、`Browser.close`）会终止会话，调用前确认意图。

### 参数速查

| 参数 | 说明 |
|------|------|
| `app.channel` | canonical channel |
| `app.path` | Chromium/Chrome/Edge 可执行路径 |
| `app.cdp_url` | `cdp` channel 的已有端点 |
| `app.attach_user_profile` | legacy profile selector |
| `app.user_profile_dir` | profile channel 的 user-data-dir |
| `app.target` | extension 借用 tab 的 URL/title 子串 |
| `visible` | Pi 启动进程的可见性；默认 false |
| `wait_until` | managed/profile/cdp 导航等待策略 |
| `dialogs` | managed/profile/cdp 对话框策略 |

## 下一步

- [MCP 集成](/guides/mcp) — 其他协议连接
- [网络搜索与深度研究](/guides/smart-search) — 外部信息检索
- [权限系统](/guides/permissions) — 工具权限与只读操作
