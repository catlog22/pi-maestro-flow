# v0.13.0 — Workspace Peers, Observe Barrier, Vision Delegation, Memory Bounds

## Overview

This release adds the teammate workspace-peers registry and the mixed-target
`observe` status/wait barrier, multimodal vision delegation with provider
strategy hardening, the `loop` tool for recurring work, a broad lifecycle and
relay hardening pass (compaction lease, MCP reconnect backoff, typed teammate
relay results), cockpit rendering stability (static mode, tick policy, viewport
stability), and bounded memory footprints across caches and background jobs.
The external core engine pin moves to `maestro-flow@0.5.60`.

## Package Versions

| Package | Version |
|---------|---------|
| pi-maestro-flow | 0.13.0 |
| pi-maestro-teammate | 1.5.0 |
| pi-cockpit | 0.7.0 |

## Highlights

### Workspace Peers Registry (`pi-maestro-teammate`)
- New workspace peers registry: heartbeat, ownership tracking, and a command
  bridge across sibling sessions (`1f82059`)
- Peers wired into the extension lifecycle and monitor surface (`78468e1`)

### Observe Tool (`pi-maestro-teammate`)
- New `observe` tool: single typed status/wait interface over mixed teammate
  and background-bash targets with `all`/`any`/`count` barriers (`319256a`)
- `bash_bg` observe provider, child-surface registration, and permission
  policy on the Flow side (`39a1c94`)

### Monitor Mode & Model Routing v3 (`pi-maestro-teammate`)
- Monitor mode with model routing v3 profiles and quiet auxiliary fallbacks
  (`dac81fe`)
- `maxNestingDepth` guard and cockpit agent-state visibility (`dc13120`)
- Terminated lifecycle status propagation and hardened cancellation
  boundaries (`a851abf`)

### Multimodal Vision Delegation (`pi-maestro-flow`)
- Vision delegation for image-capable models (`268762b`)
- Vision settings integrated into the API manager (`44e90c7`)
- Closed 11 vision multimodal strategy gaps from swarm audit (`4c0c807`)

### Loop Tool (`pi-maestro-flow`)
- New `loop` tool: session-scoped recurring prompts or shell commands with
  fixed delays, overlap protection, and max-run bounds (`d7b437a`)

### Provider Configuration (`pi-maestro-flow`)
- Provider config hardening: `api-provider-config` and `explore-config-manager`
  modules (`bade151`)
- Provider enable/disable and compat/headers editing without losing
  configuration (`03122b4`)

### Lifecycle & Relay Hardening (`pi-maestro-flow`)
- Compaction arbiter: bounded lease deadline armed only after the matching
  request starts — stale observations can no longer shorten a legitimate
  lease (`9d1715a`)
- MCP lifecycle: exponential reconnect backoff (30s base, 5m cap), failure
  tracking with user notification after 3 consecutive failures, generation
  fencing for stale health checks, in-flight health-check dedup (`9d1715a`)
- Teammate relay: `requestTeammateInteraction` returns typed results
  (`unavailable`/`timeout`/`send-failed`) instead of silent `undefined`;
  permission and questionnaire failures surface explicit reasons (`9d1715a`)
- Goal recovery: `compaction_retry` tracked with its own max-retries; widget
  shows retry state for all recovery kinds (`9d1715a`)
- Teammate lifecycle settlement and session fencing hardened (`481966b`);
  graph slots and DAG dependents released at result publication (`effe292`)
- Network retry: 6 error-classification gaps closed in the retry regex;
  Pi in-process retry enabled and model fallback ungated from tool count
  (`16bedc2`, `6ddadf8`)

### Compaction Tuning (`pi-maestro-flow`)
- Reserve-token threshold and cancel callback (`a369fd9`)
- Output-clamp-aware soft bands and deferred-intent escalation (`820c30c`)
- Pressure notifications deduped on stable threshold keys (`115669d`)
- Cross-flow coordination gaps closed (`4fd218c`)

### Memory Bounds (`pi-maestro-flow`)
- Bounded GitHub clone cache, research artifact cache, MCP UI message
  retention, and background job resources; verifier deadline enforced;
  evicted job logs reclaimed (`aac9dfb`, `7bd2c13`, `2819886`, `febde5c`,
  `b2edeec`, `b2fdf7c`)

### Architecture Template Library (`pi-maestro-flow`)
- `arch-kb` template lookup integrated into the system prompt and planner
  role (`8cbd48a`)

### Pi Cockpit (`pi-cockpit`)
- Static mode, tick policy, and usage-refresh throttle (`f89a8b3`)
- Live working duration and simplified in-progress glyph (`4f49b80`)
- Viewport stability, layout priority, quiet tool palettes (`3ec9f81`)
- Teammate status display gaps closed, including terminated-state rendering
  (`fab96cf`)

### Other Changes
- Chinese response mode persisted globally across workspaces (`b6fc1f6`)
- TUI filter inputs ignore navigation keys (`6905870`)
- Skill/agent doc paths migrated from `~/.pi/agent` to `~/.maestro`
  (`0768a89`, `5ed1f6e`)
- External core engine pin bumped to `maestro-flow@0.5.60` (`7b09c97`)
- Refactors: teammate module extraction (`teammate-core`, helpers/proxy
  split), `api-provider-config` split into config + ops, oversized source
  files split into focused modules (`3125ba6`, `19587c3`, `523ba6a`,
  `9d9c5f8`, `a1207e2`, `24fd04c`)

## Statistics

- 50 commits since v0.12.0
- 458 files changed
- +37,813 / −15,004 lines

## Install / Upgrade

```bash
npm install pi-maestro-flow@0.13.0
```
