---
title: pi 0.74→0.82 迁移遗留：SDK 契约变更、typecheck 门禁缺口与依赖去重
category: debug
createdBy: manual
sourceRef: "session:2e68bf22-8236-4d9a-ba48-839dd00264b4"
status: resolved-with-external-residuals
resolvedAt: 2026-07-26
resolutionRef: ".workflow/sessions/20260726-team-issue-teammate-tui/runs/20260726-001-team-issue/outputs/builds/build-pi082-leftovers.json"
---
## Context

flow 长期以 `@earendil-works/*@0.74.0` 编译和运行（`pi-maestro-flow/package.json` 把 `pi-tui` 硬锁在 `dependencies`），而用户宿主是 pi 0.82.0。本次把三个包的 devDependencies 统一到 `0.82.1`，flow 的 `pi-tui` 改为 `peerDependencies: "*"` + optional meta，对齐 teammate/cockpit 的既有做法。对齐后 cockpit 0 错误、flow 自身类型错误 88 → 28、teammate 51（说明 teammate 的错误从来不是版本噪音）。

起因是一次 TUI 崩溃（`TypeError: child.render is not a function`），根因见 [[spec:project:debug-notes-007]]；依赖硬锁见 [[issue-ISS-20260726-002]]。

## 2026-07-26 Resolution Update

- A 已解决：Flow 自身 28 条与 Teammate 48 条 TypeScript 诊断均清零。
- B 已解决：Flow、Teammate 的 `typecheck` 门禁均通过；generated declarations、conditional exports、typecheck boundary 与真实 packed consumer gate 已建立。
- C 的仓库可控部分已解决：3 个包的 Pi SDK manifest、lock、tarball 与静态 import 边界已对齐；多物理 root 和 host singleton identity 仍由 Pi host loader 控制。
- D 已解决：run-recovery fixture、package import scanner、Skill converter/contract 已修复；permissions 与 intelligence 套件保持全绿。

外部残余：`@anthropic-ai/sdk@0.91.1` 的 declaration semantics 缺陷、Pi host singleton identity，以及当前依赖树中的 13 个既有 advisories。完整证据见 `resolutionRef`。下方“遗留问题”和“操作风险记录”保留为修复前快照。

## 迁移陷阱（0.74 → 0.82，可复用）

1. **`complete` / `getModels` 移到了 `@earendil-works/pi-ai/compat` 子路径**。包根不再导出这两个名字。这**不是类型警告，是加载即 SyntaxError**（`does not provide an export named 'complete'`）。命中位置：`src/compaction/maestro-compaction.ts`、`src/mcp/sampling-handler.ts`、`test/api-provider-config.test.ts`。含义：只要解开 0.74 硬锁真正对齐宿主版本，扩展原本会直接起不来——这个雷一直被硬锁盖着。

2. **`AgentToolResult<T>` 的 `details` 是必填**，且没有默认类型参数（0.74/0.82 都如此）。裸写 `AgentToolResult` 是类型错误。pi 自己的 `createErrorToolResult` 用 `details: {}` 兜底，跟着这个约定即可。

3. **工具返回的 `isError` 从未被 agent loop 采纳**。0.74 和 0.82 的 `agent-loop.js` 都是 `const result = await tool.execute(...); return { result, isError: false }`——错误状态只由 `execute()` 抛异常或 `afterToolCall` 钩子决定。TUI 之所以还能按错误着色，是因为 `finalizeExecutedToolCall` 展开了返回对象，我们挂的 `isError` 属性顺带传到了 `ToolExecutionComponent`。所以**不要**为了消类型错误去删这个字段（会丢着色），也不要以为它能让模型知道调用失败（模型只看 content 文本）。项目里用 `src/tools/tool-result.ts` 的 `FlowToolResult` 把这个真实契约写下来。

4. **`ModelRegistry.create(auth, modelsPath)` 已废除**，改为 `new ModelRegistry(await ModelRuntime.create({ credentials, modelsPath }))`（`ModelRuntime.create` 是 async）。

5. **`pi-coding-agent` 的 exports 只暴露 `.` 和 `./rpc-entry`，且只有 `import` 条件**。深层路径（`dist/core/*.js`）不能用裸说明符；`createRequire(...).resolve()` 也会失败（`ERR_PACKAGE_PATH_NOT_EXPORTED`，因为缺 `require` 条件）。正确写法是从公共 ESM 入口反推目录：`dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))`，再 `join` 深层文件。**不要**写 `../../../node_modules/...`——依赖布局一变就 404。

6. `ThinkingLevel` 新增了 `max`；`ProviderModelConfig` 新增必填 `cost`/`contextWindow`/`maxTokens`。

## 遗留问题（修复前快照）

### A. flow 仍有 28 个类型错误（需领域判断，非机械活）

- `RunTeammateParams` 不认 `lifecycle` 字段 ×4（`tools/delegate.ts`、`explore.ts`、`moa.ts` ×2）—— teammate 边界，需确认该字段是否已改名/移除
- `tools/swarm.ts:11-13` 三处重载不匹配
- `extension/index.ts`：`WorkflowSnapshot.recovery` 不存在、`next.session` 可能 undefined、approval mode 字符串未收窄到联合、`TeammatePermissionBroker` 的 `action` 推断成 `string`、`Record<string, unknown> → GoalParams` 的不安全断言
- `tools/goal.ts`：`workflowCoordinator` 可能 undefined ×3、`ActiveGoal | undefined` 传给必填参数、一处实参个数不符
- `tools/browser-tool.ts` / `smart-search.ts` / `lsp-tool.ts`：schema 推断出的 `unknown` 未收窄到字面量联合
- `effort-display.ts:14`：`Record<ThinkingLevel, string>` 缺 `max`
- `session/bridge.ts:517,519`：`WorkflowRunStatus` 未导入
- `tools/model-availability.ts:173,181`：`singleLine` 未导入（**运行时会 ReferenceError**，被宿主 try/catch 吞掉后降级为 fallback 渲染）
- `tui/compaction-settings.ts:321`：undefined 作索引

### B. typecheck 门禁未挂（根本缺口）

flow 是三个包里唯一没有 `typecheck` 脚本的。`tsconfig.build.json` 其实覆盖了全部 `src/**/*.ts` 且 strict，实验证明它**能**抓到那次 TUI 崩溃缺陷（`index.ts(668,5): TS2322 ... missing render, invalidate`）——只是从来没被跑过，运行时靠 `--experimental-transform-types` 剥类型不校验。等 A 清零后加 `"typecheck": "tsc -p tsconfig.build.json --noEmit"`。teammate 的同名脚本已存在但常年 51 个错误，等价于没有门禁。

### C. 依赖并未真正去重

改成 peer 只解决了「编译期对齐」。devDependencies 仍会被装进各包的 `node_modules`，运行时 Node 就近解析仍拿到各包自己那份。当前磁盘上：宿主 0.82.0 + flow/teammate/cockpit 各 0.82.1。补丁级差异远好于原来的 0.74 vs 0.82，但同一进程里多份 pi-tui 组件互喂的隐患仍在。根本解法需要 pi 侧提供模块注入或扩展从宿主解析。

### D. 13 个测试失败（已验证非本次改动引入）

- skill 契约 ×3（`skill-contract-lint.test.ts`）：断言 skill markdown 的 `session-mode` frontmatter，与 SDK 无关，疑似 commit 9b15ea85「扁平化 skill 目录」或未跟踪的 `flow/` 目录导致
- `test:package` #4：指名 `src/gui/gui-registry.ts` 未使用 versioned teammate API
- `run-recovery` #3：做过对照实验，把本次改动回退后**依然失败**
- `test:permissions` #17、`test:intelligence` #34

## 操作风险记录（修复前快照）

本次作业全程有**另一个会话并发写同一棵树**（Run `20260726-001-team-issue`，teammate structured output/流式树/状态排序）。表现：`src/extension/index.ts` 的修复一度在磁盘上变回缺陷版本又变回来；`todo.ts:1363` 出现引用了不存在的 `degradedActivation` 的中间态；tsc 报出已修复的错误。教训：**在共享工作树上做跨文件重构前，先确认没有其他 agent 会话在跑**，否则测量的是移动靶，双方编辑会互相覆盖。
