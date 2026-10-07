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

browser 支持命名标签页、截图和页面内 JavaScript。操作前先 `browser({action:"guide"})` 获取 SOP 索引，再加载相关 topic。四个概念不要混用：

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
| `pair` | 仅 paired 模式批准 requestId/code |

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

需要完整 Puppeteer 与登录环境时，明确选择**非默认** profile；日常默认 Chrome 的登录态优先显式 extension（见下节）。真实指纹不保证 CAPTCHA 成功：

```javascript
browser({
  action: "open",
  name: "daily-profile",
  url: "https://example.com",
  visible: true,
  app: {
    channel: "profile",
    user_profile_dir: "C:/BrowserProfiles/pi-daily" // 用户明确选择的非默认目录
  }
})
```

若 profile 已有 `DevToolsActivePort`，Pi 复用记录的 endpoint；否则以 `--remote-debugging-port=0` 和该 user-data-dir 启动，读取动态调试端口后连接。Chrome 136+ 禁止调试默认 user-data-dir，**即使关闭所有窗口也不解除**；不会自动复制/切换 profile。明确选择非默认目录，或安装桥后选 extension；固定端口需手动启动并用 `app.channel:"cdp"` + `app.cdp_url`。profile 浏览器是 borrowed，close 不终止它。纯 stealth 不足以通过 Cloudflare managed challenge / Turnstile。

`visible` 不是 channel。它控制 Pi 启动的 managed/profile 进程；对已存在的 CDP/profile 附加无效，extension 明确拒绝。

### extension — 显式有限 adapter

先运行 `/install browser-bridge`，由用户在 `chrome://extensions` 加载包内 `optional/browser-bridge/`，升级后重载扩展。先 `browser({action:"status"})` 启动 server；每个 Pi 在默认 `19222..19231` 绑定一个可用 loopback 端口，扩展同时发现/保持多个 listener，不会替换已有 live peer。

| 模式 | 连接流程与正常 live 状态 |
|---|---|
| `paired`（默认） | 比对 popup 与本 listener `pendingPairings` 的 requestId/六位 code → `browser({action:"pair",request_id,code})` → 独立认证重连；`transportReady:true`、`authenticatedConnected:true` |
| `none`（显式 NONE） | 启动 Pi 前设置 `PI_BROWSER_BRIDGE_AUTH_MODE=none`；nonce/实例连续性握手后即 ready；**无 token、无 pair**，`transportReady:true`、`authenticatedConnected:false`、`pendingPairings:[]` |

paired 批准只下发凭证，独立认证才写 verified marker；reload 后自动认证。NONE 不读写 legacy token 配置，不把 ready 冒充 authenticated。

```bash
PI_BROWSER_BRIDGE_AUTH_MODE=none pi
# PowerShell: $env:PI_BROWSER_BRIDGE_AUTH_MODE='none'; pi
```

`PI_BROWSER_BRIDGE_PORT` 改变 server 十端口起点（1..65526）；扩展不能读取 Pi env，必须把 status 实际 `listeningPort` 加到 popup **Advanced** 端口列表。可用逗号/空格填多个自定义端口，默认范围仍扫描；NONE 留空 token。手工旧版 token 仅用于兼容恢复，不能作为 NONE 的必需步骤。

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

每个命名 entry 固定保存 `tabId`，以 owner/connection generation 的不透明租约独占物理 tab；其他 listener 同时借用会返回 `tab_busy`。borrowed close 释放映射/租约，owned close 关闭真实 Chrome tab。**租约不是账号隔离**：同一 profile 的 cookies/登录态仍共享，全局 cookie 修改也影响该 profile。

extension run 只支持：

- `page.url/title/goto/evaluate`
- `browser.pages`
- `tab.url/title/goto/evaluate`
- `tab.cdp/cdpBatch`
- `tab.cookies.get/set/delete`
- `tab.tabs`
- `tab.screenshot`（CDP PNG）

它不是 Puppeteer Page：ElementHandle、request interception、frame event、`tab.observe/click/fill/extract`、upload、OCR/detect 等未实现 API 会确定性报错并列出支持清单。断连不会改用 managed 浏览器或另一个 tab。caller timeout 也不代表已经运行的页面 JavaScript 被强制停止：命令会保持 draining，直到真实 result/error/disconnect terminal；owned tab 只在 terminal 之后关闭。

> ⚠️ 扩展可执行页面 JS/raw CDP。paired 的 token 是凭证授权边界；NONE 明确**没有凭证授权**，nonce/loopback/Origin 只是连续性/卫生检查，不防恶意本地进程。安装时还默认启用动态 DNR 规则剥离所有站点的 CSP 响应头。不能接受该风险时不要安装或禁用扩展。详见包内 `optional/BROWSER-BRIDGE-SETUP.md`。

### live status 与静态安装状态

```javascript
browser({ action: "status" })
```

status 会显式启动 bridge server，并返回：

- `bridge.serverStarted` / `listeningPort` / `state`
- `bridge.authMode` / `transportConnected` / `transportReady`
- `bridge.pendingPairings` / `authenticatedConnected`（NONE 正常为 false）
- `bridge.serverInstanceId` / `connectionGeneration`
- `bridge.drainingCommands`（非零不是空闲/停止证据）
- ready transport 最新报告的 `bridge.tabCount`
- `namedTabs[]` 的 `name/channel/ownership/capabilities`

只有 status 是 live 证据。`/install list` 按当前 authMode 检查历史状态：paired 是 verified marker + 合法 token 配置，NONE 是 `browser-bridge.none/<instance>.ready.json`，明确 authenticated=false；都不代表此刻在线。pairing 本身或单独 port 文件不算 paired installed。

### 排障

- 未发现服务：先 status 启动 server；确认扩展已启用/更新后已重载，自定义端口加到 Advanced（填写实际 listeningPort）。
- NONE authenticated=false：transportReady=true 即正常，不要添加 token/pair。
- paired 认证失败：比对正确 listener 的未过期 requestId/code，批准后等待独立重连再 status。
- tab_busy / draining：换未租用的 tab 或等原 owner close/真实 terminal；timeout 不证明页面 JS 停止，不能绕过租约。
- unsupported API：按 capability 清单操作，完整 Puppeteer 需求明确改选 managed/profile/cdp。
- profile 无 DevToolsActivePort：检查目录占用、stderr/企业策略与 Chrome136 限制；关闭默认浏览器不能绕过非默认目录要求。

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
