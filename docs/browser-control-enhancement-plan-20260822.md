# 浏览器控制能力对齐与增强规划（2026-08-22）

> 状态：能力差距分析 + 优化清单（待评审排期）
> 对标来源：`G:\github_lib\GenericAgent`（下称 GA）的 TMWebDriver + simphtml + memory/tmwebdriver_sop.md
> 本仓库现状：`packages/pi-maestro-flow/src/tools/browser/`（puppeteer-core 实现）+ `src/tools/browser-tool.ts`（工具暴露面）+ `src/teammate/browser-broker.ts`（teammate 作用域代理）
> 历史背景：`simplify.ts` 已从 GA `simphtml.py` 移植 DOM 简化能力（PROBE_JS / FIND_LISTS_JS / monitor / foldLists），并修正了原版 `nodeInfo` 未 set 导致 overlay/partition 分析失效的 dead code bug。DOM 观察层已对齐。本规划聚焦**控制层**差距——即 GA 能做、pi 当前做不到的浏览器操作。

## 0. 核心架构差异（根因）

| 维度 | GA（GenericAgent） | pi-maestro-flow（现状） | 影响 |
|---|---|---|---|
| **浏览器来源** | 用户**日常真实浏览器**（已装扩展/userscript，保留登录态/cookie/指纹） | `puppeteer.launch` 启动**新实例**（独立 `--user-data-dir` profile） | pi 的实例带自动化指纹，Cloudflare/Turnstile/hCaptcha 直接判定为 bot 并拒绝（实测：Turnstile 复选框点击后弹回未勾选、无限"正在验证..."） |
| **控制通道** | WebSocket 桥（userscript ↔ 本地 WS 服务）+ HTTP long-poll 降级 | CDP（puppeteer-core 原生） | 两者都走 CDP，但 GA 的 CDP 在真实浏览器里执行，pi 的 CDP 在受控实例里 |
| **反检测** | 不需要（真实浏览器天然可信） | **无任何 stealth 措施**（`grep stealth/webdriver` 全空，launch args 仅 `--no-first-run --no-default-browser-check`） | 这是 pi 过不了 CAPTCHA 的直接原因 |
| **profile 复用** | 天然复用（就是用户的 profile） | `~/.pi/browser-profiles/<hash>` 稳定目录 + DevToolsActivePort 探测复用 | pi 的 profile 是隔离的，无用户登录态 |
| **CDP 域暴露** | 有专门 CDP 桥扩展，`web_execute_js` 直传 `{cmd:'cdp', method, params}` | 仅 puppeteer `page.evaluate` 级 JS，**未暴露原生 CDP domain 调用** | pi 无法做 `DOM.setFileInputFiles` / `Page.captureScreenshot`（CDP级）/ `Page.createIsolatedWorld`（跨域 iframe）等 |
| **Cookie 管理** | CDP `Network.getCookies` / `cookies` 命令 | `web-access/chrome-cookies.ts` 仅读 Google 服务 cookies（为 Gemini Web），**无通用 cookie 读写 API** | pi 无法在浏览器会话里增删查改任意域 cookie |
| **文件上传** | CDP `DOM.setFileInputFiles`（batch 链）+ DataTransfer API 兜底 | **无**（puppeteer `elementHandle.uploadFile` 未在 tab API 暴露） | pi 无法处理 `<input type=file>` |
| **物理坐标点击** | CDP 三事件序列（mouseMoved→Pressed→Released）+ 屏幕坐标换算 | 无（`tab.click(selector)` 走 puppeteer DOM click，非坐标） | pi 无法点击 canvas/非 DOM 元素、无法精确点击带 hover 依赖组件 |
| **跨域 iframe** | `Page.getFrameTree` → `Page.createIsolatedWorld` → `Runtime.evaluate` | 仅同源 iframe（simplify.ts 穿透 `contentDocument`，跨域 catch 静默丢弃） | pi 无法操作第三方支付/嵌入式 iframe |
| **closed Shadow DOM** | `DOM.getDocument({depth:-1, pierce:true})` | 无（simplify.ts 只穿透 `shadowRoot`，open 模式） | pi 无法操作 closed shadow 组件（如部分 Web Components） |
| **autofill 释放** | CDP `Page.bringToFront` + 物理点击释放保护值 | 无 | pi 无法自动登录带 autofill 的站点 |
| **扩展管理** | CDP `management` 命令（list/reload/disable/enable） | 无 | 不常需，但 GA 能 |
| **contentSettings** | `contentSettings` 命令绕下载弹窗 | 无 | pi 遇"下载多个文件"弹窗会阻塞 |

## 1. 能力维度级对比（已对齐项省略）

### 1.1 已对齐（无需改动）

| 能力 | GA | pi | 说明 |
|---|---|---|---|
| DOM 简化 HTML | `simphtml.get_html` | `tab.extract('probe')` / `PROBE_JS` | pi 已移植并修 bug |
| 列表发现/折叠 | `find_changed_elements` + 手动 | `FIND_LISTS_JS` + `foldListsJs` | pi 已移植 |
| 变化检测 | `find_changed_elements` | `tab.diff(before)` / `diffHtml` | pi 已移植 |
| 瞬态文本捕获 | `get_temp_texts` + `start_temp_monitor` | `tab.monitorStart/Stop` | pi 已移植 |
| 同源 iframe 穿透 | `cloneNode` 递归 | `cloneNode` 递归（simplify.ts） | 一致 |
| JS 执行 | `web_execute_js` | `page.evaluate` + `tab.evaluate` | 一致（pi 多了 helper 体系） |
| 截图 | CDP `Page.captureScreenshot` | `tab.screenshot` / `page.screenshot` | 一致（pi 还保存文件+内联） |
| 标签页管理 | `get_all_sessions` / `set_session` | `tab.tabs()` / `browser.pages()` / named tab | pi 用命名 tab 更 ergonomic |
| 导航 | `jump()` / `location.href` | `page.goto` | 一致 |

### 1.2 pi 优势（GA 没有）

| 能力 | pi 实现 | 价值 |
|---|---|---|
| profile 进程回收 | `reclaimProfileProcesses` / `staleProfileProcessesExist` | 崩溃后遗留 chrome 子进程不锁死 profile |
| 运行级错误提示增强 | `browserRunErrorHint` | `X is not defined` 自动提示 page.evaluate 上下文隔离 |
| 顶层变量安全遮蔽 | `compileRunCode` 用 collision-resistant param + var alias | 用户代码里 `const page = ...` 不冲突 |
| request 监听作用域隔离 | `installRequestListenerScope` | 多次 run 间 listener 不泄漏 |
| teammate 作用域代理 | `ScopedTeammateBrowserManager` | 子 agent tab 名物理隔离，互不干扰 |
| abort/timeout 全链路 | `raceAbort` / `acquireResource` / `combineSignals` | 中断及时、资源不泄漏 |
| 可视化渲染 | `renderCall` / `renderResult` | TUI 里友好展示 |

## 2. 优化清单（按优先级分波）

> 命名约定：`P0` = 阻塞真实场景（已实证失败）、`P1` = 高频能力缺口、`P2` = 长尾增强。
> 每项含：动机、改造点（文件/函数级）、验收标准、风险。

### Wave 0（P0，反检测基座 —— 解决"过不了验证码"根因）

> 实测证据：用当前 browser 工具注册 `newapi.liubaitech.cn`，Cloudflare Turnstile 复选框点击后弹回未勾选、无限"正在验证..."。GA 在真实浏览器里同站可过。

| ID | 标题 | 改造点 | 验收 | 风险 |
|---|---|---|---|---|
| **B-0.1** | **attach 模式：连接用户已开浏览器** | `manager.ts` `connectBrowser` 新增分支：当 `app.attach_user_profile` 为真，探测用户默认 Chrome profile 的 `DevToolsActivePort`（若浏览器已用 `--remote-debugging-port` 启动），或引导用户以调试端口启动后 `puppeteer.connect({browserURL})`。不启动新实例、不复制 profile。`browser-tool.ts` `app` schema 增 `attach_user_profile?: boolean` + `user_profile_dir?: string`。 | 用户在已登录的日常浏览器里执行任务，CAPTCHA 可过、登录态保留。 | 用户需以 `--remote-debugging-port=9222` 启动浏览器（文档说明）；多窗口争用同一 CDP 端口需协调。 |
| **B-0.2** | **stealth 补丁** | 新增 `browser/stealth.ts`：在 `#configurePage` 后 `page.evaluateOnNewDocument` 注入 `Object.defineProperty(navigator,'webdriver',{get:()=>undefined})`、伪造 `navigator.plugins/languages/chrome`、`window.chrome.runtime`、`permissions.query` 降级。launch args 增 `--disable-blink-features=AutomationControlled`、去掉 `--enable-automation`。 | `navigator.webdriver === undefined`；CDP `Runtime.evaluate('navigator.webdriver')` 返回 undefined；headless 下常见指纹检测页面通过。 | 纯 stealth 对 Cloudflare managed challenge 不足（需配合 B-0.1 真实浏览器）；可能被未来 Chrome 版本检测演进。 |
| **B-0.3** | **headed 默认化文档** | `docs-site/.../guides/` 新增/更新浏览器指南，明确"过验证码/保留登录态场景必须 `visible:true` + attach 模式"，把当前"默认 headless"改为"headless 适合纯抓取，headed+attach 适合带验证/登录场景"。 | 指南里有决策树：抓取→headless；登录/验证码→headed+attach。 | 无 |

### Wave 1（P1，高频能力缺口 —— 原生 CDP 域 + 通用 cookie + 文件上传）

| ID | 标题 | 改造点 | 验收 | 风险 |
|---|---|---|---|---|
| **B-1.1** | **暴露 CDP 原生 domain 调用** | `manager.ts` 新增 `cdpSend(page, method, params)` 封装 `page.target().createCDPSession()` + `session.send(method, params)`，缓存 session。`tab` API 增 `tab.cdp(method, params)`，在 run code 里可直接 `await tab.cdp('Page.captureScreenshot', {format:'png'})`。 | run 代码可调用任意 CDP domain method；返回原始 JSON 结果。 | CDP session 生命周期需与 page 绑定、跨导航失效需重建；需文档列出常用 method。 |
| **B-1.2** | **通用 Cookie 读写 API** | `tab` API 增 `tab.cookies.get/set/delete({domain,name,value,...})`，底层 `page.cookies()` / `page.setCookie()` / `page.deleteCookie()`。与现有 `web-access/chrome-cookies.ts`（离线读 Google cookie）解耦——这是在线会话级 cookie 管理。 | run 代码可查/增/删任意域 cookie，跨任务保留登录态。 | puppeteer cookie API 已成熟，风险低；注意 HttpOnly/SameSite 语义。 |
| **B-1.3** | **文件上传** | `tab` API 增 `tab.uploadFile(selector, filePaths)`，底层 `await (await resolve(selector)).uploadFile(...filePaths)`。同时保留 `tab.cdp('DOM.setFileInputFiles', ...)` 高级路径供瞬态 input。 | `<input type=file>` 可上传本地文件；多文件支持。 | puppeteer `uploadFile` 不触发 `isTrusted` 事件链，部分框架需补 `input`/`change` 事件（文档标注）。 |
| **B-1.4** | **CDP 级截图（后台 tab 全页）** | `tab.cdp('Page.captureScreenshot', {format, captureBeyondViewport, clip})` 返回 base64；`tab.screenshot` 文档补此路径用于"后台 tab 无需前台的全页高清截图"。 | 后台 tab 截图无需 `bringToFront`，不干扰当前焦点。 | 大图 base64 体积，需截断保护（已有 60K 限制可复用）。 |

### Wave 2（P2，长尾增强 —— 跨域 iframe / closed shadow / 物理坐标 / autofill）

| ID | 标题 | 改造点 | 验收 | 风险 |
|---|---|---|---|---|
| **B-2.1** | **跨域 iframe 穿透** | `tab` API 增 `tab.evalInFrame(frameSelector|urlMatcher, jsFn, ...args)`：`Page.getFrameTree` 找 frameId → `Page.createIsolatedWorld({frameId})` → `Runtime.evaluate({contextId})`。封装为一次调用。 | 第三方支付 iframe / 嵌入式编辑器可执行 JS。 | `Target.attachToTarget` 在扩展受限，但 puppeteer CDP session 不受限，可行；frame 生命周期需处理。 |
| **B-2.2** | **closed Shadow DOM 穿透** | `tab.cdp('DOM.getDocument', {depth:-1, pierce:true})` + `DOM.querySelector` + `DOM.getBoxModel`（四点平均算中心）。`tab` API 增 `tab.pierce(selector)` 返回 nodeId/坐标。 | closed shadow Web Component 可定位可点击。 | nodeId 跨 DOM 变更失效，需 `backendNodeId` 或重新 getDocument（文档标注）。 |
| **B-2.3** | **物理坐标点击（CDP 三事件序列）** | `tab` API 增 `tab.cdpClick(x, y, {hoverMs})`：`Input.dispatchMouseEvent` 依次 `mouseMoved` → `mousePressed` → `mouseReleased`（间隔 50-100ms）。提供 `tab.toPhysical(rect)` 坐标换算（`screenX + chromeH + dpr`）。 | canvas/非 DOM 元素、hover 依赖组件（MUI Tooltip/Ant Dropdown）可点击。 | 首次 attach infobar 偏移（attach 后再测坐标）；transform:scale/zoom 需修正。 |
| **B-2.4** | **autofill 释放** | `tab` API 增 `tab.autofillRelease(selector)`：`Page.bringToFront` → `tab.cdpClick` 字段 → 等 500ms → 补 `input`/`change` 事件 → 或直接点登录按钮。 | 带 Chrome autofill 的登录页可自动登录。 | 仅前台 tab 可释放（Chrome 限制）；需文档标注。 |
| **B-2.5** | **下载弹窗绕过** | `tab.cdp('Browser.setDownloadBehavior', {behavior:'allow', downloadPath})` 或 `contentSettings` 等价 CDP。 | "下载多个文件"弹窗不阻塞。 | `Browser.setDownloadBehavior` 在扩展不可用但 puppeteer CDP session 可用；downloadPath 需配置。 |
| **B-2.6** | **批量 CDP（batch 链式引用）** | 参考 GA `tmwd_cdp_bridge` 的 `{cmd:'batch', commands:[...]}` + `$N.path` 引用：`tab.cdpBatch(commands)` 一次发多命令，结果可互相引用。 | 文件上传等"发现→定位→设置"多步 CDP 一轮完成，缩短时窗。 | `$N` 引用前序失败静默 undefined，需结果校验。 |

### Wave 3（P2，体系化 —— 把经验沉淀成可检索能力）

| ID | 标题 | 改造点 | 验收 | 风险 |
|---|---|---|---|---|
| **B-3.1** | **浏览器 SOP 知识库** | 在 pi 的 knowledge/spec 体系里建 `browser-sop` 类目，把 GA `memory/tmwebdriver_sop.md` 的经验（导航拆调用、CDP 坐标陷阱、跨域 iframe 方案、autofill 流程、连不上排查序）转写成 pi 风格的 spec/knowhow。 | agent 遇浏览器难题时可 `maestro search "browser cdp iframe"` 命中 SOP 并 load。 | 需逐条验证 GA 经验在 pi puppeteer 架构下是否成立（部分依赖扩展桥，需适配）。 |
| **B-3.2** | **browser 工具 prompt 指南扩充** | `browser-tool.ts` `promptGuidelines` 增补：attach 模式何时用、CDP 何时用、cookie/文件上传/跨域 iframe 的 tab.* 入口。 | agent 看 promptSnippet 即知道新能力存在与入口。 | 指南过长会稀释，需精简。 |
| **B-3.3** | **测试覆盖** | `test/browser-tool.test.ts` 增：attach 模式、cdp 调用、cookie 读写、文件上传、跨域 iframe eval、closed shadow pierce、物理坐标点击。 | 新能力有回归基线。 | 跨域 iframe/closed shadow 需测试 fixture 页面。 |

## 3. 落地建议

### 3.1 优先级与依赖

```
B-0.1 (attach) ─┐
B-0.2 (stealth) ─┼─ Wave 0：解锁验证码场景（可并行）
B-0.3 (文档)    ─┘
        │
        ▼
B-1.1 (cdp) ──┬── B-1.2 (cookie)  ── Wave 1：高频能力（cdp 是其他的基础）
              ├── B-1.3 (upload)
              └── B-1.4 (cdp screenshot)
        │
        ▼
B-2.x ── Wave 2：长尾（依赖 B-1.1 的 cdp 封装）
        │
        ▼
B-3.x ── Wave 3：知识沉淀（依赖 Wave 1/2 能力稳定）
```

### 3.2 不建议照搬的 GA 设计

- **userscript + WS 桥**：GA 需要用户手动装 Tampermonkey 扩展、本地起 WS 服务，安装链路重。pi 的 `puppeteer.connect` + `--remote-debugging-port`（B-0.1）能达到同等"接管真实浏览器"效果且零额外安装，更符合 pi 的"开箱即用"。
- **CDP 桥扩展**：GA 因 userscript 环境 `chrome.debugger` 受限才单独造桥。pi 走 puppeteer CDP session 无此限制，B-1.1 直接暴露 `session.send` 即可，无需桥协议。
- **contentSettings 命令**：GA 用它绕下载弹窗是扩展环境变通。pi 用 CDP `Browser.setDownloadBehavior`（B-2.5）更直接。

### 3.3 验证场景

落地后用以下场景端到端验证（对应开头实测失败）：
1. **注册带 Turnstile 的站点**（如 `newapi.liubaitech.cn`）：attach 用户浏览器 → visible → 走完注册流程。
2. **带 autofill 的登录**：访问已保存密码的站点 → `tab.autofillRelease` → 自动登录成功。
3. **文件上传**：任意带 `<input type=file>` 的表单 → `tab.uploadFile` → 上传成功。
4. **跨域 iframe 操作**：第三方支付页 iframe → `tab.evalInFrame` → 读取/填写。
5. **closed shadow 组件**：任意 Web Component 闭 shadow → `tab.pierce` → 定位点击。

## 4. 涉及文件清单

| 路径 | 改动类型 |
|---|---|
| `packages/pi-maestro-flow/src/tools/browser/manager.ts` | 新增 `connectBrowser` attach 分支、`cdpSend`、`#configurePage` stealth 注入、`tab` API 扩展（cdp/cookies/uploadFile/evalInFrame/pierce/cdpClick/autofillRelease/cdpBatch） |
| `packages/pi-maestro-flow/src/tools/browser/stealth.ts` | 新建（B-0.2） |
| `packages/pi-maestro-flow/src/tools/browser-tool.ts` | `app` schema 扩展、`promptGuidelines`/`promptSnippet` 更新、`BrowserParams` 增 `attach_user_profile` |
| `packages/pi-maestro-flow/src/teammate/browser-broker.ts` | 透传新 `app` 字段（自动随 manager） |
| `packages/pi-maestro-flow/test/browser-tool.test.ts` | 新增能力测试 |
| `docs-site/src/content/docs/guides/` | 新建/更新浏览器指南（B-0.3, B-3.2） |
| `docs/browser-control-enhancement-plan-20260822.md` | 本文档（进度跟踪用） |

## 5. 开放问题（需评审决策）

1. **attach 模式的用户引导**：是否接受"用户需以 `--remote-debugging-port=9222` 启动浏览器"这个前置？还是要在 pi 内部自动 spawn 一个带调试端口的、指向用户 profile 副本的浏览器（profile 复制成本高、可能触发 Chrome 单例锁）？
2. **stealth 的道德边界**：stealth 补丁用于过验证码是否在 pi 愿景范围内？还是仅 attach 真实浏览器、不主动伪装？倾向后者（B-0.1 优先，B-0.2 仅作为 headless 抓取的辅助）。
3. **CDP 暴露粒度**：`tab.cdp(method, params)` 暴露全量 CDP domain 还是白名单一组高频 method？全量灵活但易误用（如 `Page.crash`），白名单安全但需维护。倾向全量 + 文档警示。
4. **Wave 排期**：本规划不绑定版本，建议 Wave 0 进最近一次 release（解决实测失败的注册场景），Wave 1 进下一个，Wave 2/3 按需。
