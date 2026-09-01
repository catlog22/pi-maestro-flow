# 浏览器扩展桥（Browser Bridge）安装指南

本文档用于 `/install` 的 `browser-bridge` 安装项。它安装一个 Chrome MV3 扩展，为 `browser` 工具提供一个**显式选择、能力有限、失败关闭**的 `extension` 通道。默认 `browser open` 仍使用 `managed` headless；Pi 不会因为检测到扩展而自动接管日常 Chrome，也不会在扩展断连时静默回退到 managed/CDP。

## PURPOSE

在保留用户 Chrome 登录态和真实浏览器环境的标签页上使用 URL/title、导航、页面 evaluate、raw CDP/CDP batch、cookies、tabs 和 CDP screenshot。它不是完整 Puppeteer `Page`，不提供 ElementHandle、request interception、frame event、DOM helper 等 parity。

统一术语：

- **channel**：`managed | profile | cdp | extension`，决定后端。
- **visible**：控制 Pi 启动的浏览器进程是否可见；不是 channel。
- **ownership**：`owned | borrowed`，决定 close 是否关闭真实标签页/浏览器。
- **capabilities**：每个命名 tab 实际支持的能力；unsupported API 会列出支持清单并失败关闭。

> ⚠️ **安全提示**：此扩展可执行页面 JavaScript 和 raw CDP，配对后生成的 token 才是授权边界，不能只依赖 localhost。未批准的 discovery socket 没有命令权限。安装时扩展还会默认启用动态规则 9999，剥离所有站点的 CSP 响应头，以支持严格 CSP 页面的 MAIN-world evaluate；不接受该风险时不要安装，或在 Chrome 中禁用/移除扩展。当前有限 browser adapter 不暴露 `management`、`contentSettings` 或 `dnr` 管理面。

## INTERACTIVE INPUTS

执行前必须用 `ctx.ui` 交互式确认：

- 用户是否允许在 `chrome://extensions` 开启开发者模式并手动加载未打包扩展。
- 用户理解首次连接需要批准扩展 popup 与 `browser status` 显示的同一配对请求；无需复制 port/token。
- 用户理解 `extension` 必须通过 `app.channel: "extension"` 显式选择，断连不会操作另一个浏览器。

默认发现范围固定为 `19222..19231`。只有完成 Browser Bridge discovery handshake 的端口会被接受；port/token 手工输入仅保留在 popup 的高级故障恢复设置中。

## PREREQUISITES

- Chrome、Chromium 或兼容 Chromium 的浏览器。
- 扩展目录随包发布在 `optional/browser-bridge/`。
- `ws` 依赖已随包声明；无需外部 API 凭证。

## TASK

### 1. 启动桥

先调用：

```javascript
browser({ action: "status" })
```

`status` 是显式 live probe。默认会在 `19222..19231` 启动进程持有的 loopback server；范围内非 Browser Bridge 服务会被跳过，十个端口全部不可用时明确失败。若启动 Pi 前设置 `PI_BROWSER_BRIDGE_PORT`，它会严格校验并改用以该值为起点的十端口 server 范围；空配置扩展无法读取 Pi 的环境变量，因此自定义起点必须同时在 popup“高级设置”中填写端口。

### 2. 定位并加载扩展

扩展文件位于 pi-maestro-flow 包的 `optional/browser-bridge/`。向用户给出绝对路径，然后由用户执行：

1. 打开 `chrome://extensions`。
2. 开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择 `optional/browser-bridge/` 目录。
5. 打开 “Pi Browser Bridge” popup。

不要代替用户绕过浏览器的扩展安装授权。

### 3. 自动发现并批准一次配对

空配置扩展会自动扫描 `19222..19231`，仅接受带 `pi-browser-bridge/v1` challenge 的服务。popup 进入“等待 Pi 确认”后调用：

```javascript
browser({ action: "status" })
```

从 `bridge.pendingPairings` 取得当前 `requestId` 和六位 `code`，确认它与 popup 显示的请求一致，然后批准：

```javascript
browser({ action: "pair", request_id: "<requestId>", code: "<六位 code>" })
```

批准只对当前 socket generation、未过期且 requestId/code 完全匹配的请求生效。凭证由服务端直接下发并由扩展保存；**pairing 本身不写 verified marker，也不获得命令权限**。扩展随后关闭 pairing socket，以不会在扫描中发送 raw token 的 challenge-response 握手建立独立认证连接；只有该认证成功才写 `browser-bridge.verified`。reload 后自动认证，无需再次输入配置。port/token 手工字段只在 popup 的“高级设置”中用于故障恢复或自定义 server 起点。

### 4. 用 live status 验证

再次调用：

```javascript
browser({ action: "status" })
```

检查：

- `bridge.serverStarted === true`
- `bridge.pendingPairings` 已清空
- `bridge.authenticatedConnected === true`
- `bridge.state === "connected"`
- `bridge.tabCount` 是已认证扩展当前报告的 Chrome http(s) 标签页数量
- `bridge.drainingCommands === 0`
- `namedTabs` 列出 Pi 当前命名 tab 的 `channel`、`ownership`、`capabilities`

只有 `browser status` 声明实时 server/connection/tab 状态。`/install list` 是静态、无副作用的历史/配置检查：

- 没有合法 `browser-bridge.verified` 握手标记：`not-installed`（即使端口文件存在）
- 有标记但标记或 `browser-bridge.json` 不完整/非法：`partial`
- 合法 verified marker + 合法配置：`installed`

`installed` 只表示曾通过 legacy token 或 challenge-response 成功认证且当前配置结构合法，不表示扩展此刻在线。只完成 pairing、尚未认证重连时不算 installed。

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

1. `browser status` 显示 server started。
2. popup 自动发现并显示待配对请求；status 返回同一 requestId/code。
3. `browser pair` 批准后 popup 显示 `已认证连接`，reload 后仍自动认证。
4. `browser status` 显示 pendingPairings 为空、authenticated connected、live tab count 与 drainingCommands。
5. 用显式 `app.channel:"extension"` 借用一个标签页，确认 status 中 named tab 为 `channel:"extension"`、`ownership:"borrowed"`、`capabilities.page:false`。
6. 可选抽查 `tab.title()`、`tab.cdp("Page.getFrameTree")`、`tab.cookies.get()`；不要用未声明的 Puppeteer helper 验证 parity。

## ROLLBACK

1. 在 `chrome://extensions` 禁用或删除 “Pi Browser Bridge”。
2. 删除 `~/.pi/browser-bridge.json`、`~/.pi/browser-bridge.verified` 和兼容文件 `~/.pi/browser-bridge.port`。
3. 关闭 Pi 会话；intelligence shutdown 会关闭 bridge server。

回滚不会改变默认 managed headless 行为。先前显式使用 `extension` 的调用会失败关闭，必须由调用方明确改选 `managed`、`profile` 或 `cdp`，不会自动切换。

## NOTES

- 扩展运行在 MV3 service worker 中，用 `chrome.alarms` 保活/重连；瞬时断连仍可能恢复，但只有新的 `browser status` 是当前 live 证据。
- 成功配对后的独立 challenge-response 认证连接才写 `browser-bridge.verified`；候选端口只收到 nonce/proof，不收到 raw token。marker 是 historical verified 证据，不是健康检查。
- bridge server 只由 `browser status`、`browser pair` 或显式 `app.channel:"extension"` open 启动；普通 managed/profile/cdp open 不启动它。
- caller timeout 会把 entry 标为 draining 并请求取消；已经开始且无法证明停止的页面 JS/Chrome API 仍由 manager 持有到真实 result/error/disconnect terminal，owned tab 不会提前关闭。
- 完整 Puppeteer Page/ElementHandle/request interception/frame event parity 不在当前版本范围内。
