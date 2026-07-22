---
title: Teammate 运行指标必须在更新后发布并完整投影
description: 修复流式界面存在指标字段却始终不显示时的数据链路检查要点
type: tip
tags: [代理状态, 流式进度, 指标投影, 停滞检测]
created: 2026-07-22T15:11:45.7971224+08:00
---

# Teammate 运行指标必须在更新后发布并完整投影

当模型事件携带 usage 时，应先更新 `inputTokens`、`outputTokens` 和 `durationMs`，再调用 `onProgress`。如果先发布进度、后更新 usage，UI 会长期收到旧值或 `0`。

从 `AgentProgress` 到 `AgentProgressSnapshot` 的每条投影路径都必须保留这些字段，包括 root、proxy 和最终结果回填。运行中的 duration 应由 `startedAt` 动态计算，并以已上报的 `durationMs` 为下限；`stalled` 应依据 `lastActivityAt` 计算，初始子 agent 尚无活动时间时回退到 `startedAt`。

状态栏的关键指标应放在可能被截断的操作描述之前，并由现有的 1 秒 widget timer 触发刷新。

## Context

- `packages/pi-maestro-teammate/src/runs/execution.ts`
- `packages/pi-maestro-teammate/src/extension/index.ts`
- `packages/pi-maestro-teammate/src/tui/progress-tree.ts`
- `packages/pi-maestro-teammate/src/tui/render.ts`
