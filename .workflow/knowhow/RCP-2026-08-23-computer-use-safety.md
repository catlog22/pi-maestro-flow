---
title: Destructive input, near-zero stop, foreground verification, and bounded operations
type: recipe
tools: [computer_use]
sop_topic: safety
sop_order: 0
category: computer_use-sop
created: 2026-08-23T00:00:00Z
tags: [computer_use, sop]
---

Safety guide

- Observe before acting and verify after acting. Every input must target a known window and verified foreground state.
- Destructive controls/chords are rejected unless allow_destructive=true. Network-game software input is always rejected.
- If the diagnostic verdict is near_zero, the manager latches the window: stop, take a fresh screenshot/detect/ui_tree/find_control, or activate again, then reassess.
- AbortSignal, timeout_ms, and deadlines are hard stops. Do not retry blindly after TIMEOUT, ABORTED, FOREGROUND_NOT_VERIFIED, STALE_CONTROL_REF, or permission errors.
- Never work around OS permissions, Wayland restrictions, or provider capability failures.

