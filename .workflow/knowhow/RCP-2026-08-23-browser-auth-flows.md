---
title: Session reuse, TOTP generation, email/SMS OTP polling, OAuth popups, post-login assertions
type: recipe
tools: [browser]
sop_topic: auth-flows
sop_order: 0
category: browser-sop
created: 2026-08-23T00:00:00Z
tags: [browser, sop]
---

Login, OAuth & verification-code flows.

SESSION REUSE FIRST
- The cheapest login is the one you skip: in attach mode the user's cookies are already present — probe an authed URL and confirm login state BEFORE driving any credential form.
- After a programmatic login, export cookies (tab.cookies.get) so later runs can restore the session instead of re-logging-in.

CREDENTIAL FORMS
- Password fields: prefer real key events (tab.type/keyboard) over value injection — some frameworks bind on keydown and ignore synthetic input.

TOTP 2FA
- Holding the TOTP secret? Generate codes locally (RFC 6238, e.g. npm otplib) and fill the code input — no phone needed. Generate right before typing; if the 30s window has <2s left, wait for rollover first.

EMAIL/SMS OTP
- Flow: trigger send -> poll the inbox via API (IMAP or provider REST) -> extract the code with a contextual regex (near "code"/"verification code", usually 4-8 digits) -> type it. Poll with backoff up to ~60s; codes are single-use and expire in ~5-10min.

OAUTH POPUPS
- Consent screens often open a popup/new target: detect via run-output newTabs or tab.tabs(), drive THAT tab, then return to the opener. Do not launch with popup-blocking flags.

POST-LOGIN ASSERTION
- Interstitials ("checking browser", device-verification prompts) sit between submit and success: assert a logged-in marker (avatar element, account URL, cookie name) before continuing — see automation-antipatterns.

