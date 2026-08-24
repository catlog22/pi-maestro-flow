---
title: teammate result-ready 误触发与生命周期确认超时重构方案
type: decision
created: 2026-08-23T16:42:31.470Z
---

# teammate result-ready 误触发与生命周期确认超时重构方案

## 问题根因（已闭合）

Agent 在工具调用中途输出纯文本 turn（`stopReason=stop`、无 toolCall、无 toolResults），被 `isPiResultReadyTurn`（`execution-infra.ts:517`）误判为"最终答案"，触发 `publishResultReady()`（`pi-subprocess-attempt.ts:1428`）→ 清空运行上限 + arm 60s `RESULT_READY_GRACE_MS` deadline。若 agent 之后无 stdout 活动（`pokeLifecycleDeadline` 未续命）且未发 `agent_settled`，60s 后被 backstop 终止（`pi-subprocess-attempt.ts:928`）。

诊断消息：`published a result but never confirmed its lifecycle within 60000ms (expected=agent_settled, tools=4, turnTools=0)`。

**核心矛盾**：框架假设"纯文本 turn = 最终答案"（`isPiResultReadyTurn` 检测无 toolCall 即 final）；LLLM 自然行为是"多轮工具调用中穿插文本说明"（narration）。两者冲突导致误判。

## 现状证据锚点

| 组件 | 位置 | 原行为 |
|------|------|--------|
| `isPiResultReadyTurn` | `execution-infra.ts:517-527` | turn_end + assistant + stop + 无 errorMessage + toolResults=0 + content 无 toolCall → true |
| `publishResultReady` | `pi-subprocess-attempt.ts:898-922` | 设 result-ready，清 timers，arm 60s deadline |
| `armLifecycleConfirmationDeadline` | `pi-subprocess-attempt.ts:951-956` | result-ready 后 arm `RESULT_READY_GRACE_MS` |
| `lifecycleDeadlineCallback` | `pi-subprocess-attempt.ts:928-949` | 60s 未 settled → terminated + 诊断消息 |
| `pokeLifecycleDeadline` | `pi-subprocess-attempt.ts:958-963` | stdout/stderr 活动重置窗口 |
| `onTurnEnd` 调用点 | `pi-subprocess-attempt.ts:1424` | 唯一调用 `isPiResultReadyTurn` 的地方 |
| `inFlightToolCount` 状态机 | `pi-subprocess-attempt.ts:1321/1344/1198` | tool_start +1，tool_result -1，turn_start 重置 |
| `RESULT_READY_GRACE_MS` | `execution-infra.ts:2218` | `60_000` |

## governing spec 约束

- `debug-notes-006`：result-ready 是边沿通知，`resultReadyAt` 一旦置位就为真，通知用 `claimResultReadyNotice()` 认领只投递一次。**约束 C1**：不能撤回已 publish 的 result-ready，只能在 publish 前判断。
- `architecture-constraints-049`：result-ready 是 valid consumable boundary。**约束 C1**：不能把真实 result-ready 改成"无效"，只能阻止误判的 interim turn 触发。

两条 spec 都支持 C1 方向（提前判定，不撤回）。

## 优化方案（分层，按成本/风险/收益）

### C1（治本）：区分 final turn 与 interim text turn

`isPiResultReadyTurn` 增加可选 `ResultReadyTurnContext` 参数（`inFlightToolCount`、`completedToolCount`）。护栏：`inFlightToolCount > 0` 时返回 false（interim 降级，不触发 result-ready）。`inFlightToolCount === 0` 或 `completedToolCount === 0` 保持原行为。向后兼容：context 可选，不传退化为原逻辑。

`onTurnEnd` 调用点传入 `state.inFlightToolCount`/`completedToolCount`。

**影响**：
- 正常多轮工具调用 + 最终文本答案：`inFlightToolCount === 0` → 仍触发 result-ready ✅
- 纯问答（无工具）：`completedToolCount === 0` → 仍触发 ✅
- 工具调用中途输出说明：`inFlightToolCount > 0` → 不触发，agent 继续 turn ✅（本次 bug 场景）

### C2：定向延长 agent_settled 确认窗口

新增 `RESULT_READY_GRACE_EXTENDED_MS = 120_000`。`lifecycleDeadlineMs()` 场景化：`completedToolCount > 0` 用 120s，否则 60s。显式 `resultReadyGraceMs` 选项优先（测试用小值快速验证）。

**影响**：纯问答 60s（原行为）；有工具调用 120s，给 agent 更多时间补发 `agent_settled`。

### C3（跳过）：result-ready 后 halfway 探活 child

按 Plan 回退条款跳过。原因：Pi 子进程 RPC 协议（`sendRpcMessage` 的 `RpcMessageMode`）仅支持 `prompt`/`abort`/`steer`/`follow_up`，无 no-op 心跳；`pokeLifecycleDeadline` 已基于 stdout/stderr 活动续命，child 卡死时探活也不会产生 stdout。C1+C2 已覆盖核心场景。

### B1（辅助）：agent 行为约束

`writeSystemPromptFile`（`execution-infra.ts:2201`）追加 "Result publication discipline" 指令到所有 teammate agent system prompt：不输出 stop 终止的纯文本 turn 当工具在飞。依赖模型遵守，核心保障仍由 C1 提供。

### D：可观测性增强

`lifecycleDeadlineCallback` 诊断消息增加 `inFlightTools`、`completedTools`、`lastStopReason` 字段，让 terminated 根因从"猜"变成"读"（中途 publish vs 真实卡死）。

## 实施结果

| 层 | 状态 | 验证 |
|----|------|------|
| D | ✅ 完成 | execution-lifecycle-guards 34/34 通过 |
| C1 | ✅ 完成 | 4 新单元测试 + 原 5 契约测试全通过（9/9） |
| C2 | ✅ 完成 | lifecycle-guards 34/34 通过（测试用显式覆盖不受影响） |
| B1 | ✅ 完成 | temporary-permissions 5 pass / 0 fail / 1 skipped |
| C3 | ⏭️ 跳过 | 按 Plan 回退条款（协议不支持 no-op） |

- typecheck 通过（`tsc -p tsconfig.build.json --noEmit`）
- 声明构建通过（`npm run build:declarations`）
- commit：`31141b2b fix(teammate): distinguish interim text turns from result-ready and extend lifecycle grace`

## 改动文件

```
packages/pi-maestro-teammate/src/runs/execution-infra.ts       # C1 + C2 + B1
packages/pi-maestro-teammate/src/runs/pi-subprocess-attempt.ts # D + C1 + C2
packages/pi-maestro-teammate/test/performance-buffers-and-spawn.test.ts # C1 测试
packages/pi-maestro-teammate/test/temporary-permissions.test.ts          # B1 测试适配
packages/pi-maestro-teammate/types/runs/execution-infra.d.ts   # 声明重新生成
```

## 调试 recipe（未来复用）

诊断 teammate `terminated`：检查诊断消息的字段组合：
- `tools>0, turnTools=0, inFlightTools>0` → 中途纯文本 turn 误触发 publish（C1 修复场景）
- `全 0` → 真实卡死
- `completedTools>0` → 触发 C2 延长窗口（120s）

## 测试流程纪律（方案 A，文档化）

- `observe` 检测到 `terminated` → 立即停止等待，读 `agent://` 看实际产出
- 唤醒 sleeping agent 执行长任务用 `observe watch`（轮询状态迁移），不用 `wait until=completed`
- busy loop 中插入修正用 `steer`，sleeping 续跑用 `follow_up`
- agent prompt 显式要求"完成所有工具调用后再输出最终结论，不要中途输出进度说明"

## governing spec 引用

- `spec:project:debug-notes-006` — result-ready 是边沿通知，不可撤回只可提前判定
- `spec:project:architecture-constraints-049` — result-ready 是 consumable boundary
- `knowhow-TIP-20260823-teammate-completion-delivery-realtime-st` — result-ready 发布与生命周期确认解耦
