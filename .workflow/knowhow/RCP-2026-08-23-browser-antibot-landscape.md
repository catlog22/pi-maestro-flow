---
title: WAF identification (DataDome/Akamai/PX/Kasada), vendor notes, cookie replay, strategy order
type: recipe
tools: [browser]
sop_topic: antibot-landscape
sop_order: 0
category: browser-sop
created: 2026-08-23T00:00:00Z
tags: [browser, sop]
---

Beyond Cloudflare — identify the defense first, then pick the strategy.

IDENTIFY FIRST
- Challenge signatures differ per vendor — do not assume Cloudflare. is-antibot (npm) classifies 30+ providers (Cloudflare, Akamai, DataDome, PerimeterX/HUMAN, Kasada, Imperva, AWS WAF, Shape...) from headers/body. wafprobe-style probing mutates ONE client-fingerprint axis at a time (TLS JA3/JA4, header order, UA) to reveal which signal is actually checked.

VENDOR NOTES
- Cloudflare IUAM/Turnstile: see core + captcha-strategies (attach real browser; token/cf_clearance binding rules).
- DataDome, PerimeterX/HUMAN, Kasada, Akamai: heavier behavioral + TLS fingerprinting; headless/CDP leaks fail fast. COOKIE REPLAY is often more practical than re-solving: pass the challenge once, reuse the _datadome/_px*/cf_clearance cookie within its lifetime on the SAME IP+UA.
- Queue systems (Waiting Room, ticketing queues): keep the queue tab alive and poll position; never re-enter or you go to the back.

STRATEGY ORDER
1. Attach the user's real browser (core mode choice) — passes most JS + behavioral checks.
2. Cookie/session replay within the IP+UA binding (captcha-strategies).
3. Vendor-specific solver sidecars (self-hosted containers exposing a local HTTP solve endpoint).

