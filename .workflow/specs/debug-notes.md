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

<spec-entry category="debug" keywords="teammate turn_end agent_end lifecyclepending" date="2026-07-23" sid="S-20260723-ie6b" title="Teammate 结果发布与生命周期确认必须解耦" description="避免 teammate 已产出结果却因等待 agent_end 阻塞并行聚合" source="master@a67f2b52">

### Teammate 结果发布与生命周期确认必须解耦

严格 final turn_end 只发布可消费结果并标记 lifecyclePending，不得 kill 或转 sleeping；agent_end、close、error 才负责清除 resultReadyAt、触发 onTurnComplete 并落定可唤醒生命周期。并行与 DAG 依赖以结果发布为释放边界。

</spec-entry>