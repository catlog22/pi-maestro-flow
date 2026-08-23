---
title: Turnstile/cf_clearance binding rules, widget behavior, stub-page pattern, CAPTCHA fallback ladder
type: recipe
tools: [browser]
sop_topic: captcha-strategies
sop_order: 0
category: browser-sop
created: 2026-08-23T00:00:00Z
tags: [browser, sop]
---

Turnstile & multi-CAPTCHA field strategies (distilled from github solver projects: B00H0O/cloudflare-solver, ismoiloffS/EzSolver, hasnainshahidx/turnstile_solver, gmh5225/captcha-solver).

BINDING RULES
- A Turnstile token AND a cf_clearance cookie are bound to the IP + User-Agent they were earned on. Solve and replay over the same egress IP; reuse the exact UA (solver APIs return it).
- Windows-launched Chrome leaks its fingerprint to CF (solver projects run on Linux for this reason). On a Windows desktop the equivalent working path is attaching the user's REAL daily browser (core section 1).

WIDGET BEHAVIOR
- Invisible/non-interactive widgets usually auto-resolve within seconds inside a trusted real browser — no click needed; poll the callback or hidden token input.
- Managed (checkbox) widgets need a human-like click on the checkbox INSIDE the widget iframe: locate the iframe rect, add offset, click via CDP Input with a hover dwell (see core coordinate pitfalls). When DOM queries fail (cross-origin / closed shadow), template image matching on a screenshot locates the checkbox.

STUB-PAGE PATTERN (token without touching the target)
- Render the widget on a stub page using the target's sitekey (+ cData/action if the site sets them), poll for the token (~2-5s), then submit the token to the real target. Token is one-shot, ~5min lifetime.
- Use a fresh isolated browser context per solve (own cookie jar) so solves do not leak into each other; discard the context afterwards.

FALLBACK LADDER (cheapest first)
1. Prevent: stealth/anti-detect browsers often pass Turnstile and reCAPTCHA v3 scoring with no challenge at all.
2. Click: find-and-click the checkbox in a real browser (free; Turnstile managed + some hCaptcha).
3. Paid solver API (2Captcha/CapSolver): reCAPTCHA v2/v3/Enterprise, hCaptcha, FunCaptcha, GeeTest v3/v4, DataDome, Akamai, Imperva, etc. Flow is always: send sitekey+pageurl(+proxy) -> poll for result -> inject the token into the form field / submit endpoint.

