# 浏览器扩展桥（Browser Bridge）安装指南

本文档用于 `/install` 的 `browser-bridge` 安装项。它安装一个 Chrome MV3 扩展，为 `browser` 工具提供一个**显式选择、能力有限、失败关闭**的 `extension` 通道。默认 `browser open` 仍使用 `managed` headless；Pi 不会因为检测到扩展而自动接管日常 Chrome，也不会在扩展断连时静默回退到 managed/CDP。

## PURPOSE

在保留用户 Chrome 登录态和真实浏览器环境的标签页上使用 URL/title、导航、页面 evaluate、raw CDP/CDP batch、cookies、tabs 和 CDP screenshot。它不是完整 Puppeteer `Page`，不提供 ElementHandle、request interception、frame event、DOM helper 等 parity。

统一术语：

- **channel**：`managed | profile | cdp | extension`，决定后端。
- **visible**：控制 Pi 启动的浏览器进程是否可见；不是 channel。
- **ownership**：`owned | borrowed`，决定 close 是否关闭真实标签页/浏览器。
- **capabilities**：每个命名 tab 实际支持的能力；unsupported API 会列出支持清单并失败关闭。

> ⚠️ **安全提示**：此扩展可执行页面 JavaScript 和 raw CDP。默认 `paired` 的 token 是凭证授权边界，未批准的 discovery socket 没有命令权限；显式 `none`（NONE）只做 nonce/实例连续性握手，**没有凭证授权**。loopback/Origin 检查不是恶意本地进程的安全边界；只在接受该风险时启用 NONE。安装时扩展还会默认启用动态规则 9999，剥离所有站点的 CSP 响应头，以支持严格 CSP 页面的 MAIN-world evaluate；不接受该风险时不要安装，或在 Chrome 中禁用/移除扩展。当前有限 browser adapter 不暴露 `management`、`contentSettings` 或 `dnr` 管理面。

## INTERACTIVE INPUTS

执行前必须用 `ctx.ui` 交互式确认：

- 用户是否允许在 `chrome://extensions` 开启开发者模式并手动加载未打包扩展。
- 用户选择默认 `paired`，还是接受无凭证授权风险并在启动 Pi 前设置 `PI_BROWSER_BRIDGE_AUTH_MODE=none`；NONE 不需要 token/pair。
- paired 首次连接需批准 popup 与 `browser status` 显示的同一 requestId/code；默认端口不需手动复制。
- 用户理解 `extension` 必须通过 `app.channel: "extension"` 显式选择，断连不会操作另一个浏览器。

默认发现范围为 `19222..19231`。扩展会发现并保持**多个 listener** 的连接，而不是用新连接替换旧连接；每个 Pi 进程占用范围内一个可用 loopback 端口。只有合法 Bridge handshake 才进入 ready。自定义端口列表与旧版 token 输入在 popup **Advanced（高级设置）** 中。

## PREREQUISITES

- Chrome、Chromium 或兼容 Chromium 的浏览器。
- 扩展目录随包发布在 `optional/browser-bridge/`。
- `ws` 依赖已随包声明；无需外部 API 凭证。

## TASK

### 1. 启动桥

操作前先调用 `browser({action:"guide"})` 获取索引，再加载相关 SOP，然后：

```javascript
browser({ action: "status" })
```

`status` 是显式 live probe：默认在 `19222..19231` 绑定一个可用端口；被占端口会跳过，十个端口全部不可用时明确失败。

认证模式必须在启动 Pi 前选定（省略即 `paired`）：

```bash
PI_BROWSER_BRIDGE_AUTH_MODE=none pi       # Bash；显式无凭证授权
# PowerShell: $env:PI_BROWSER_BRIDGE_AUTH_MODE='none'; pi
```

NONE 不读写 legacy token 配置，不需要生成/粘贴 token，不调用 `browser pair`。已有 paired 凭证不应拿来“修复”正常的 NONE 状态。

若设置 `PI_BROWSER_BRIDGE_PORT`，server 范围变为该起点到起点+9（起点须为 1..65526 的整数）。扩展无法读取 Pi 环境：在 popup **Advanced** 的端口列表中添加 status 返回的实际 `listeningPort`（若 server 跳过被占端口，不要只填起点）；可填多个端口，逗号或空白分隔。NONE 留空 token，保存后再查 status。默认十端口仍会扫描。

### 2. 定位并加载扩展

扩展文件位于 pi-maestro-flow 包的 `optional/browser-bridge/`。向用户给出绝对路径，然后由用户执行：

1. 打开 `chrome://extensions`。
2. 开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择 `optional/browser-bridge/` 目录。
5. 打开 “Pi Browser Bridge” popup；升级包后由用户在扩展页面重载扩展。

不要代替用户绕过浏览器的扩展安装授权。

### 3. 根据 authMode 连接

**NONE：** 加载扩展后自动发现 listener 并完成 `probe-ready-v1` 连续性握手。popup 显示 `NONE 无授权` / `已连接（无授权）`；无需配对，直接进入步骤 4。`authenticatedConnected:false` 是预期，不是断连。

**paired（默认）：** 空配置扩展自动扫描默认范围，仅接受合法 Bridge challenge。popup 显示该端口的“等待配对确认”后调用：

```javascript
browser({ action: "status" })
```

从 `bridge.pendingPairings` 取得当前 `requestId` 和六位 `code`，确认它与 popup 显示的请求一致，然后批准：

```javascript
browser({ action: "pair", request_id: "<requestId>", code: "<六位 code>" })
```

批准只对当前 socket generation、未过期且 requestId/code 完全匹配的请求生效。凭证由服务端直接下发并由扩展保存；**pairing 本身不写 verified marker，也不获得命令权限**。扩展随后关闭 pairing socket，以不会在扫描中发送 raw token 的 challenge-response 握手建立独立认证连接；只有该认证成功才写 `browser-bridge.verified`。reload 后自动认证，无需再次输入配置。popup 的旧版 token 字段只用于兼容恢复（完整 token 且只能指定一个端口）；自定义端口本身不需要 token，paired 可继续正常配对。

### 4. 用 live status 验证

再次调用：

```javascript
browser({ action: "status" })
```

检查 `bridge.serverStarted:true`、`state:"connected"`、实际 `listeningPort`，并按模式区分：

| live 字段 | NONE | paired（认证重连后） |
|---|---|---|
| `authMode` | `none` | `paired` |
| `transportReady` / `transportConnected` | `true` | `true` |
| `authenticatedConnected` | **`false`（预期）** | `true` |
| `pendingPairings` | `[]` | `[]` |

`bridge.tabCount` 是 ready transport 最新报告的 http(s) tab 数量；`serverInstanceId` / `connectionGeneration` 标识这次连接。`drainingCommands` 非零表示 caller 已结束但工作未证明终止，不能当成空闲；`namedTabs` 列出当前 Pi 的 `channel`、`ownership`、`capabilities`。

只有 `browser status` 声明实时 server/connection/tab 状态。`/install list` 是静态、无副作用的历史/配置检查：

paired 模式：

- 没有合法 `browser-bridge.verified` 握手标记：`not-installed`（即使端口文件存在）
- 有标记但标记或 `browser-bridge.json` 不完整/非法：`partial`
- 合法 verified marker + 合法配置：`installed`

paired 的 `installed` 只表示历史认证标记与配置合法；只 pairing、未认证重连不算。NONE 使用独立、带 `authMode:"none"` / `authenticated:false` 的 ready marker，不伪装为 paired verified token。两种静态标记都不是当前健康证据；以 live `status.authMode` 与 `transportReady` 为准。

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

省略 `target` 和 `url` 时会借用扩展报告的第一个可脚本化标签页。每个命名 entry 固定保存 `tabId`，并持有带 owner/connection generation 的不透明租约。多个 listener 不能同时借用同一物理 tab：冲突返回 `tab_busy`，不能偷取/释放另一 owner 的租约。busy/draining 不是停止证据；无法证明停止的操作仍占有资源直至真实 terminal。

**租约不是账号隔离**：同一 Chrome profile 的 cookies/登录态仍共享，全局 cookie 写入有资源协调但会影响该 profile；需要不同账号隔离时明确选择不同 profile/managed 环境。

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

1. `browser status` 显示 server started、预期 authMode 与实际 listeningPort。
2. NONE：popup 显示无授权连接；status ready=true、authenticated=false、pendingPairings=[]，不执行 pair。
3. paired：比对同一 listener 的 requestId/code 并批准；独立重连后 authenticated=true，reload 后自动认证。
4. 用显式 `app.channel:"extension"` 借用 tab，确认 named tab 为 borrowed、`capabilities.page:false`。
5. 抽查 `tab.title()` / `tab.cdp("Page.getFrameTree")`；不要用未声明的 Puppeteer helper 验证 parity。

## 通道选择与排障

| 场景 | 明确选择 |
|---|---|
| 无登录纯抓取 | `app.channel:"managed"`，默认 headless，owned Puppeteer |
| 日常 Chrome 默认 profile 的登录态 | `app.channel:"extension"`，有限 adapter；paired 或显式 NONE |
| 完整 Puppeteer + 自选登录环境 | `app.channel:"profile"` + 非默认 `app.user_profile_dir`；Pi 启动时可 `visible:true` |
| 用户已启动的调试浏览器 | `app.channel:"cdp"` + `app.cdp_url`，borrowed |

profile 会复用 `DevToolsActivePort`，或以 `--remote-debugging-port=0` 启动并读取动态端口。Chrome 136+ 禁止调试默认 user-data-dir，即使关闭所有窗口也不解除；请明确选择非默认目录（如 `C:/BrowserProfiles/pi-daily`），或用 extension。不会复制/切换 profile；固定端口请手动启动浏览器并选 cdp。`visible` 只控制 Pi 启动的进程，extension 拒绝它。真实 profile/stealth 都不保证 CAPTCHA 成功。

- **未发现服务**：先 status 启动 server，再确认扩展已启用；自定义起点须把实际 listeningPort 加入 Advanced，不能从 Pi env 自动发现。
- **NONE authenticated=false**：只要 transportReady=true 就是预期；不要添加 token 或重复 pair。
- **paired 待配对/认证失败**：比对当前端口与未过期 requestId/code；pair 后等待独立重连，再 status。不要把另一个 listener 的请求当作本 listener。
- **tab_busy / draining**：使用另一个未租用的 tab，或等原 owner close / 真实操作 terminal；不要把 timeout 当作强制停止或绕过租约。
- **unsupported API**：查 named tab capability 清单；需要完整 helper 时明确另选 managed/profile/cdp，不静默回退。
- **profile 无 DevToolsActivePort**：检查目录占用、浏览器 stderr/企业策略与 Chrome136 限制；关闭默认浏览器不是绕过限制的方法。

## ROLLBACK

1. 在 `chrome://extensions` 禁用或删除 “Pi Browser Bridge”。
2. 如需清除历史状态，删除 `~/.pi/browser-bridge.json`、`~/.pi/browser-bridge.verified`、兼容 `~/.pi/browser-bridge.port` 与 NONE 的 `~/.pi/browser-bridge.none/`（`PI_BROWSER_BRIDGE_DIR` 可覆盖此目录）。不要在其他 Pi listener 工作时清除其状态。
3. 关闭 Pi 会话；intelligence shutdown 会关闭 bridge server。

回滚不会改变默认 managed headless 行为。先前显式使用 `extension` 的调用会失败关闭，必须由调用方明确改选 `managed`、`profile` 或 `cdp`，不会自动切换。

## NOTES

- 扩展运行在 MV3 service worker 中，用 `chrome.alarms` 保活/重连；瞬时断连仍可能恢复，但只有新的 `browser status` 是当前 live 证据。
- paired 的独立认证连接才写 `browser-bridge.verified`；NONE 写独立 ready marker，不碰 legacy 凭证。marker 是历史证据，不是健康检查。
- bridge server 只由 `browser status`、`browser pair` 或显式 `app.channel:"extension"` open 启动；普通 managed/profile/cdp open 不启动它。
- caller timeout 会把 entry 标为 draining 并请求取消；已经开始且无法证明停止的页面 JS/Chrome API 仍由 manager 持有到真实 result/error/disconnect terminal，owned tab 不会提前关闭。
- 完整 Puppeteer Page/ElementHandle/request interception/frame event parity 不在当前版本范围内。
