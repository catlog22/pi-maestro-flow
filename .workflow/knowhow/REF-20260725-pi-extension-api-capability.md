---
title: Pi 扩展 API 能力上限与实现速查（输入框背景/流式展示）
description: Pi ExtensionAPI 能力全景 + 修改输入框背景与流式展示的实现方式与硬性边界，基于真实类型签名核对
type: reference
explicitId: ref-20260725-pi-extension-api-capability
created: 2026-07-25T04:02:25.204Z
keywords:
  - Pi扩展
  - ExtensionAPI
  - 输入框背景
  - 流式展示
  - setEditorComponent
  - registerProvider
  - TUI
source: node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
specCategory: coding
---

# Pi 扩展 API 能力上限与实现速查

基于 `@earendil-works/pi-coding-agent` 的 `core/extensions/types.d.ts` 与 `@earendil-works/pi-tui` 的 `Theme`/`EditorComponent`/`Component` 真实类型签名核对。适用于 pi-open-tui 类 TUI 扩展开发。

## 一、装配机制

- `package.json` 的 `pi.extensions` 声明入口；入口为默认导出函数 `export default function (pi: ExtensionAPI)`。
- 仅依赖公共 API（peerDependencies: pi-coding-agent / pi-ai / pi-tui），零 patch，跨 Pi 版本安全。
- UI 通过 `ctx.ui.setHeader / setFooter / setEditorComponent` 三个插槽注入，组件契约是 `render(width: number): string[]`（纯函数返回带 ANSI 的行数组）。
- 每个 installer 返回 cleanup 闭包，`setXxx(undefined)` 可逆还原原生 UI。

## 二、能力上限全景（ExtensionAPI 真实签名）

**拦截/改写 LLM 全链路**
- `context` 事件：每次 LLM 调用前改写 messages。
- `before_provider_request`：替换发往 provider 的整个 payload。
- `after_provider_response`：读响应头/状态码。
- `before_agent_start`：改 system prompt / 用户 prompt。
- `registerProvider({ streamSimple })`：自定义模型/代理/原始流处理器（数据层最深入口）。

**拦截/改写/阻断工具**
- `tool_call`：`block:true` 阻断，或原地 mutate `event.input` 改参数。
- `tool_result`：改写工具返回内容。
- `registerTool`：注册 LLM 可调用新工具，`renderCall`/`renderResult` 完全自定义渲染（含流式 partial）。

**拦截用户输入**
- `input` 事件：`continue` / `transform`（改写文本）/ `handled`（吞掉）。
- `ui.onTerminalInput`：原始按键级拦截（可做 vim 模式）。

**UI 注入**
- `setHeader` / `setFooter` / `setEditorComponent` / `setWidget(key, content, {placement: aboveEditor|belowEditor})` / `custom(factory, {overlay})`。
- 对话框 `select`/`confirm`/`input`、`notify`、`setStatus`、`setTitle`。
- 流式态控制：`setWorkingMessage` / `setWorkingIndicator({frames})` / `setWorkingVisible` / `setHiddenThinkingLabel`。
- 主题：`setTheme`/`getAllThemes`/`getTheme`（可整体换主题）。

**会话控制（命令上下文 ExtensionCommandContext）**
- `newSession`/`fork`/`navigateTree`/`switchSession`/`compact`/`reload`。
- `sendMessage`/`sendUserMessage`/`appendEntry`/`setLabel`/`setSessionName`。

**注册入口**
- `registerCommand`（斜杠命令）、`registerShortcut`（快捷键）、`registerFlag`（CLI 参数）。

## 三、修改输入框背景

**关键事实**
- 主题背景色只有 6 个语义槽（`ThemeBg`）：`selectedBg / userMessageBg / customMessageBg / toolPendingBg / toolSuccessBg / toolErrorBg`。**没有 editorBg**，无法靠主题属性直接换输入框背景。
- 扩展可发射任意原始 ANSI（pi-open-tui header.ts 用 `\x1b[36m` 直接上色绕过主题）。背景色：`\x1b[48;5;Nm`（256色）或 `\x1b[48;2;r;g;bm`（真彩）。
- 输入框可整体替换：`setEditorComponent(factory)`，官方推荐继承 `CustomEditor`。

**实现骨架**
```ts
import { CustomEditor } from "@earendil-works/pi-coding-agent";
const BG = "\x1b[48;5;236m", RESET = "\x1b[49m";
class BgEditor extends CustomEditor {
  render(width: number): string[] {
    return super.render(width).map((line) =>
      BG + line + " ".repeat(Math.max(0, width - visibleWidth(line))) + RESET);
  }
}
pi.on("session_start", (_e, ctx) => {
  if (ctx.hasUI) ctx.ui.setEditorComponent((tui, theme, kb) => new BgEditor(tui, theme, kb));
});
```
要点：`super.render` 保留原生编辑/光标/补全；必须用背景色空格补满整行宽度；只能改编辑器组件自渲染区域，外围留白由 Pi 主布局控制。

## 四、修改流式展示（分三层）

**层次 1 — 数据层（最深，✅）**：`registerProvider({ streamSimple })` 包装原始流，在 Pi 渲染前看到/变换每个 `AssistantMessageEvent`（文本/reasoning delta）。

**层次 2 — 消息层（✅）**：`pi.on("message_end", ...)` 返回 `{ message }` 整体替换定稿消息（流结束后，须保持 role 不变）。

**层次 3 — 渲染层（⚠️ 受限）**：**没有** `setAssistantMessageRenderer`。Pi 内置 assistant markdown 流式渲染器固定，扩展无法替换其内联样式。`registerMessageRenderer(customType, renderer)` 只对自发自定义消息（`sendMessage({customType})`）生效。

**自定义流式 UI 组合拳**
- `message_update` 事件逐 token 观察（`event.assistantMessageEvent`）累积文本。
- `setWidget(key, factory, {placement})` 在编辑器上/下方渲染任意 Component，随流 `tui.requestRender()` 刷新。
- `registerMessageRenderer` + `sendMessage` 完全自定义消息块渲染。
- `setWorkingMessage`/`setWorkingIndicator`/`setWorkingVisible` 改/隐藏流式转圈。
- `custom(factory, {overlay:true})` 全屏自绘。

## 五、硬性边界（做不到）

1. 不能替换 Pi 内置 assistant 消息的 markdown 流式渲染器——只能观察、事后替换、或旁路自绘。
2. 背景色受 6 个主题语义槽限制；任意背景需自射原始 ANSI，且仅限自有组件 render 区域。
3. 不能改 Pi 主布局（消息列表/编辑器/header/footer 的排布顺序），只能替换插槽内容。
4. 非交互模式（print/RPC）`ctx.hasUI=false`，所有 UI API 失效，只剩事件/工具/数据层能力。

## Context

- 类型定义：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- 主题：`.../pi-coding-agent/dist/modes/interactive/theme/theme.d.ts`（ThemeColor ~40 个 fg 槽 / ThemeBg 6 个 bg 槽）
- 编辑器接口：`node_modules/@earendil-works/pi-tui/dist/editor-component.d.ts`
- 参考实现：`G:/github_lib/pi-open-tui/extensions/open-tui/`（header/footer/editor/settings-command）
