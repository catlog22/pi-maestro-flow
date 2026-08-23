---
title: Observe, act, verify; coordinates, safety latches, and platform limits
type: recipe
tools: [computer_use]
sop_topic: core
sop_order: 0
category: computer_use-sop
created: 2026-08-23T00:00:00Z
tags: [computer_use, sop]
---

Computer-use SOP — use the smallest verified action and keep the observe-act-verify loop.

1. OBSERVE -> ACT -> VERIFY
  - Start with capabilities/permissions, then list_windows or screenshot.
  - Use screenshot, ocr, detect, ui_tree, or find_control to establish current state.
  - Activate the target window before input. After every input, inspect the result or request a fresh probe.
  - A near-zero pointer diagnostic latches the window. Stop input and re-probe before retrying.

2. PHYSICAL COORDINATES
  - Pointer coordinates are physical screen pixels unless coordinate_space is window_client_physical.
  - Client coordinates are added to the verified ClientToScreen/client origin; outer window bounds are never used as a client origin.
  - Windows DPI and macOS Retina scaling can differ from logical pixels. Use image metadata, display bounds, and physical coordinates; never guess a scale.
  - Regions and OCR/detect boxes use the source image origin and physical pixel space.

3. SAFETY
  - Destructive key chords and controls require allow_destructive=true and an explicit user-authorized task.
  - Software input into network_game targets is disabled. Use an approved hardware path instead.
  - Keep timeouts bounded. Stop immediately on abort, timeout, foreground verification failure, permission denial, stale control refs, or a near-zero verification.

4. PLATFORM LIMITS
  - Call capabilities and permissions before assuming capture, accessibility, input, or window control exists.
  - Wayland commonly restricts global window listing, capture, activation, accessibility, and input; use a tested portal/compositor or an X11 session.
  - Screen capture and accessibility permissions may require a user action. Do not bypass OS permission prompts.
  - Native providers are platform-dependent and may be unavailable; errors include remediation when a bridge or permission is missing.

