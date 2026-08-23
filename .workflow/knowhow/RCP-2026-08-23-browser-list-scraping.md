---
title: Infinite-scroll bounded loops, lazy content triggers, deterministic pagination
type: recipe
tools: [browser]
sop_topic: list-scraping
sop_order: 0
category: browser-sop
created: 2026-08-23T00:00:00Z
tags: [browser, sop]
---

Infinite scroll, lazy loading & pagination — deterministic collection.

INFINITE SCROLL
- scrollTo(body.scrollHeight) + immediate read returns a STALE first batch: the IntersectionObserver has not fired and the next fetch has not landed. Never sleep-fixed loops — they break when the network slows down.
- Bounded loop: scroll one viewport -> wait for height growth OR item-count increase (with timeout) -> repeat until the count stabilizes across N rounds or a max-steps cap hits. Extract AFTER the loop; dedupe by stable keys (id/href).
- Best: harvest the batch API — observe responses (page.on('response')) to find the JSON endpoint feeding the list, then fetch it directly with page.evaluate (same cookies) and skip scrolling entirely.

LAZY CONTENT
- Scroll elements into view to trigger loading; for images wait naturalWidth > 0 before screenshots, otherwise you capture placeholders.

PAGINATION
- Prefer URL-pattern navigation (?page=N) over clicking when the site supports it. For SPA next-buttons: click, then diff the list container (tab.snapshot() + tab.diff()) to confirm the batch actually replaced.
- Stop conditions: disabled/missing next control, repeated identical content, or a hard page cap. Dedupe rows — sorted lists shift items across page boundaries.

