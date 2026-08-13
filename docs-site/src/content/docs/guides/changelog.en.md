---
title: "Changelog"
icon: "🔄"
---

This page records user-visible features, behavior changes, fixes, and upgrade requirements from the previous stable release to the current version of the pi maestro flow suite.

> **Current stable release: v0.20.0 (2026-08-13).** Flow 0.20.0 bundles Teammate 1.13.0, Cockpit 0.15.0, and Settings-Core 0.1.3, adding the execution-generation session model, Teammate output management, agent:// publication ids, compaction hardening, and the Cockpit Zen Stack.

## v0.20.0 (2026-08-13)

- Execution-generation sessions with `run-response/1.1`, v3 capability negotiation, and statusless projection.
- Teammate output capacity management, immutable publication ids, and hardened dispatch, delivery, observe, and retry paths.
- Hard tool-boundary compaction, deferred tool activation, managed Chrome profiles, and Goal verifier recovery.
- Cockpit Zen Stack and a detachable viewport-stability patch.
- Install with `pi install npm:pi-maestro-flow@0.20.0`.

## v0.18.0 (2026-08-09)

**Comparison:** `v0.17.0 (withdrawn) → v0.18.0`
**Code cutoff:** 2026-08-09

### 1. Packaged Skill Discovery Fix (v0.17.1 fix merged)

- Packaged Pi resources (Skills / agents / catalog entries) are materialized into the installed plugin directory after `pi install` (`prepare-package-skills.mjs`, `maestro-package.ts`, skill-loader / skill-manager / skill-runtime wiring).
- New runtime tests: `package-resources-runtime.test.ts` (discovery), `package-resources.test.mjs` (tarball content), `prepare-package-skills.test.mjs`.
- Release gate now includes a genuinely isolated `USERPROFILE` + `HOME` fresh install: runtime Skill listing plus at least one Skill invocation.

### 2. Teammate Cross-Session Delivery Hardening

- WindowThread delivery journal: incoming/outgoing messages transition through `queued → injected → accepted/rejected/timeout`, idempotent re-delivery, thread entries persist across reload.
- Workspace-peer messages carry `source` (user/monitor/system), `messageKind` (message/supervision), `traceId`, `replyTo`, `fromSessionName`; formatted root-message rendering (`formatWorkspaceRemoteRootMessage`) for main-session delivery.
- Incoming root-queue replay (`shouldReplayWorkspaceRootQueue`): queued peer messages are re-delivered after an extension reload instead of being lost.
- Monitor interventions: delivery acknowledgement with retry and stale detection (`InterventionDeliveryAck`, `sendInterventionWithRetry`).
- Cross-session `abort` requests are explicitly rejected with a clear error.
- New/updated tests: session-core, workspace-peers, monitor-runtime, monitor-supervision, session-mode.

### 3. Settings-Core 0.1.3 (un-deprecate)

- No code changes; version bump only to remove the deprecated marker left by the withdrawal so the closure installs cleanly.

### 4. Optional Scholar Skills Suite

- `optional/skills/scholar-*`: 10 optional academic-research skills (ideation, experiments, writing, review/rebuttal, citation verification, anti-AI-writing polish, LaTeX organizing, conference publication, thesis DOCX).
- Not part of the default install surface; enable with `maestro install toggle --enable <skill>` (see `optional/skills/README.md`).

### 5. Docs

- New Self-Evolve guide pages (zh/en); landing feature card updated; changelog records the withdrawal and v0.18.0.
- All install commands updated to v0.18.0.

**Upgrade:**

```bash
pi install npm:pi-maestro-flow@0.18.0
pi list
```

Users on v0.17.0 can overwrite-install directly; do not run `pi remove` first.

---

## v0.17.0 Withdrawal (2026-08-09)

After publication, some fresh npm installs started Pi with no Skills available. The complete release closure was removed from `latest` to stop new affected installs:

| Package | Withdrawn | Current `latest` |
|---------|----------:|-----------------:|
| `pi-maestro-flow` | `0.17.0` | **`0.16.0`** |
| `pi-maestro-teammate` | `1.10.0` | **`1.9.0`** |
| `pi-cockpit` | `0.12.0` | **`0.11.0`** |
| `pi-maestro-settings-core` | `0.1.2` | **`0.1.1`** |

npm rejected physical unpublish because the current granular token cannot perform destructive operations under the registry's 2FA policy. All four versions remain for audit, carry deprecation warnings, and are no longer selected by `latest`.

Online tarball comparison found 194 Skill entries in both Flow `0.16.0` and `0.17.0`. The incident is therefore not a simple missing-file package; install registration, path synchronization, and runtime discovery remain under investigation. A fixed release must verify the Skill list and at least one real invocation in a genuinely isolated `USERPROFILE` and `HOME`.

Users who installed v0.17.0 should close every Pi process and downgrade directly:

```bash
pi install npm:pi-maestro-flow@0.16.0
pi list
```

Do not run `pi remove npm:pi-maestro-flow` first. It may uninstall the entire shared npm dependency tree and leave Cockpit/Teammate registrations pointing to missing paths.

---

## v0.17.0 (Withdrawn, 2026-08-09)

**Comparison:** `v0.16.0 → v0.17.0`  
**Code cutoff:** 2026-08-09  
**Theme:** cross-session scheduling, durable monitor supervision, shared TUI locale, session handoff, and run-loop hardening

### Version Matrix

| Component | v0.16.0 | v0.17.0 | Main area |
|-----------|---------|-------------------|-----------|
| `pi-maestro-flow` | `0.16.0` | `0.17.0` | orchestration, Self-Evolve, run loops, API Manager |
| `pi-maestro-teammate` | `1.9.0` | `1.10.0` | cross-session scheduling, Monitor, routing, session UI |
| `pi-cockpit` | `0.11.0` | `0.12.0` | Agent/Window bars, session tabs, window monitoring |
| `pi-maestro-settings-core` | `0.1.1` | `0.1.2` | shared locale and translation contracts |
| `maestro-flow` | `0.5.65` | `0.5.67` | Run/Session chain and argument propagation fixes |

Node.js `>=22.19.0` is still required. Pi core packages remain host-provided, with `@earendil-works/pi-*@0.83.0` as the development verification baseline.

## Major Changes

### 1. Cross-Session Scheduler and Sessions Core

Teammate now has a cross-session scheduler and session registry. Monitor workloads can run in an independent session instead of being tied to the interactive session that launched a task.

- `SchedulerCore` coordinates cross-session queuing, wakeups, and result delivery.
- Sessions Core maintains session endpoints, window-mode registrations, and host reachability.
- Flow publishes cross-session results with an explicit output-store acknowledgement boundary.
- Durable per-turn publication IDs make repeated delivery and observation idempotent.
- Cockpit consumes endpoint-backed Agent and Window state for tabs, handoff, and independent monitoring.

See [Monitor Cross-Session Supervision](/guides/monitor), [Parallel Multi-Agent Dispatch](/guides/teammate-dispatch), [Advisor Turn-Level Supervision](/guides/advisor), and [Pi Cockpit Visualization](/guides/cockpit).

### 2. Durable Monitor Supervision

Monitor is now a persistent supervision runtime rather than a transient view.

- Supervision events are recorded in a durable ledger and can survive reloads.
- A deterministic Monitor Controller owns leases, session modes, and intervention state transitions.
- Closed-loop intervention can detect stalls or drift and send controlled corrective guidance to an active Agent.
- Advisor evaluates turn quality against goals and constraints.
- Stall notifications are throttled per Agent cooldown.
- Monitor can run in an independent session without consuming the main interactive session lifecycle.

### 3. Teammate Dispatch, Routing, and Control Center

- **Custom task types:** project Agents can declare task types alongside the built-in routing phases.
- **Routing context:** model selection receives Agent, task type, session mode, and caller context.
- **Role circuit policies:** repeated role/model failures enter a controlled circuit state instead of retrying indefinitely.
- **Maximum thinking level:** Control Center can select `max`, which remains an alias for `xhigh`.
- **Concurrency-limit recovery:** capacity-limit failures are retryable and the backoff cap is configurable.
- **Observation turns:** `observe` can expose grouped turn history with monitor-mode context.
- **Session handoff:** `Alt+R` opens the session list and preserves routing, monitor, and turns context when handing off.
- **Reviewer role:** the project Agent catalog includes a dedicated read-only code reviewer.
- **Schema alignment:** tool descriptions, Todo guidance, and parameter schemas now agree.

See [Parallel Multi-Agent Dispatch](/guides/teammate-dispatch) and [Model Routing & Thinking Depth](/guides/model-routing).

### 4. Cockpit Session and Window UI

- Endpoint-driven Agent Bar and Window Bar summarize active work and reachable windows.
- Session tabs and persistent session UI state preserve selection while switching.
- Session-list handoff, window monitoring, and keyboard routing were reworked together.
- Window Thread View exposes another window's conversation context without leaving Cockpit.
- Overlay, sidebar, split-pane, and input routing now share the same session state.
- Edit-guard failures report a more specific target and reason.
- Cockpit chrome follows the shared TUI locale without a restart.

### 5. Shared TUI Locale and Translation Catalogs

Settings Core now provides a public i18n contract used by Flow, Teammate, and Cockpit while each package retains its own catalog.

- System locale detection uses `LC_MESSAGES → LANGUAGE → LANG → Intl` precedence.
- The shared translator merges base and package catalogs.
- Existing locale events propagate in-shell language changes to all companion extensions.
- Locale listeners are released on quit/reload to prevent duplicate subscriptions.
- zh-CN catalogs keep protocol identifiers such as `taskType`, `thinking`, Provider, and Agent untranslated.

See [Settings System Overview](/guides/settings-overview) and the [TUI Operations Guide](/guides/tui-guide).

### 6. Self-Evolve Auto-Deposit Mode

Self-Evolve Phase 2B introduces `auto-deposit` while retaining `dry-run` as the cautious path.

- A CLI staging gate validates mode and candidate eligibility before writing.
- The current session can switch between `dry-run` and `auto-deposit` without reloading.
- Auto-deposit creates candidates only; evidence, review, and promote governance still apply.
- Deep simulation and end-to-end coverage exercise mode switching and fallback behavior.

See [Self-Evolve Knowledge Automation](/guides/self-evolve) and the [Knowledge System](/guides/knowledge).

### 7. API Manager Migration and Header Presets

- API Manager can rename a model ID and migrate downstream references, reducing stale failover, mapping, and Agent configuration.
- Channel configuration adds Agent header presets for Claude Code, Codex, Grok, and Antigravity while retaining custom headers.
- Migration validates source and destination IDs to prevent collisions and dangling references.

See [API Provider & Failover](/guides/api-provider-config).

## Stability and Fixes

### Run Loops and Compaction

- Reload re-arms Loop Scheduler and resumes persisted loops.
- Compaction replacement preserves loop-critical markers.
- The tool loop stops at the first safe boundary after the hard compaction threshold.
- History-editor route sigils and long-content render truncation are corrected.

See [Compaction Capacity Management](/guides/compaction-config) and [bash_bg & observe](/guides/bash-bg-observe).

### Tool and Platform Fixes

| Area | Fix |
|------|-----|
| `bash_bg` | foreground-to-background transition returns a consistent snapshot for `observe` |
| Browser | `browser run` failures include an actionable cause |
| Windows packaging | local tarball listing uses `--force-local` |
| Teammate | concurrency limits retry with a configurable cap; stall notices respect cooldown |
| zh-CN TUI | protocol keywords remain aligned with configuration values |
| Cockpit edit guard | failures identify the target and rejection reason more precisely |

## Core Engine 0.5.65 → 0.5.67

The candidate manifest moves the exact `maestro-flow` pin from `0.5.65` to `0.5.67`.

- **0.5.66:** line-delimited artifact metadata in Run Sessions.
- **0.5.67:** projections on all Session creation paths, enum argument validation, session prune, preserved chain-file step args and explicit topics, and `--arg` propagation while failed Sessions remain canonically reachable.

Because this is an exact pin, an existing install does not automatically follow the upstream engine version.

## Behavior and Upgrade Notes

1. Close all running Pi processes before upgrading so an older in-memory SettingsManager cannot overwrite the new disk configuration.
2. Companion registration order remains **Teammate → Cockpit → Flow**. Verify every version with `pi list` after restart.
3. TUI locale changes now affect all three extensions. Keep protocol keys untranslated in custom catalogs.
4. For independent Monitor sessions, ensure the target workspace remains visible and its endpoint is registered.
5. Model-ID rename migrates managed downstream references; check external scripts and files separately.
6. `auto-deposit` does not bypass evidence, review, or promote governance.
7. Keep the exact Flow/Core Engine dependency closure together when upgrading.

Users on v0.17.0 should roll back:

```bash
pi install npm:pi-maestro-flow@0.16.0
pi list
```

The current `latest` resolves to 0.16.0. Do not run `pi remove npm:pi-maestro-flow` first.

## Key Commits

| Commit | Change |
|--------|--------|
| `11e26d28` | durable Monitor ledger, interventions, and Advisor |
| `56d291b3` | cross-session Scheduler/Sessions Core |
| `9e2803f6` | cross-session result publication and output-store acknowledgement |
| `6431d9f8` | endpoint-driven Agent/Window bars and session tabs |
| `fa97c02f` | session-list handoff and window monitoring |
| `86152333` | Self-Evolve auto-deposit Phase 2B |
| `7eb22395` | API Manager model-ID rename and downstream migration |
| `3a870ea1` | shared TUI locale and package catalogs |
| `3287b757` | role circuit policies, custom task types, routing context |
| `6bcb9fca` | observation turns and transcript grouping |
| `afb9dbda` | `Alt+R` session-list handoff |
| `8e4c3d38` | Cockpit edit-failure diagnostics |
| `f021f083` | `release: v0.17.0` (release commit) |

Repository maintenance moved pipeline output to `.pi-sync` and removed the tracked `flow/` mirror. This changes repository layout but not package behavior.

### Pre-Withdrawal Verification and Gap (2026-08-09)

- The serial root `test:release` gate passed (3140 ok / 0 fail across settings-core, teammate declarations, cockpit, all Flow subsystems, and packed consumers).
- Dry-run tarball shasums matched npm: settings-core `0.1.2` `a94722d4`, teammate `1.10.0` `9f5a5651`, cockpit `0.12.0` `0d9521d2`, flow `0.17.0` `7330fed7`.
- The original fresh-directory smoke verified package versions and RPC startup, but did not assert that Pi actually discovered and could invoke installed Skills. That missing assertion allowed the release gate to pass.
- The next patch must use isolated `USERPROFILE` + `HOME`, verify the Skill list, and invoke at least one installed Skill.
- Original publication order: settings-core → teammate → cockpit → flow; exact `maestro-flow` pin `0.5.67`.

See the repository `RELEASE.md` and the GitHub [`v0.17.0` Release](https://github.com/catlog22/pi-maestro-flow/releases/tag/v0.17.0) for the archived release record.

---

## v0.16.0 (2026-08-07)

v0.16.0 delivered the complete in-shell settings suite, session-level knowledge governance, window transcript evidence staging, Self-Evolve M1-M5, Todo-bound dispatch, `agent://` result records, and compaction-pressure hardening.

| Component | Version |
|-----------|---------|
| `pi-maestro-flow` | `0.16.0` |
| `pi-maestro-teammate` | `1.9.0` |
| `pi-cockpit` | `0.11.0` |
| `pi-maestro-settings-core` | `0.1.1` |
| `maestro-flow` | `0.5.65` |

Highlights:

- API Manager, hooks, themes, providers, failover, and vision configuration stay in-shell.
- Dispatched Agents can own and advance bound Todo queues.
- Plain and structured Agent results are readable through `agent://`.
- Knowledge governance gained session scope, transcript evidence, and the K12-K17 review flow.
- Self-Evolve completed the M1-M5 automation layer and parallel-session foundation.
- Compaction gained tool-loop pressure termination, summary retry, gateway circuit breaking, and zombie-lease repairs.
- Core Engine 0.5.63 removed the vulnerable legacy Sharp runtime chain; 0.5.64-0.5.65 strengthened governance and evidence auditing.

See the repository `RELEASE.md` and the GitHub `v0.16.0` Release for the archived release record.
