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