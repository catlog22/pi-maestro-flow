# 浏览器扩展桥（Browser Bridge）安装指南

本文档用于 `/install` 的 `browser-bridge` 安装项。它安装一个 Chrome MV3 扩展，让 `browser` 工具通过 WebSocket 接管你的日常浏览器，保留登录态、CAPTCHA 能力与真实指纹，并补齐 puppeteer CDP 路线无法触达的扩展级能力（partition cookies、chrome.debugger、chrome.management、contentSettings、CSP 头剥离）。

## PURPOSE

让 `browser` 工具在你的真实 Chrome 上工作：零启动接管、零 profile 锁冲突、真登录态/指纹。扩展通道是**可选**的——未安装时 `browser` 自动回退到既有 puppeteer CDP attach/launch 路径，行为与当前完全一致，不会破坏任何现有功能。

> ⚠️ **安全提示**：此扩展安装后默认剥离**所有站点**的 CSP 响应头（`declarativeNetRequest` 规则 9999），以便在页面 MAIN 世界执行 agent 注入脚本（eval/inline）。这是扩展通道的核心能力，但也意味着你浏览的所有页面的 CSP 防护被关闭。若需关闭，调用扩展的 `dnr` 命令 `disable`（详见 NOTES）。请知悉后再安装。

## INTERACTIVE INPUTS

执行前必须用 `ctx.ui` 交互式询问用户，不得臆测或使用默认值：

- **当前 Chrome 是否已在运行**：若已运行，加载扩展后会立即触发连接；若未运行，先让用户打开 Chrome 任意页面（`about:blank` 不会加载扩展脚本，需是一个 http(s) 页面或新标签页）。
- **WS 端口**：默认 `19222`。若该端口被占用或需自定义，告知用户在扩展弹窗里改端口，并在 pi 侧设置环境变量 `PI_BROWSER_BRIDGE_PORT` 匹配。若不确定，保持默认。
- **是否允许加载未打包扩展**：需用户在 `chrome://extensions` 开启"开发者模式"并手动加载目录。不要自动修改注册表或外部扩展配置。

## PREREQUISITES

- Chrome 或 Chromium（任何基于 Chromium 的浏览器，如 Edge，均可）。
- 扩展文件随包发布在 `optional/browser-bridge/` 目录（由 `/install` 定位；本仓库工作区可直接指向该目录）。
- pi 侧无需额外凭证。`ws` 依赖已随包声明。

## TASK

### 1. 定位扩展目录

扩展文件位于 pi-maestro-flow 包的 `optional/browser-bridge/` 下。向用户给出绝对路径（用 `resolvePackageOrWorkspaceResource(["optional","browser-bridge"])` 或包根 + `optional/browser-bridge`），让用户在 Chrome 里加载该目录。

### 2. 在 Chrome 加载扩展

引导用户执行（不要代替用户操作浏览器 UI）：

1. 打开 `chrome://extensions`。
2. 右上角开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择 `optional/browser-bridge/` 目录。
5. 加载后应看到 "Pi Browser Bridge" 扩展，状态徽章（页面右下角）显示 `pi-bridge: 已连接` 或 `重连中`。

### 3. 触发 pi 侧 WS 服务器

`BrowserBridgeServer` 在首次 `browser` 操作或 `bridge-server.start()` 时自动启动。若安装时想让 `/install` 立即验证连接，可让用户随后执行一次 `browser open`（任意 URL），或显式调用 `browserBridge.start()`。实际监听端口写入 `~/.pi/browser-bridge.port`。

### 4. 端口对齐（仅自定义端口时）

若用户改了扩展端口的默认值（扩展弹窗里设置），pi 侧必须用相同端口：设置环境变量 `PI_BROWSER_BRIDGE_PORT=<端口>` 后重启 pi。默认 `19222` 时无需任何配置。

## VERIFY

按顺序验证，全部通过才算安装成功：

1. **端口文件存在**：`~/.pi/browser-bridge.port` 存在且内容是合法端口号（默认 `19222`，冲突时为 pi 自动找的空闲端口）。
2. **扩展已连接**：pi 侧 `browserBridge.isConnected()` 返回 `true`（或观察页面右下角徽章 `pi-bridge: 已连接`）。
3. **`/install list` 状态**：`browser-bridge` 显示 `✓ 已装`（端口文件存在即标记 installed）。
4. **能力抽查**（可选，需真实标签页）：让用户打开一个已登录站点，执行 `browser` 工具的 `tab.cookies.get` 应返回含 partition 标记的 cookie；`tab.cdp('Network.getCookies')` 应经 `chrome.debugger` 成功返回。

若端口文件存在但 `isConnected()` 为 `false`，状态为 `partial`：扩展可能未加载、Chrome 未开 http 页面、或端口不一致。按 INTERACTIVE INPUTS 重新核对端口。

## ROLLBACK

卸载或回退步骤：

1. 在 `chrome://extensions` 关闭或删除 "Pi Browser Bridge" 扩展。
2. 删除 `~/.pi/browser-bridge.port`（`rm ~/.pi/browser-bridge.port`）。
3. 无需移除 `ws` 依赖或改 pi 配置——未连接时 `browser` 工具自动回退 CDP 路径，无残留影响。

## NOTES

- 扩展运行在 MV3 service worker 中，用 `chrome.alarms` 保活（~24s keepalive）并在断开后 probe 重连（~5s），因此短暂的网络/休眠抖动会自动恢复。
- 扩展默认开启 CSP 头剥离（`declarativeNetRequest` 规则 9999），让 MAIN 世界注入脚本能用 `eval`/inline。严格 CSP 站点的 JS 执行因此更鲁棒；如需关闭，调用扩展的 `dnr` 命令 `disable`。
- 此通道当前为 `browser` 工具的 `tab.cdp` / `tab.cookies.get` / `tab.cdpBatch` 提供扩展级路由；完整接管（`browser open` 直连扩展通道）在后续迭代补全。未装扩展时全部走 CDP，无功能损失。
