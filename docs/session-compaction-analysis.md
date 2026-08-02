# Claude Code 会话压缩逻辑分析

> 分析对象：`restored-src/src/services/compact/`（全部 11 个文件，约 4000 行）、`commands/compact/` 命令入口、`query.ts` 查询循环调用链、`utils/messages.ts` 边界消息机制。
>
> 生成日期：2026-08（基于 restored-src 快照）

---

## 一、总体架构：四层压缩体系

`src/services/compact/` 实现分层上下文管理，从"无损裁剪"到"有损摘要"逐级降级：

| 层级 | 机制 | 触发方式 | 有损性 |
|---|---|---|---|
| 1 | **Snip**（`snipCompact.js`，feature 门控，restored 源码中未包含） | 查询循环内主动 | 丢弃已裁剪消息 |
| 2 | **Microcompact**（`microCompact.ts`） | 查询循环内主动 | 清除旧 tool_result / 服务端 cache_edits |
| 3 | **Autocompact**（`autoCompact.ts` → `compactConversation`） | 令牌阈值触发 | LLM 摘要，有损 |
| 4 | **Reactive compact**（`reactiveCompact.js`，ant-only，restored 源码未包含） | API 返回 prompt-too-long(413) | LLM 摘要，有损 |

另有三个旁路：**Session Memory 压缩**（用会话记忆文件替代 LLM 摘要）、**局部压缩**（消息选择器，`partialCompactConversation`）、**Context Collapse**（`feature('CONTEXT_COLLAPSE')`，独立上下文管理系统）。

### 核心文件职责

| 文件 | 行数 | 职责 |
|---|---|---|
| `compact.ts` | 1705 | 主压缩编排器：`compactConversation`（全量）、`partialCompactConversation`（局部）、摘要流式调用、附件重建 |
| `autoCompact.ts` | 351 | 阈值计算、自动触发决策、熔断器 |
| `microCompact.ts` | 530 | 微压缩：缓存编辑路径 + 时间基路径 |
| `sessionMemoryCompact.ts` | 630 | 会话记忆压缩实验 |
| `prompt.ts` | 374 | 摘要提示词模板与摘要格式化 |
| `grouping.ts` | 63 | 按 API 轮次分组（PTL 重试裁剪用） |
| `postCompactCleanup.ts` | 77 | 压缩后的缓存/状态清理 |
| `apiMicrocompact.ts` | 153 | 服务端原生 context management 策略 |
| `timeBasedMCConfig.ts` | 43 | 时间基微压缩配置（GrowthBook） |
| `compactWarningState.ts` / `compactWarningHook.ts` | 18/16 | 压缩警告抑制状态（纯状态 / React 订阅分离） |

---

## 二、触发机制

### 1. 手动 `/compact`（`commands/compact/compact.ts`）

- 先裁剪到最近压缩边界：`getMessagesAfterCompactBoundary(messages)`（REPL 保留全文用于滚动，压缩模型只看边界之后）
- 无自定义指令时**优先尝试 Session Memory 压缩**（零 API 成本）
- 若处于 `REACTIVE_COMPACT` 且 reactive-only 模式，路由到 `reactiveCompactOnPromptTooLong`
- 兜底：先跑 `microcompactMessages` 减少令牌，再调 `compactConversation`

### 2. 自动触发（`query.ts` 查询循环，每轮执行）

顺序严格固定（`query.ts:396-468`）：

```
messages → getMessagesAfterCompactBoundary
        → applyToolResultBudget（按消息预算替换大 tool_result）
        → snipCompactIfNeeded（HISTORY_SNIP）
        → microcompactMessages（微压缩）
        → applyCollapsesIfNeeded（CONTEXT_COLLAPSE）
        → autoCompactIfNeeded（阈值检查）→ compactConversation
```

关键设计：

- **snip 先于 microcompact、microcompact 先于 autocompact**，让更低成本的机制先消化上下文
- `snipTokensFreed` 传给 autocompact，使阈值判断反映 snip 的节省（幸存 assistant 消息的 usage 仍是裁剪前的，`tokenCountWithEstimation` 看不到节省）
- 压缩成功后 `messagesForQuery` 被替换为 `buildPostCompactMessages(...)` 并继续本轮查询（`query.ts:528-533`）

### 3. 自动触发决策（`shouldAutoCompact`，`autoCompact.ts`）

守卫链，任一命中即跳过：

- **递归守卫**：`querySource === 'session_memory' || 'compact'`（fork 代理会死锁）
- `marble_origami`（ctx-agent）压缩会破坏主线程模块级状态
- 用户/环境禁用：`DISABLE_COMPACT`、`DISABLE_AUTO_COMPACT`、`autoCompactEnabled=false`
- reactive-only 模式（`tengu_cobalt_raccoon`）
- context-collapse 启用时（避免与 collapse 竞态）

### 4. 阈值与熔断

```ts
// autoCompact.ts
有效上下文窗口 = min(模型窗口, CLAUDE_CODE_AUTO_COMPACT_WINDOW) - min(maxOutputTokens, 20_000)
autocompact 阈值  = 有效窗口 - 13_000   // AUTOCOMPACT_BUFFER_TOKENS
警告阈值          = 阈值 - 20_000       // WARNING_THRESHOLD_BUFFER_TOKENS
错误阈值          = 阈值 - 20_000       // ERROR_THRESHOLD_BUFFER_TOKENS
阻塞限制(autocompact 关闭时) = 有效窗口 - 3_000  // MANUAL_COMPACT_BUFFER_TOKENS
```

- **熔断器**：连续 3 次（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`）自动压缩失败后本会话停止重试——数据依据：BQ 显示 1,279 个会话出现 50+ 次连续失败，浪费约 25 万次 API 调用/天
- 失败计数通过 `AutoCompactTrackingState.consecutiveFailures` 跨轮传播

---

## 三、核心流程 `compactConversation`（compact.ts:169-578）

### 阶段 1：前置钩子

`executePreCompactHooks`（PreCompact hook）→ 返回的 `newCustomInstructions` 与用户自定义指令合并（`mergeHookInstructions`：用户指令在前，hook 指令追加）。

### 阶段 2：摘要请求

- 提示词：`getCompactPrompt` = `NO_TOOLS_PREAMBLE`（强硬禁止工具调用，防止自适应思考模型浪费唯一回合）+ 9 段式摘要模板（`prompt.ts`）→ 附加自定义指令 → `NO_TOOLS_TRAILER`
- 模板要求模型输出 `<analysis>`（草稿思考，后续剥离）+ `<summary>` 结构

### 阶段 3：流式摘要 — 双路径

**路径 A：缓存共享 fork（默认开启，`tengu_compact_cache_prefix`）**

- `runForkedAgent` 复用主会话的提示词缓存前缀（system/tools/messages 完全一致 → 缓存命中）
- `maxTurns: 1`、`canUseTool: deny`、`skipCacheWrite: true`，透传 abortController（用户 Esc 可中止）
- 关键细节：**禁止设置 maxOutputTokens**——`Math.min(budget, maxOutputTokens-1)` 会改变 thinking 配置导致缓存键失配
- 实验数据：关闭路径 98% 缓存未命中，浪费全球约 380 亿 tok/天（3P 默认开启）

**路径 B：流式回退（`streamCompactSummary`）**

- `queryModelWithStreaming`，极简 system prompt（"You are a helpful AI assistant tasked with summarizing conversations."）
- 仅 `FileReadTool`（工具搜索启用时加 ToolSearchTool + MCP 工具，均 `defer_loading`），`thinking: disabled`
- 重试：`tengu_compact_streaming_retry` 门控，最多 2 次（`MAX_COMPACT_STREAMING_RETRIES`）

**Keep-alive**：摘要调用期间每 30 秒发心跳（`sendSessionActivitySignal` + 重发 `compacting` SDK 状态），防止远端 WebSocket 因空闲超时断连。

### 阶段 4：PTL 重试（CC-1180 逃生舱）

摘要请求本身命中 prompt-too-long 时：

- 按 **API 轮次**（`groupMessagesByApiRound`，以 assistant `message.id` 变化为边界，`grouping.ts`）从最旧分组丢弃，直到覆盖 `getPromptTooLongTokenGap`
- 无 gap 信息时兜底丢 20% 分组；最多 3 次（`MAX_PTL_RETRIES`）
- 丢头后若以 assistant 开头则前置合成 user 标记消息（API 要求首条为 role=user）
- 注释明确这是"dumb-but-safe"后备；reactive 路径有更完善的尾部剥离循环（`truncateHeadForPTLRetry`）

### 阶段 5：请求前消息清洗

- `stripImagesFromMessages`：替换 user 消息中的 image/document 块（含嵌套在 tool_result 内的）为 `[image]`/`[document]` 文本标记——防止压缩 API 调用自身触发 PTL，同时摘要仍会提及曾共享图片
- `stripReinjectedAttachments`：剔除 `skill_discovery`/`skill_listing` 附件（压缩后反正会重新注入，喂给摘要器浪费 token 且产生过期技能建议）

### 阶段 6：后置附件重建（并行执行）

压缩"吃掉"了旧上下文，需要重建关键上下文：

| 附件 | 来源 | 限制 |
|---|---|---|
| 最近读取文件 | `createPostCompactFileAttachments` 用 FileReadTool 重读 | ≤5 个文件、单文件 ≤5K tok、总 ≤50K tok；跳过已存在于 `messagesToKeep` 中的文件（防重复注入） |
| 任务计划 | `createPlanAttachmentIfNeeded` | — |
| 已调用技能 | `createSkillAttachmentIfNeeded` | 单技能 ≤5K tok、总 ≤25K tok，按调用时间倒序，预算压力下优先丢旧技能；保留文件头部（通常是指令所在）并附加截断标记 |
| Plan 模式 | `createPlanModeAttachmentIfNeeded` | 仅 plan 模式，保证压缩后模型仍按 plan 模式工作 |
| 异步 agent | `createAsyncAgentAttachmentsIfNeeded` | 运行中/未取回结果的 local agent 状态 |
| 延迟工具/agent/MCP 增量 | `getDeferredToolsDeltaAttachment` 等（diff 空历史 → 全量通告） | 压缩吞掉了旧 delta 附件 |

### 阶段 7：边界标记与摘要消息

- `createCompactBoundaryMessage('auto'|'manual', preTokens, lastUuid)` 生成 `SystemCompactBoundaryMessage`（`subtype: 'compact_boundary'`），携带 `logicalParentUuid` 指向压缩前最后一条消息，并记录 `preCompactDiscoveredTools`
- 摘要封装为 `isCompactSummary: true, isVisibleInTranscriptOnly: true` 的 user 消息：`getCompactUserSummaryMessage` 先 `formatCompactSummary`（剥离 `<analysis>`、将 `<summary>` 标签换成标题），再套固定文案 + transcript 路径指引
- autocompact 时附加"继续工作、勿提问、勿复述"指令；proactive/KAIROS 模式下追加自主续跑指令

### 阶段 8：收尾

- 事件上报 `tengu_compact`（真实后置 token 数、`willRetriggerNextTurn` 预测、缓存共享命中率、上下文构成分析）
- `notifyCompaction`（重置缓存断点检测基线，防止压缩后 cache_read 下降被误报为缓存断裂）→ `markPostCompaction`
- `reAppendSessionMetadata()`：把自定义标题/标签重新追加到 transcript 尾部 16KB 窗口内，保证 `--resume` 仍显示用户设置的会话名
- `processSessionStartHooks('compact')` 重建 CLAUDE.md 等上下文 → `executePostCompactHooks`（PostCompact hook 拿到摘要文本）
- KAIROS 特性下写会话 transcript 段

### 消息布局

压缩后消息数组顺序（`buildPostCompactMessages`）：

```
boundaryMarker → summaryMessages → messagesToKeep(局部压缩) → attachments → hookResults
```

---

## 四、Session Memory 压缩（`sessionMemoryCompact.ts`）

实验性路径，双门控（`tengu_session_memory` + `tengu_sm_compact`），配置来自 GrowthBook（`tengu_sm_compact_config`，默认 min 10K / max 40K tok / ≥5 条文本消息）。**零 API 成本**——不调 LLM 摘要，直接用增量提取的会话记忆文件（session memory）当摘要：

1. 等待在途记忆提取完成（`waitForSessionMemoryExtraction`）
2. 记忆文件不存在或仍是空模板 → 回退传统压缩
3. `calculateMessagesToKeepIndex`：从 `lastSummarizedMessageId` 之后开始，向后扩展直到满足最小 token 数和文本消息数（受 max 上限约束、以最近压缩边界为下限）
4. `adjustIndexToPreserveAPIInvariants`：关键正确性修正——不拆散 tool_use/tool_result 配对、保留与保留区 assistant 同 `message.id` 的 thinking 块（流式拆分为多消息时依赖 `normalizeMessagesForAPI` 按 id 合并）
5. 超长记忆段截断（`truncateSessionMemoryForCompact`），并提示完整记忆文件路径

压缩结果中旧边界消息会被过滤（防止 REPL 剪枝触发二次剪枝丢弃新边界）。此路径在 autocompact 和手动 `/compact` 都优先于传统压缩尝试。

---

## 五、Microcompact（`microCompact.ts`）

### 1. 基于时间的 MC（`tengu_slate_heron` 门控，默认关闭）

当距最后一条 assistant 消息超过 `gapThresholdMinutes`（默认 60，对齐服务端 1h 缓存 TTL）时，服务端缓存必然已过期、全前缀注定重写——于是**直接清空**非最近 N 条（默认 5）可压缩工具（Read/Bash/Grep/Glob/WebSearch/WebFetch/Edit/Write）的 tool_result 内容为 `[Old tool result content cleared]`：

- 在 API 调用**之前**执行，以缩小实际发送的 prompt
- 清空后重置 cached-MC 状态（其按 tool_use_id 注册的旧状态已失效）
- 与缓存编辑 MC 互斥（时间基优先：缓存已冷时编辑假设不成立）

### 2. 缓存编辑 MC（Cached MC，`feature('CACHED_MICROCOMPACT')`）

ant-only 核心创新：**不修改本地消息内容**，而是利用 Anthropic 的 `cache_edits` API 在服务端删除旧 tool_result，从而**不失效缓存前缀**（cache hit 保留）：

- 仅主线程（`repl_main_thread` 前缀，防 fork 代理污染全局状态）；仅支持 cache-editing 的模型
- 按 GrowthBook 配置（`getCachedMCConfig`）的计数阈值/保留数选择要删除的工具，生成 `CacheEditsBlock` → `pendingCacheEdits`
- API 层（`services/api/claude.ts`）：`consumePendingCacheEdits` 消费新编辑、`getPinnedCacheEdits` 在原始位置重发已固定的编辑、响应后 `markToolsSentToAPIState` 更新注册状态
- 边界消息**延迟**到 API 响应后生成（`query.ts:866-888`），用真实 `cache_deleted_input_tokens` 相对基线计算本次操作节省的 token
- 兼容 `repl_main_thread:outputStyle:<style>` 前缀变体（`isMainThreadSource` 用 startsWith，修复了裸 `===` 检查的潜在 bug）

### 3. API 原生压缩（`apiMicrocompact.ts`）

服务端 context management 策略（`clear_tool_uses_20250919` / `clear_thinking_20251015`）：

- ant-only + env 开关（`USE_API_CLEAR_TOOL_RESULTS` / `USE_API_CLEAR_TOOL_USES`）
- 阈值默认 180K 触发 / 40K 保留（`DEFAULT_MAX_INPUT_TOKENS` / `DEFAULT_TARGET_INPUT_TOKENS`），与客户端微压缩值对齐
- thinking 保留策略：redact-thinking 激活时跳过（红acted 块无模型可见内容）；闲置 >1h（cache miss）时仅保留最后一轮 thinking（API schema 要求 value ≥ 1）

---

## 六、局部压缩（`partialCompactConversation`，消息选择器）

用户选中某条消息，按方向压缩：

- **`from`**：压缩选中点之后，保留之前（前缀缓存保留；压缩调用发全量消息，尾部不缓存）
- **`up_to`**：压缩之前，保留之后（前缀直接缓存命中；摘要将置于保留消息之前，故必须剥离旧的边界/摘要消息，避免向后扫描的 `findLastCompactBoundaryIndex` 选中旧边界而丢掉新摘要）

结果布局：`boundary → (kept | summary 在前/在后) → attachments → hookResults`；`messagesToKeep` 通过 `annotateBoundaryWithPreservedSegment` 在边界上记录 `preservedSegment {headUuid, anchorUuid, tailUuid}` 重链元数据，磁盘上保留消息因去重跳过而保持原 `parentUuid`，加载器据此补链。

REPL 中 `from` 方向保留滚动历史、`up_to` 必须整体替换（否则数组增长触发增量路径导致边界不落盘）。

---

## 七、压缩后清理（`postCompactCleanup.ts`）

`runPostCompactCleanup(querySource)` 统一重置：

- microcompact 状态
- context-collapse 日志（仅主线程）
- `getUserContext` 缓存 + `getMemoryFiles` 缓存（否则下一个 turn 命中外层缓存、armed 的 InstructionsLoaded hook 不触发）
- system prompt 分段、分类器审批、Bash 投机检查、beta tracing、会话消息缓存、文件内容缓存清扫（COMMIT_ATTRIBUTION）

**刻意不清除**：

- 已调用技能内容（技能文本须跨多次压缩存活供附件重建）
- `sentSkillNames`（重新注入完整 skill_listing 约 4K token 是纯缓存创建浪费；模型仍有 SkillTool schema + invoked_skills 附件）

子代理压缩（`agent:*`）跳过主线程状态重置（共享模块级状态，重置会损坏主线程）。

---

## 八、值得注意的工程特征

1. **缓存一致性贯穿设计**：缓存共享 fork、禁止 maxOutputTokens、cache_edits 编辑、断点检测基线重置（`notifyCompaction`/`notifyCacheDeletion`）——压缩的每一条路径都在维护"服务端缓存语义"这一不变式
2. **递归与竞态守卫**：fork 代理（compact/session_memory）禁自压缩；ctx-agent、context-collapse 模式下禁用 autocompact 防竞态
3. **遥测驱动调参**：注释里大量 BQ 数据决策（熔断器 3 次、缓存共享默认开、时间基 MC 60 分钟对齐 TTL）
4. **DCE 与循环依赖纪律**：所有 ant-only 模块走 `feature('...')` 门控 + `require()` 延迟加载（字符串从外部构建 DCE）；`grouping.ts` 单独拆文件打破 compact↔reactiveCompact 循环依赖
5. **非主线程安全**：`postCompactCleanup`、cached-MC 均按 querySource 区分主线程/子代理，防止共享模块状态污染

---

## 九、注意事项（restored-src 快照限制）

`reactiveCompact.js`、`snipCompact.js`、`cachedMicrocompact.js` 在 restored-src 中**不存在**（`feature()` + 延迟 `require` 引用但文件缺失），它们属于 ant 内部模块，本快照未包含。外部构建中这些路径被 DCE，实际生效的是：

- microcompact（时间基 MC 默认关闭，cached MC 被 DCE）
- autocompact + compactConversation
- session memory 压缩（需 GrowthBook 门控）
- 手动 `/compact` + 消息选择器局部压缩

---

## 附录：关键常量速查

| 常量 | 值 | 位置 |
|---|---|---|
| `AUTOCOMPACT_BUFFER_TOKENS` | 13_000 | autoCompact.ts |
| `WARNING/ERROR_THRESHOLD_BUFFER_TOKENS` | 20_000 | autoCompact.ts |
| `MANUAL_COMPACT_BUFFER_TOKENS` | 3_000 | autoCompact.ts |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | autoCompact.ts |
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20_000 | autoCompact.ts |
| `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | compact.ts |
| `POST_COMPACT_TOKEN_BUDGET` | 50_000 | compact.ts |
| `POST_COMPACT_MAX_TOKENS_PER_FILE` | 5_000 | compact.ts |
| `POST_COMPACT_MAX_TOKENS_PER_SKILL` | 5_000 | compact.ts |
| `POST_COMPACT_SKILLS_TOKEN_BUDGET` | 25_000 | compact.ts |
| `MAX_COMPACT_STREAMING_RETRIES` | 2 | compact.ts |
| `MAX_PTL_RETRIES` | 3 | compact.ts |
| `IMAGE_MAX_TOKEN_SIZE` | 2000 | microCompact.ts |
| SM 压缩默认 min/max/文本消息 | 10K / 40K / 5 | sessionMemoryCompact.ts |
| 时间基 MC 默认 gap/keep | 60min / 5 | timeBasedMCConfig.ts |
| API MC 默认触发/保留 | 180K / 40K | apiMicrocompact.ts |
