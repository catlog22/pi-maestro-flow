# 浏览器扩展桥（Browser Bridge）安装指南

本文档用于 `/install` 的 `browser-bridge` 安装项。它安装一个 Chrome MV3 扩展，为 `browser` 工具提供一个**显式选择、能力有限、失败关闭**的 `extension` 通道。默认 `browser open` 仍使用 `managed` headless；Pi 不会因为检测到扩展而自动接管日常 Chrome，也不会在扩展断连时静默回退到 managed/CDP。

## PURPOSE

在保留用户 Chrome 登录态和真实浏览器环境的标签页上使用 URL/title、导航、页面 evaluate、raw CDP/CDP batch、cookies、tabs 和 CDP screenshot。它不是完整 Puppeteer `Page`，不提供 ElementHandle、request interception、frame event、DOM helper 等 parity。

统一术语：

- **channel**：`managed | profile | cdp | extension`，决定后端。
- **visible**：控制 Pi 启动的浏览器进程是否可见；不是 channel。
- **ownership**：`owned | borrowed`，决定 close 是否关闭真实标签页/浏览器。
- **capabilities**：每个命名 tab 实际支持的能力；unsupported API 会列出支持清单并失败关闭。

> ⚠️ **安全提示**：此扩展可执行页面 JavaScript 和 raw CDP，配置 token 是授权边界，不能只依赖 localhost。安装时扩展还会默认启用动态规则 9999，剥离所有站点的 CSP 响应头，以支持严格 CSP 页面的 MAIN-world evaluate；不接受该风险时不要安装，或在 Chrome 中禁用/移除扩展。当前有限 browser adapter 不暴露 `management`、`contentSettings` 或 `dnr` 管理面。

## INTERACTIVE INPUTS

执行前必须用 `ctx.ui` 交互式确认：

- 用户是否允许在 `chrome://extensions` 开启开发者模式并手动加载未打包扩展。
- 用户理解 token 不应粘贴到聊天、日志或网页，只在扩展 popup 与本机 `~/.pi/browser-bridge.json` 之间复制。
- 用户理解 `extension` 必须通过 `app.channel: "extension"` 显式选择，断连不会操作另一个浏览器。

不要猜测端口。Pi 可能因端口冲突选择更高的空闲端口，始终以 `browser status` 生成的配置为准。

## PREREQUISITES

- Chrome、Chromium 或兼容 Chromium 的浏览器。
- 扩展目录随包发布在 `optional/browser-bridge/`。
- `ws` 依赖已随包声明；无需外部 API 凭证。

## TASK

### 1. 启动桥并生成本机配置

先调用：

```javascript
browser({ action: "status" })
```

`status` 是显式的 live probe，会启动进程持有的 loopback WebSocket server，并生成 owner-only `~/.pi/browser-bridge.json`：

```json
{
  "version": 1,
  "port": 19222,
  "token": "<随机 token>"
}
```

实际端口可能不是 `19222`。`~/.pi/browser-bridge.port` 只是兼容发现文件，不能证明扩展已安装或已连接。

### 2. 定位并加载扩展

扩展文件位于 pi-maestro-flow 包的 `optional/browser-bridge/`。向用户给出绝对路径，然后由用户执行：

1. 打开 `chrome://extensions`。
2. 开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择 `optional/browser-bridge/` 目录。
5. 打开 “Pi Browser Bridge” popup。

不要代替用户操作浏览器 UI。

### 3. 配置端口和 token

从 `~/.pi/browser-bridge.json` 复制**实际** `port` 和完整 `token` 到扩展 popup，点击“保存并重连”。两项必须同时匹配。popup 的 `已认证连接` 才代表首帧 token 认证成功；`重连中`、`未配置 token` 或 `认证失败` 都不算连接。

如需指定首选起始端口，可在启动 Pi 前设置 `PI_BROWSER_BRIDGE_PORT=<端口>`；若端口被占用，Pi 仍可能选择更高端口，因此扩展继续以配置文件为准。

### 4. 用 live status 验证

再次调用：

```javascript
browser({ action: "status" })
```

检查：

- `bridge.serverStarted === true`
- `bridge.authenticatedConnected === true`
- `bridge.state === "connected"`
- `bridge.tabCount` 是已认证扩展当前报告的 Chrome http(s) 标签页数量
- `namedTabs` 列出 Pi 当前命名 tab 的 `channel`、`ownership`、`capabilities`

只有 `browser status` 声明实时 server/connection/tab 状态。`/install list` 是静态、无副作用的历史/配置检查：

- 没有合法 `browser-bridge.verified` 握手标记：`not-installed`（即使端口文件存在）
- 有标记但标记或 `browser-bridge.json` 不完整/非法：`partial`
- 合法 verified marker + 合法配置：`installed`

`installed` 只表示曾成功认证且当前配置结构合法，不表示扩展此刻在线。

### 5. 显式使用 extension channel

借用已有标签页（`close` 只释放命名映射）：

```javascript
browser({
  action: "open",
  name: "daily",
  app: { channel: "extension", target: "example.com" }
})
```

创建 owned 标签页（`close` 会关闭该真实标签页）：

```javascript
browser({
  action: "open",
  name: "owned",
  url: "https://example.com",
  app: { channel: "extension" }
})
```

省略 `target` 和 `url` 时会借用扩展报告的第一个可脚本化标签页。每个命名 entry 固定保存一个 `tabId`，不会跟随全局默认 tab 漂移。

extension run 只支持：

- `page.url/title/goto/evaluate`
- `browser.pages`
- `tab.url/title/goto/evaluate`
- `tab.cdp/cdpBatch`
- `tab.cookies.get/set/delete`
- `tab.tabs`
- `tab.screenshot`（CDP PNG）

其他属性和 helper 确定性报错并列出支持清单；断连同样报错，不会 fallback。

## VERIFY

按顺序验证：

1. `browser status` 显示 server started；读取其实际 port。
2. popup 配置 port/token 后显示 `已认证连接`。
3. `browser status` 显示 authenticated connected 与 live tab count。
4. 用显式 `app.channel:"extension"` 借用一个标签页，确认 status 中 named tab 为 `channel:"extension"`、`ownership:"borrowed"`、`capabilities.page:false`。
5. 可选抽查 `tab.title()`、`tab.cdp("Page.getFrameTree")`、`tab.cookies.get()`；不要用未声明的 Puppeteer helper 验证 parity。

## ROLLBACK

1. 在 `chrome://extensions` 禁用或删除 “Pi Browser Bridge”。
2. 删除 `~/.pi/browser-bridge.json`、`~/.pi/browser-bridge.verified` 和兼容文件 `~/.pi/browser-bridge.port`。
3. 关闭 Pi 会话；intelligence shutdown 会关闭 bridge server。

回滚不会改变默认 managed headless 行为。先前显式使用 `extension` 的调用会失败关闭，必须由调用方明确改选 `managed`、`profile` 或 `cdp`，不会自动切换。

## NOTES

- 扩展运行在 MV3 service worker 中，用 `chrome.alarms` 保活/重连；瞬时断连仍可能恢复，但只有新的 `browser status` 是当前 live 证据。
- 成功首帧 token 认证才写 `browser-bridge.verified`。marker 是 historical verified 证据，不是健康检查。
- bridge server 只由 `browser status` 或显式 `app.channel:"extension"` open 启动；普通 managed/profile/cdp open 不启动它。
- 完整 Puppeteer Page/ElementHandle/request interception/frame event parity 不在当前版本范围内。
