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