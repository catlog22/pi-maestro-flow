---
title: "Architecture Constraints"
readMode: required
priority: high
category: arch
keywords:
  - architecture
  - module
  - layer
  - boundary
  - dependency
  - structure
---

# Architecture Constraints

## Module Structure

## Layer Boundaries

## Dependency Rules

## Technology Constraints

## Entries



<spec-entry category="arch" keywords="todo,skill-loader,defaultresourceloader,state-transition" date="2026-07-10" sid="S-20260710-kwdz" title="Pi todo 的原生 skill 控制边界" description="定义 todo、Pi 原生 skill loader 与未来 Ralph 控制迁移的模块边界" source="planex-odyssey">

### Pi todo 的原生 skill 控制边界

Pi todo MUST 将 skill 作为可空任务配置并通过独立的 Pi 原生 loader 延迟加载。Discovery MUST 复用 DefaultResourceLoader，feature code MUST NOT 复制 skill 目录扫描，也 MUST NOT 依赖 Maestro/Ralph runtime。任何 skill/config/required-reading/budget 失败 MUST 发生在任务状态切换为 in_progress 之前。

</spec-entry>

<spec-entry category="arch" keywords="teammate session handoff lease epoch nonce switchsession" date="2026-07-11" sid="S-20260711-j1kq" title="Pi teammate session 单所有者接管协议" description="Pi teammate session 接管、回交与恢复的唯一 owner 约束" source="master@fe067a5">

### Pi teammate session 单所有者接管协议

Teammate session handoff MUST maintain exactly one writer. Handoff MUST wait for accepted prompt sequence, corresponding agent_end completion, and stable idle before transfer. Every RPC user message MUST carry epoch/nonce lease metadata and child input MUST reject stale tokens. Timeout recovery MUST send the old transaction cancel before publishing the new fenced lease. switchSession invalidates old extension context; handback MUST reload the child session and validate nonce, sessionId, and canonical sessionFile before restoring child ownership.

</spec-entry>