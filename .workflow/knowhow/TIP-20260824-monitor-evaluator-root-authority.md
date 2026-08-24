---
title: Separate Monitor evaluator identity from root interaction authority
type: tip
explicitId: tip-20260824-monitor-evaluator-root-authority
created: 2026-08-24T14:27:28.897Z
---

isMonitorSession() identifies an evaluator child only when PI_TEAMMATE_CHILD=1 and PI_TEAMMATE_MONITOR=1. This is distinct from the root control window's dynamic Monitor interaction/authority state; flow-schedule should consume the latter's dynamic exposure. A Monitor evaluator host must not report a successful background dispatch without a bound identity as identity missing. Real identity validation remains fail-closed.
