---
title: Waiting vs sleeping, context hygiene, evaluate discipline, assert outcomes
type: recipe
tools: [browser]
sop_topic: automation-antipatterns
sop_order: 0
category: browser-sop
created: 2026-08-23T00:00:00Z
tags: [browser, sop]
---

Puppeteer antipatterns — silent-failure modes to avoid.

WAITING
- Never substitute hardcoded sleeps for state: wait on a selector, network idle, or verify DOM change (tab.snapshot() + tab.diff()). A sleep that "usually works" fails under load.
- After a click triggers navigation, wait for the navigation or expected DOM change before reading state (run output reports navigated/newTabs).

CONTEXT HYGIENE
- Reuse one named browser/tab across related steps; relaunching per step loses profile warmup and CF trust.
- Close pages/contexts opened in loops; leaked targets accumulate memory until the tab crashes.

EVALUATE DISCIPLINE
- Code inside page/tab.evaluate runs in page context: no Node variables or APIs. Pass data as explicit args; return plain JSON (no functions/DOM nodes).
- Existence-check before $eval/click — a missing element throws and aborts mid-flow. Probe with tab.observe() / extract('probe') first.
- React/Vue controlled inputs ignore direct value writes: set value via the native prototype setter + dispatch input/change (or type real key events), then VERIFY the framework saw it (submit button enabled, state changed) before proceeding.

ASSERT OUTCOMES, NOT ACTIONS
- Clicking submit is not success: confirm navigation/DOM/toast (tab.monitorStart()/monitorStop(), tab.diff()) before declaring the step done.

