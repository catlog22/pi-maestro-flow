---
title: Swarm 私有 Ant、结构化输出与终态事件契约
description: 沉淀 Swarm Ant 契约错位、私有角色边界、终态重复唤醒和实时事件诊断方法
type: asset
category: coding
assetType: runtime-contract
codePaths:
  - packages/pi-maestro-flow/src/swarm/controller.ts
  - packages/pi-maestro-flow/src/swarm/types.ts
  - packages/pi-maestro-flow/src/tools/swarm.ts
  - packages/pi-maestro-teammate/src/agents/agents.ts
  - packages/pi-maestro-teammate/src/runs/execution.ts
  - packages/pi-maestro-teammate/agents/swarm-ant.md
created: 2026-07-17T11:10:00+08:00
tags: [蚁群运行时, 私有角色, 结构化输出, 终态门禁, 事件投影, 调试方法]
status: active
---

# Swarm 私有 Ant、结构化输出与终态事件契约

## Overview

原生 `/swarm` 由 bundled `swarm` Skill 与 native `swarm_runtime` 共同完成：Skill coordinator 编译目标相关的 task space、Ant task contract、Judge/Analyst 选择和评分要求；runtime 固定加载私有 `swarm-ant`，负责 teammate dispatch、ACO 计算、产物和权威事件。

这条链路曾连续暴露四类问题：

1. Ant Prompt 未完整镜像 `structured_output` schema，导致有内容的分析结果因缺少 `selfScore`、`confidence` 被拒绝。
2. `path` 字段语义不清，Agent 把它输出为文件系统路径，而 runtime 要求它严格等于分配的 task-space dimension ID 序列。
3. `structured_output` 已成功结算后，stdout 缓冲区中的 `tool_result`、`turn_start` 等迟到事件仍被处理，表现为 agent loop 结束后重新唤醒。
4. `swarm-ant` 曾与普通 builtin 一起暴露在 live teammate catalog，导致 coordinator 可以选择 `cli-explore-agent` 作为 Ant；修复后又因事件文本不明确，让真实的私有 Ant dispatch 被误判为“没有使用 Ant”。

## Structure

### 权威职责边界

| 组件 | 拥有的职责 | 禁止行为 |
|---|---|---|
| `/swarm` command | 激活 bundled Skill，创建 controller 和观察面 | 不直接编译或执行隐藏计划 |
| `swarm` Skill coordinator | 编译 dimensions、Ant task contract、Judge/Analyst、rubric、synthesis requirements | 不选择 Ant agent；不直接调用普通 `teammate` 替代 runtime |
| 私有 `swarm-ant` | 按 assignment path 只读探索并返回严格结构化候选 | 不出现在 catalog、`teammate-list`、parent prompt；不允许普通 teammate dispatch 或项目覆盖 |
| `swarm_runtime` | 校验计划，固定加载私有 Ant，调度 graph，计算 ACO，持久化 artifact 与事件 | 不从 catalog 选择 Ant；私有定义缺失时不得回退公开角色 |
| Judge / Analyst | 从 live catalog 动态选择，分别负责盲评和收敛综合 | 不接管 Ant 探索职责 |
| `events.jsonl` | 运行期间的实时权威事件流 | 不由 UI 推测或伪造阶段、角色和收敛状态 |
| `run.json` | 边界 checkpoint，用于恢复和最终快照 | 不应被当作每个 progress delta 的实时状态源 |

对应 coding spec：`S-20260717-uzgd`。旧的“Ant/Judge/Analyst 全部动态选择”规则 `S-20260716-fcl4` 已 deprecated。

### Ant plan 与公开角色契约

Swarm plan 只包含两个可选择 role binding：`judge` 和 `analyst`。Ant 位于独立的 task contract 中，仅包含：

- `taskType`
- `mission`
- `prompt`
- `evidenceRequirements`
- `constraints`
- `outputExpectation`

Ant contract 不得包含 `agent` selector。runtime 始终绑定 `system-ant → swarm-ant`，并通过 `allowInternalSwarmAnt` 内部 capability dispatch。普通 `resolveAgent()`、`listAgentSummaries()`、`formatAgentCatalog()` 和 `runTeammate()` 均不得公开或接受该角色。

### Structured output 单一契约

Ant Prompt 必须明确展示完整对象 shape，并与 runtime schema 同步：

```json
{
  "path": ["dimension-id"],
  "findings": ["grounded finding"],
  "evidence": [{ "ref": "file:line", "claim": "supported claim" }],
  "candidate": {
    "summary": "candidate summary",
    "details": "candidate details",
    "actions": ["action"],
    "risks": ["risk"]
  },
  "selfScore": 0,
  "confidence": 0
}
```

关键语义：

- `path` 必须严格等于本次 assignment 的 dimension ID 顺序，不能写 workspace 或文件路径。
- `selfScore` 与 `confidence` 必须是 `0..1` 的 JSON number。
- Agent 只能在全部字段齐全后调用一次 `structured_output`。
- 成功调用是 turn 的最终动作；之后不得再生成 assistant message。

### 终态吸收规则

`completeTurn()` 是 teammate runner 的权威结算边界。设置 `resolved = true` 后：

- 后续 stdout 事件必须全部忽略；
- child 必须进入终止/回收流程；
- Swarm controller 必须忽略 `completed` agent 的迟到 progress；
- `failed → running` 仍可能是合法 model fallback，不能被误当成吸收态。

因此吸收条件是“已发布的 completed turn”，不是任意一次 attempt failure。

### 事件投影规则

观察面必须把内部事实表达清楚：

- `role_bound`：`system-ant bound to swarm-ant`，并标记 `visibility: internal`。
- `iteration_started`：显示 `private swarm-ant ×N dispatched`，不能只写模糊的 `N assignments`。
- `prompt_compiled`：优先读取 `agentId`，其次读取 `roleId`；可选字段 helper 不能返回 truthy 的 `"unknown"`，否则会遮蔽真实 `roleId`。
- `agent_status` 与 `tool_delta`：以 correlation ID 和 Ant ID 证明实际运行，不以 coordinator 的自然语言旁白判断是否 dispatch。

## Usage

### 诊断“没有使用 Ant”

按以下顺序检查，避免只看主消息流：

1. 读取最新 `.workflow/swarms/<run>/events.jsonl`。
2. 查找 `role_bound`，确认 `system-ant → swarm-ant`。
3. 查找 `iteration_started`，确认 assignment 数量和 path。
4. 查找每个 `ANT-*` 的 `agent_status=running`。
5. 查找 `tool_delta` / `teammate_delta`，确认子进程实际工作。
6. 只有上述事件缺失时，才能判定 Ant 未 dispatch；`run.json` 中暂时的 `pending` 可能只是 checkpoint 尚未刷新。

Run `SW-分析当前项目-20260717025339-301010` 是正例：sequence 7 绑定私有 Ant，sequence 20 创建 4 个 assignment，sequence 25–28 四个 Ant 全部进入 running，随后持续产生 `ls/read/bash` 事件。

### 诊断 structured output 失败

1. 从 `teammate_delta` 提取完整 validation error 和 received arguments。
2. 对照 schema 的 `required` 与 Prompt 中明确列出的字段。
3. 除字段存在性外，再检查语义 invariant，例如 `path` 是否与 assignment 完全一致。
4. 不要把 `Structured output saved.` 当作 runtime 已接受；还要确认 parent 读取、schema 校验和 `normalizeAntOutput()` 全部通过。

### 诊断“完成后重新唤醒”

检查事件顺序是否出现：

1. `structured_output completed`；
2. `agent_status completed`；
3. 同一 Ant 又出现 `turn_start`、新 assistant message 或 `agent_status running`。

若存在，优先检查 teammate `processEvent()` 是否在 `resolved` 后直接返回，以及 Swarm `handleProgress()` 是否拒绝 completed agent 的迟到 progress。

### Fresh process 要求

Pi extension、Skill 和 builtin agent definitions 在进程启动时加载。修改后必须用 fresh Pi 验证；旧进程可能同时表现出新 artifact shape 与旧事件投影文本，不能作为最终验收依据。

## Verification

最低验证矩阵：

| 层级 | 验证内容 |
|---|---|
| Contract | plan 只有 Judge/Analyst 两个 selectable binding；Ant contract 无 agent selector |
| Catalog | live catalog、`teammate-list`、parent prompt 均不含 `swarm-ant` |
| Access | 普通 `runTeammate({agent: "swarm-ant"})` fail closed；内部 capability 可以执行 |
| Prompt | 完整 shape、精确 path、`selfScore`、`confidence` 均写入动态 Prompt |
| Lifecycle | 结算后缓冲事件不产生新 progress；model retry 的 failed→running 仍允许 |
| Events | 明确投影 `private swarm-ant ×N dispatched` 与真实 role Prompt ID |
| Tests | `npm run test:swarm`、teammate 全量测试、`npm run check:types` |
| Packaging | 两个包 `npm pack --dry-run`，确认 agent、Skill、schema 和 runtime 源码入包 |
| Fresh Pi | 隔离 HOME/USERPROFILE 后确认 `/swarm` 与 `/skill:swarm` 可发现 |

已建立的关键回归包括：

- 私有 Ant 不进入公开 discovery，且直接 dispatch 被拒绝；
- runtime graph 的全部 Ant task 固定使用 `swarm-ant`；
- Prompt 含完整 structured output shape 与 assignment path；
- completed 后的迟到 stdout/progress 被吸收；
- 权威 stream 明确显示私有 Ant dispatch，不再显示 `Prompt compiled for unknown`。

## Related Code Paths

- `packages/pi-maestro-flow/src/swarm/controller.ts`
- `packages/pi-maestro-flow/src/swarm/types.ts`
- `packages/pi-maestro-flow/src/tools/swarm.ts`
- `packages/pi-maestro-flow/src/tui/swarm-overlay.ts`
- `packages/pi-maestro-flow/test/swarm-engine.test.ts`
- `packages/pi-maestro-flow/schemas/swarm-run.schema.json`
- `.pi/skills/swarm/SKILL.md`
- `packages/pi-maestro-teammate/src/agents/agents.ts`
- `packages/pi-maestro-teammate/src/runs/execution.ts`
- `packages/pi-maestro-teammate/agents/swarm-ant.md`
- `packages/pi-maestro-teammate/test/agent-discovery-and-prompt.test.ts`
- `packages/pi-maestro-teammate/test/performance-buffers-and-spawn.test.ts`

