---
title: Coordinate spaces, client origin, DPI, Retina, image origins, and verification
type: recipe
tools: [computer_use]
sop_topic: coordinates
sop_order: 0
category: computer_use-sop
created: 2026-08-23T00:00:00Z
tags: [computer_use, sop]
---

Coordinate guide

- screen_physical: absolute physical desktop pixels.
- window_client_physical: physical pixels relative to the target's client area; the platform resolves this through ClientToScreen/client origin.
- image: coordinates relative to an explicitly supplied image and its origin; map to screen only when image metadata proves the mapping.
- Windows DPI scaling and macOS Retina scaling make logical and physical coordinates different. Use display logicalToPhysicalScale/scale when exposed and keep bounds in physical pixels.
- A screenshot region must include region { x, y, width, height }; window capture must include window_id. Verify foreground and the resulting frame before input.

