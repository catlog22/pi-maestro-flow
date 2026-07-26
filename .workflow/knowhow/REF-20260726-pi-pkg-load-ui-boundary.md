---
title: Pi 扩展包加载与 UI 注入边界（多扩展协作红线）
description: pi 不扫传递依赖故捆绑发布要靠运行时 side-effect 激活；setWidget 多 key 并存互不可删致 TODO/teammate 撞车去重无法单方面完成；setFooter 单槽可替换；teammate roster 无全量快照不可回填而 todo 有 todo-state 快照可回填
type: reference
explicitId: ref-20260726-pi-pkg-load-ui-boundary
created: 2026-07-26T02:09:09.015Z
keywords:
  - 包加载
  - 传递依赖
  - UI注入
  - setWidget
  - setFooter
  - 扩展边界
  - package-manager
  - side-effect激活
  - 去重撞车
  - todo-state
source: node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js
specCategory: arch
---

# Pi 扩展包加载与 UI 注入边界（多扩展协作红线）

> 与 `knowhow-ref-20260725-pi-extension-api-capability` 互补：那条讲"单个扩展能调哪些 API"，本条讲"多个扩展 / 多个包之间如何加载、隔离、为何会撞车"。基于 pi 0.82 的 `package-manager.js` 与 `pi-maestro-flow`/`pi-maestro-teammate` 真实结构核对。

## 1. 装配入口

- `package.json` 的 `pi.extensions` 声明入口文件；入口为默认导出函数 `export default function (pi: ExtensionAPI)`。
- 子包若要被别的包 `import`，需 `main` + `exports`（如 `".": "./src/index.ts"`），让 bare specifier 在 node/jiti 解析下命中。

## 2. 包加载红线：pi 不扫传递依赖

- pi 的 `package-manager` 解析时，**只读 `settings.packages` 里每个源自己的 `pi` 字段**（`collectPackageResources` 读 `pkg.pi`），**不遍历该包的 `dependencies`** 去加载依赖包的扩展。整个 package-manager 无"扫依赖包 pi 字段"的逻辑。
- 决定性证据：`pi-maestro-flow` 的 `dependencies` 里明明有 `pi-maestro-teammate`，但用户的 `~/.pi/agent/settings.json` 的 `packages` 仍把 teammate **单独再列一遍**——若 pi 会因依赖自动加载，teammate 就不必重复出现。
- 推论：**"A 依赖 B ⇒ 装 A 时 pi 自动加载 B 的扩展"不成立。** 想"捆绑发布、装宿主带子插件"，不能靠依赖关系。

## 3. 捆绑发布的可行绕过：运行时 side-effect 激活

- 让宿主扩展在自己的 `default export` 里 `import 子扩展 from "<子包>"; 子扩展(pi);`。pi 不区分"哪个扩展调的 API"——只要调了 `pi.on / pi.events.on / ctx.ui.setWidget / ctx.ui.setFooter` 就全局生效，等价于子扩展被独立加载。
- 前提：子包有 `main/exports`（bare import 可解析）；dev 期靠 npm workspace symlink（`workspaces:["packages/*"]` + `npm install` 生成 `node_modules/<子包>` 软链）让 jiti 解析得到；发布期靠宿主 `dependencies` 把子包拉进 node_modules。
- 已验证：`pi-maestro-flow` 自身就是用此模式 import `pi-maestro-teammate/v1/*` 的（bare specifier，`.ts` 经 exports map 解析），故该路径在生产已被证明可行。

## 4. UI 注入边界：各扩展各自 setWidget，互不可见、互不可删

- `setWidget(key, factory, {placement})` 是**多 key 并存**：不同扩展用不同 key 各画各的，互不覆盖。
- `setWidget(key, undefined)` 技术上能清任意 key（key 全局共享），但清别人注册的 key 属越权，默认不该做。
- `setFooter(factory)` 是**单槽覆盖**：后调者替换先调者。所以 cockpit 用 `setFooter` 是"替换"原生 footer（升级、不重复）；而用 `setWidget` 画 TODO 则会与宿主原生 TODO widget **并存重复**。
- 撞车实例：`pi-maestro-flow` 自己 `setWidget("todo-panel", ...)` 在输入框上方画了 todo 列表 + summary；若 cockpit 再画一份 TODO，即双份打架。**去重无法由 cockpit 单方面完成**——需宿主暴露 `hideNativeTodoPanel` 类开关，或约定不同 placement 分区共存。
- teammate 同理：teammate 扩展自己 `setWidget("teammate-agents", ..., {placement:"belowEditor"})`；cockpit 用不同 key + `aboveEditor` 可并存，但信息可能冗余，宜文档约定二选一或提供 `hideNativeAgents` 兜底（清他人 key，越权但可选）。

## 5. 数据源边界（决定列表能否冷启动回填）

- **teammate roster**：teammate 扩展只广播增量事件 `teammate:started / :message / :complete`（`shared/types.ts:184-186`），**从不广播全量 roster**（全量 `ActiveAgent[]` 在其闭包 state，外部读不到）。⇒ 自累积 roster **冷启动为空**，晚加载漏历史，无法回填。
- **todo**：todo 工具每次变更后 `appendEntry("todo-state", {version, tasks:{id→task}})`（`tools/todo.ts:1091`）写**全量快照**，且 `tool_execution_end` 触发时已同步落盘。⇒ 可 `session_start` 遍历 `getEntries()` 取最后一个 `customType==="todo-state"` 回填；增量也走"tool 事件当信号 + 重读快照"，比解析 tool args 更准（create 的 args 不含分配后的 id，解析不可行）。
- 事件总线 `pi.events.on(channel, (data:unknown)=>void)`：handler 收 `unknown`，需自行断言 payload；订阅一次不退订是常见范式（reload 双订阅因 apply 幂等可接受）。

## Context

- 包加载：`node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js`（`collectPackageResources` 读 `pkg.pi`，无依赖遍历）
- 宿主依赖 teammate 却仍单列：`packages/pi-maestro-flow/package.json` deps vs `~/.pi/agent/settings.json` packages
- flow import teammate：`packages/pi-maestro-flow/src/extension/index.ts`（`from "pi-maestro-teammate/v1/*"`）
- 原生 todo widget：`packages/pi-maestro-flow/src/extension/index.ts`（`setWidget("todo-panel", ...)`）、`src/tui/todo-overlay.ts`
- 原生 teammate widget：`packages/pi-maestro-teammate/src/extension/index.ts`（`setWidget("teammate-agents", ..., {placement:"belowEditor"})`）
- todo 快照：`packages/pi-maestro-flow/src/tools/todo.ts:145,1091`
