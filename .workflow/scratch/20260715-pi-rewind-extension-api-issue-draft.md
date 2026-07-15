# Pi rewind extension API Issue 草稿

> 审阅状态：待用户审核，尚未发布。
>
> 官方 `CONTRIBUTING.md` 要求 Issue 保持一屏以内，并使用提交者自己的表达，同时明确反对未经人工审阅的 LLM 文案。发布前请按你的语气重写或确认正文；如果保留 AI 起草内容，发布时应明确披露。

## 发布信息

- Repository: `earendil-works/pi`
- Template: `Contribution Proposal`
- Suggested title: `Expose tree-navigation results needed by rewind extensions`
- Suggested label: `pkg:coding-agent`
- Scope: 只请求补齐现有 `navigateTree()` 公开合同，不请求把 rewind UI 合入 core。

## GitHub Issue 正文

### What do you want to change?

I am building an extension that rewinds the active session branch to an earlier user message, restores that prompt for editing, preserves the abandoned branch, and records durable rewind metadata. I am not proposing rewind UI for core.

Most of this is already supported: `ctx.sessionManager.getBranch()` exposes checkpoints, `ctx.ui.custom()` can provide the selector, and `ctx.navigateTree()` moves the leaf without deleting history. The missing piece is the result of that navigation.

The core method already returns `editorText`, `aborted`, and `summaryEntry` in addition to `cancelled`, but the public extension type and interactive adapter narrow the result to `{ cancelled: boolean }`.

I would like the public API to use a shared exported result type, for example:

```typescript
export interface NavigateTreeResult {
	cancelled: boolean;
	aborted?: boolean;
	editorText?: string;
	summaryEntry?: BranchSummaryEntry;
}
```

This should be a passthrough of the result that already exists, without adding rewind UI or policy to core.

### Why?

A rewind command must know whether summarization was aborted, which prompt Pi restored, and which summary entry was created before it can persist an accurate rewind record. Today it receives only `cancelled`; the built-in interactive adapter consumes `editorText` and discards the remaining result.

Tool-triggered workflows must also hand off to a registered command because tools receive `ExtensionContext`, while navigation is intentionally command-only. Without a complete command result, extensions must reconstruct state from session entries, rely on TUI side effects, or import private internals.

Returning the existing result keeps core minimal while making the current extension hook complete.

### How? (optional)

1. Export one `NavigateTreeResult` type from the coding-agent extension API.
2. Use it as the return type of both `AgentSession.navigateTree()` and `ExtensionCommandContext.navigateTree()`.
3. Let mode adapters perform their existing UI updates, then return the original result instead of replacing it with `{ cancelled: false }`.
4. Add an extension regression test covering `editorText`, `aborted`, and `summaryEntry` passthrough.

Current implementation references:

- `core/extensions/types.ts`: the public method only exposes `cancelled`.
- `core/agent-session.ts`: the core method already returns the additional fields.
- `modes/interactive/interactive-mode.ts`: the adapter consumes and narrows the result.

## 中文审阅说明，不随 Issue 发布

### 为什么首个 Issue 只提这个 API

补充后的正文先交代实际目标：用插件实现 session rewind，而不是要求 Pi Core 内置 rewind UI；然后说明现有 API 已经覆盖 checkpoint 读取、选择器和 tree navigation，唯一阻塞点是导航结果在公开边界被裁剪。这样维护者能看到这是一个可复现的扩展能力缺口，而不是为私有实现索要新 API。

Pi 的贡献规范强调 core minimal，并要求 Issue 一屏以内。完整 workspace rewind 还涉及文件副作用、事务补偿和 Tool Effect；全部放进一个 Issue，容易被判断为 core bloat 或大型 RFC。因此首个 Issue 仍只请求一个已经存在、证据明确、改动很小的 API 一致性修复。

### 后续可拆分的独立问题

1. **Command-capable session action**：`registerShortcut()` 当前只提供普通 `ExtensionContext`，不能直接调用 `navigateTree()`。可讨论 `registerSessionAction()`，或为明确的用户触发 action 提供 `ExtensionCommandContext`。
2. **Reversible Tool Effect contract**：当前文件恢复只能依赖非正式的 `details.fileMutation`。若需要跨内置工具和插件工具的 workspace rewind，应另提标准化 `ToolEffect`、snapshot reference、hash CAS 和补偿语义。
3. **Transactional rewind**：只有在上游认可 workspace rewind 用例后，再讨论 `prepareRewind()` / `commitRewind()`；不建议在首个 Issue 中直接要求。

### 发布前人工检查

- 用你自己的语气重写或确认英文正文。
- 确认是否愿意补充一句：`I am willing to implement this if the API direction is accepted.`
- 检查 GitHub 是否已有重复 Issue。
- 发布时只选择 `Contribution Proposal`，添加 `pkg:coding-agent`。
- 未获得维护者 `lgtm` 前不要提交 PR。
