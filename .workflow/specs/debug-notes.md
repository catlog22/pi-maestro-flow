---
title: "Debug Notes"
readMode: optional
priority: medium
category: debug
keywords:
  - debug
  - issue
  - workaround
  - root-cause
  - gotcha
---

# Debug Notes

## Entries



<spec-entry category="debug" keywords="plan,manifest,approval,transaction-lock,recovery,concurrency" date="2026-07-11" sid="S-20260711-5vq1" title="Pi Plan Mode — 持久化恢复必须验证 invariant 与锁所有权" description="Plan 持久化恢复和跨进程锁的 fail-closed 工程规则" source="planex:plan-mode-lifecycle">

### Pi Plan Mode — 持久化恢复必须验证 invariant 与锁所有权

PlanStore 在清理 approval archive 前必须严格验证 manifest 的 revision、status、checksum、approvals path 和 archive filename invariant；任何结构性损坏必须进入 archive-based rebuild，禁止把合法历史当 orphan 删除。跨进程事务锁必须具有 owner token、heartbeat 和 owner-checked release；仅依赖目录 mtime 的 stale takeover 会在长事务中破坏锁所有权并删除 in-flight archive。应使用可注入时钟与阈值覆盖 damaged manifest、stale takeover、旧 owner release 和 clock rollback。

</spec-entry>