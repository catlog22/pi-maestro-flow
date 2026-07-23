---
title: Agent loop 的上下文 transform 必须稳定且分层持有
description: 提升 prompt cache 命中时，固定非持久注入位置、记录 prune 生命周期，并给辅助请求声明独立缓存策略
type: tip
tags: [缓存命中, 上下文稳定, 会话恢复, 压缩策略]
created: 2026-07-23T00:00:00+08:00
---

# Agent loop 的上下文 transform 必须稳定且分层持有

任何仅在请求前应用、但不会写回 session 的上下文 transform，都必须固定在可重现的 transcript anchor，不能跟随不断增长的消息尾部。否则每一个 agent loop 都会改变请求前缀，导致 prompt cache 连续失效。

对可跨 turn 的压缩或 prune，状态应由 transform 生命周期持有：内存中保存已生成 replacement、token savings 和 provider usage epoch；跨 session 只持久化可从原始 transcript 安全重建的 identity。新增 transform 后，在下一份 provider usage 尚未到达前，token savings 仍属于 pending，不能重新计入压力估算。

辅助 completion（如 compaction summary）要显式声明与交互式 agent 不同的 cache policy。系统 prompt 只放不可变规则；conversation、summary、runtime state、operator focus 等动态值一律作为结构化的非特权输入，避免把用户控制的文本提升到 system 层。

## Context

- `packages/pi-maestro-flow/src/tools/todo.ts`
- `packages/pi-maestro-flow/src/compaction/auto-compaction.ts`
- `packages/pi-maestro-flow/src/compaction/maestro-compaction.ts`
