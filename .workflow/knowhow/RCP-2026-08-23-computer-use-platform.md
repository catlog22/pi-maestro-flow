---
title: Capabilities, permissions, Wayland, native bridges, and unsupported targets
type: recipe
tools: [computer_use]
sop_topic: platform
sop_order: 0
category: computer_use-sop
created: 2026-08-23T00:00:00Z
tags: [computer_use, sop]
---

Platform guide

- capabilities reports platform/session and per-feature state; permissions reports screen capture, accessibility, input, and window-control permission state.
- On Wayland, global capture/window/input/accessibility operations may be restricted. Prefer a tested compositor portal or X11 and re-probe.
- Windows and macOS may require screen-recording/accessibility/input permission grants. A denied or prompt state is not permission to proceed.
- Network-game targets reject software input. Unsupported platform, missing native bridge, missing vision model, blank frames, and invalid images are structured failures.
- Native providers must be bounded and verified; do not invoke arbitrary shell commands or guess provider-specific coordinates.

