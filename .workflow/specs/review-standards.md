---
title: "Review Standards"
readMode: required
priority: medium
category: review
keywords:
  - review
  - checklist
  - gate
  - approval
  - standard
---

# Review Standards

## Entries



<spec-entry category="review" keywords="plan,acceptance,verification,lifecycle,regression,transaction" date="2026-07-11" sid="S-20260711-w3ha" title="Pi Plan Mode — AC1-AC8 verification matrix" description="Plan 模式生命周期的严格验收矩阵" source="planex:plan-mode-lifecycle">

### Pi Plan Mode — AC1-AC8 verification matrix

Plan lifecycle completion requires objective evidence for: exact active-tool snapshot and restore; basename plus normalized-path-hash global Markdown storage; full-screen editable Markdown with width/keyboard matrix; archive and manifest commit before Act; six plain-Markdown tool contracts and mode gates; slash/shortcut/proposed_plan/hook/shell compatibility; shutdown/restart/reinit retry semantics; and focused plus existing Flow regressions. Persistence verification must include malformed semantic manifest, missing manifest, clock rollback, invalid and interrupted pending markers, long heartbeat transaction, dead-owner takeover, former-owner rejection and post-commit cleanup failure.

</spec-entry>

<spec-entry category="review" keywords="lifecycle generation lease subprocess tempfile packed-consumer" date="2026-07-16" sid="S-20260716-f5n2" title="共享状态与外部资源的生命周期审查矩阵" description="跨 correctness、security、performance、architecture 的生命周期审查检查表" source="odyssey-review:20260716-002-odyssey-review">

### 共享状态与外部资源的生命周期审查矩阵

审查异步共享状态、lease、cache、subprocess 与敏感临时文件时，必须同时验证：入口完成 canonical normalization 与授权；每个 await 后复验 owner、generation 或 lease；持久化成功后才 publish live state；成功、异常与 Abort 均执行 flush、dispose 和进程树回收；临时文件使用私有目录、唯一名称、wx 与 0o600，并拒绝 symlink 或非普通目标。回归测试必须包含反向并发交错、失败注入，以及涉及发布契约时的 fresh-process packed-consumer 验证。复杂跨进程残余必须逐项建 issue，禁止用 skip、symlink 或 registry downgrade 掩盖。

</spec-entry>

<spec-entry category="review" keywords="goal,completion,verifier,evidence,fail-closed" date="2026-07-24" sid="S-20260724-5nbs" title="Goal 完成验证必须检查真实证据" description="Goal 完成门必须验证实际状态而非完成声明" source="analyze:20260724-001-analyze">

### Goal 完成验证必须检查真实证据

Goal 的 done transition 必须由独立只读 verifier 基于真实工作区或外部状态证据确认；仅审查主 agent 的 completion summary 不构成完成验证。验证顺序固定为 canonical blockers 前置、聚焦只读检查、结构化 fail-closed verdict；失败或证据不足必须保持 Goal active。

</spec-entry>

<spec-entry category="review" keywords="footer,context,token,narrow-width,layout" date="2026-07-27" sid="S-20260727-libx" title="Footer 资源组第一行与窄屏降级" description="Footer 第一行资源组与渐进降级规则" source="session:20260727-impeccable-footer-first-line">

### Footer 资源组第一行与窄屏降级

Footer 的 Context、input/output 与 cache 资源组 MUST 位于第一行右侧。空间不足时 MUST 先按 10 格进度条、5 格进度条、无进度条、百分比逐级简化，再牺牲高优先级身份信息。本规则替代 20260727-impeccable-footer-usage 的第二行资源组决策。

</spec-entry>

<spec-entry category="review" keywords="working,todo,tool,status,cockpit" date="2026-07-27" sid="S-20260727-2i1v" title="Working 状态不得展示 Todo 内容" description="Working 默认文案与活动工具名边界" source="session:20260727-impeccable-footer-first-line">

### Working 状态不得展示 Todo 内容

Cockpit 的 Working 状态 MUST 保留宿主默认 Working、耗时与中断提示，不得展示 Todo、agent 或后台任务内容；仅当前台工具正在执行时以工具名称替换 Working 标签，工具结束后立即恢复。

</spec-entry>

<spec-entry category="review" keywords="approval,yolo,bypasspermissions,defaultmode,footer" date="2026-07-27" sid="S-20260727-91p8" title="默认 YOLO 审批模式与显式禁用优先级" description="默认 YOLO、显式配置覆盖与管理员禁用边界" source="session:20260727-impeccable-default-yolo">

### 默认 YOLO 审批模式与显式禁用优先级

无显式 permissions.defaultMode 时，pi-maestro-flow MUST 使用 bypassPermissions 作为默认审批模式，并在 Footer 以红色 YOLO 显示。显式 defaultMode MUST 覆盖该默认值；permissions.disableBypassPermissionsMode=disable MUST 具有最高优先级并回退到 default。

</spec-entry>