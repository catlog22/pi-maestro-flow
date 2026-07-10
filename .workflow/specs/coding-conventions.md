---
title: "Coding Conventions"
readMode: required
priority: high
category: coding
keywords:
  - style
  - naming
  - import
  - pattern
  - convention
  - formatting
---

# Coding Conventions

## Formatting

## Naming

## Imports

## Patterns

## Entries



<spec-entry category="coding" keywords="plan,hooks,chain,tool_call" date="2026-07-08" sid="S-20260708-40gp" title="Pi Plan Mode — hook 链式调用模式" source="master@709f5b7">

### Pi Plan Mode — hook 链式调用模式

plan hooks 在 index.ts 中与 goal hooks 链式调用: tool_call 中 plan 先拦截再 goal; before_agent_start 中 plan 先注入 systemPrompt 再传给 goal; agent_end 中 plan 先捕获文本再 goal 异步处理。plan 的 tool_call 返回 block 时直接 return，不再调用 goal。

</spec-entry>

<spec-entry category="coding" keywords="plan,bash,safety,patterns" date="2026-07-08" sid="S-20260708-5489" title="Pi Plan Mode — bash 命令安全过滤" source="master@709f5b7">

### Pi Plan Mode — bash 命令安全过滤

Plan 模式下 bash 工具本身允许（PLAN_ALLOWED_TOOLS），但通过 MUTATING_BASH_PATTERNS 和 SAFE_BASH_PATTERNS 双重 pattern 过滤具体命令。先检查是否匹配 mutating pattern（阻止），再检查是否匹配 safe pattern（放行），不匹配任何 pattern 默认阻止。参考 pi-extensions/pi-plan-mode 的 isSafeCommand 模式。

</spec-entry>

<spec-entry category="coding" keywords="todo,state-version,migration,contract-test" date="2026-07-10" sid="S-20260710-wz12" title="持久化 todo contract 的版本化迁移模式" description="通过版本化 read-boundary normalization 防止持久化任务字段漂移" source="planex-odyssey">

### 持久化 todo contract 的版本化迁移模式

Todo public schema 与 runtime model MUST 共享单一 canonical contract。持久化 shape 变化时 MUST 写入 state version，并在 read boundary 将 legacy inject/injection/load/completion 归一化为新模型；update MUST 区分 omitted、empty 与 null，且 focused tests MUST 覆盖 preserve、replace、clear 和 legacy migration。

</spec-entry>