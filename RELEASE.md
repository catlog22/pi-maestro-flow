# v0.32.0 — Scoped Decisions, Exact Evidence & Browser Bridge

## Overview

Flow **0.32.0**, Teammate **2.8.0**, Cockpit **0.24.2**, Backend-Core
**0.1.5**, and Backends **0.1.6** add human-scoped Plan preauthorization,
advisory decision routing, exact Goal evidence, and multi-listener browser bridging.
Settings-Core **0.2.3** is unchanged.
The validation baseline is **Pi 0.99.0**. Legacy **0.87–0.98** compatibility
remains explicitly version-gated; optional host peers keep their `*` ranges.
Missing native APIs do not authorize a second legacy runtime on a native host.

## Highlights

### Human-scoped Plan auto and advisory policy

- **Plan-auto is default off** — a human in the parent TUI can enable it during
  the current Plan cycle with `/plan-auto on` or `Alt+Shift+A`. The host-memory
  grant is scoped to session/cwd/cycle/generation; RPC, extension messages,
  children, history replay, reload, and a new Plan cycle cannot create or restore
  it. `/plan-auto off` revokes future automatic decisions, not already-started
  execution (`src/tools/plan-auto.ts`).
- **Exact approval, fixed execution** — the next `plan-confirm` uses the normal
  durable approval transaction and executes **standalone/current** only: no
  inherited Workflow, New Context, or decision-document authority. Revocation
  before handoff preserves committed approval but prevents execution; it does
  not silently retry (`src/tools/plan.ts`).
- **Advisory decision policy** — manually invoke `/skill:decision-policy` in the
  parent interactive session to propose and human-confirm a revision-checked
  `.pi/decision-policy.json`. Ask and self-evolve domains support `off`, `shadow`,
  and `enforce`. Classification can use the configured native classifier or a
  bounded LLM fallback; advice remains an LLM recommendation. Machine decisions
  are explicitly **not user answers or approval**; uncertain/external results,
  low confidence, unavailable models, exhausted budgets, and sensitive decisions
  remain human (`src/decision-policy/`, `src/tools/ask.ts`).

### Browser Bridge: explicit modes and shared resources

- **Multi-listener discovery** — each Pi listener binds an available loopback
  port in `19222..19231`; the MV3 extension discovers and maintains multiple
  listeners rather than replacing a live peer. A custom
  `PI_BROWSER_BRIDGE_PORT` shifts the ten-port server range; add the actual
  listening port in popup **Advanced** because Chrome cannot read Pi's env.
- **NONE is not authentication** — explicitly start Pi with
  `PI_BROWSER_BRIDGE_AUTH_MODE=none` for a token-free continuity handshake.
  Ready status is `transportReady:true`, `authenticatedConnected:false`, with
  no pending pairing and no token/pair step. Default `paired` mode still needs
  matching requestId/code approval followed by authenticated reconnection.
  NONE deliberately removes credential authorization; loopback/Origin filtering
  is not protection from malicious local processes (`src/tools/browser/bridge-server.ts`).
- **Real capability boundaries** — select `app.channel` explicitly:
  `managed | profile | cdp | extension`. Extension supports limited
  URL/title/goto/evaluate, raw CDP/batch, cookies, tabs, and screenshots, not full
  Puppeteer parity. Per-entry leases fence physical tabs across listeners;
  busy/draining does not prove work stopped. Cookies/login state remain shared,
  not isolated (`optional/browser-bridge/background.js`, `src/tools/browser/manager.ts`).
- **Profile attachment** — auto-launch uses `--remote-debugging-port=0` and
  `DevToolsActivePort`, or attaches a recorded endpoint. Chrome 136+ blocks
  debugging its default user-data directory even after windows close. Choose
  a non-default profile explicitly, or use extension for the daily browser;
  profiles are never copied or switched automatically. See
  `optional/BROWSER-BRIDGE-SETUP.md` and the browser guide.

### Exact Goal evidence and bounded review

- **Requirement-bound evidence** — `goal complete` accepts up to 16
  `evidenceRefs`, each with a requirement and exactly one explicit local path or
  exact `session://.../entry/...` / `agent://...` URI. Bounded resource pages
  preserve `nextPage` recovery; agent evidence pins an immutable publication.
  Missing/unauthorized/ambiguous evidence cannot become a passing verdict.
  Acceptance commands remain primary; fallback verifiers have a bounded read
  budget and may not replace exact evidence with broad workspace exploration
  (`src/tools/goal-evidence.ts`, `src/tools/goal-verification.ts`).
- **OpenCodeReview runner** — the external `ocr` CLI now has a bounded timeout,
  a combined 10 MiB stdout/stderr cap, abort and process-tree cleanup, and bounded
  stderr diagnostics. Windows npm/native launcher resolution follows the selected
  PATH installation; cleanup failures are errors, not success. This is code
  review, not browser image OCR (`src/ocr-review/runner.ts`).

### Scoped Codex Fast and native runtime safety

- **Codex Fast** — `/fast on|off|status` persists a project preference in
  `.pi/codex-fast.json`; `--fast` enables it for a launch. Only matching
  `openai-codex` / `openai-codex-responses` request payloads receive
  `service_tier:"priority"`; this may consume more quota and is not a latency
  guarantee. Teammate supports boolean `fast` at task/dispatch, taskType routing,
  and role levels; explicit false is authoritative. Child hooks are installed
  even on `--no-extensions` launches (`src/providers/codex-fast.ts`,
  `pi-maestro-teammate/src/shared/codex-fast.ts`, `src/extension/child-codex-fast.ts`).
- **Native classifier safety** — resolve the effective model before caching,
  validate native stop reason and question schema, and fence stale in-flight
  decisions. Classifier settings publish atomically with conflict/ownership
  checks and keep configured values separate from effective environment overrides
  (`pi-maestro-teammate/src/classify/`, `src/classifier/settings-provider.ts`).
- **Local TUI survives remote transport errors** — failed Ask/Plan transport
  promises do not count as user cancellation; the local prompt stays usable and
  pending remote requests remain available for reconnect. Explicit cancel and
  abort still clean up the race (`src/tools/ask.ts`, `src/tools/plan.ts`).
- **Host/provider polish** — Cockpit refreshes native host compatibility and
  status badges; Anthropic-compatible model discovery uses `/v1/models`.

### Self-evolve remains advisory and governed

- **Grounded enrichment and policy routing** — capture/review policy uses
  exact signalId/traceHash/sessionId joins and separate append-only sidecars;
  raw heuristic signals remain intact. Hybrid enrichment batches bounded model
  calls and references supplied evidence IDs only. Stale session/config/policy
  results cannot publish (`src/self-evolve/extension.ts`, `src/self-evolve/enrichment.ts`).
- **No automatic promotion** — policy off preserves the heuristic path;
  shadow is diagnostic; enforce can route grounded internal capture/review,
  not approve spec promotion. Self-evolve stays disabled by default, dry-run
  remains the default mode, and auto-deposit only stages reviewed candidates.
  Closeout must request explicit approval for concrete knowledge candidates;
  approved work or machine recommendations are not promotion authority.

## Package versions

| Package | Version | Release scope |
|---|---|---|
| pi-maestro-flow | 0.32.0 | updated |
| pi-maestro-teammate | 2.8.0 | updated |
| pi-cockpit | 0.24.2 | updated |
| pi-maestro-settings-core | 0.2.3 | unchanged |
| pi-maestro-backends | 0.1.6 | updated |
| pi-maestro-backend-core | 0.1.5 | updated |
| pi-maestro-fabric | 0.1.0 | unchanged |
| pi-maestro-fabric-core | 0.1.0 | unchanged |
| pi-fluent-tui | 0.1.2 | unchanged |

The external engine dependency remains **`maestro-flow >=0.5.87`**, not an
exact pin. The release preparation environment has **0.5.87** installed;
registry latest was **0.5.90** at preparation time. The release operator will
check the latest resolution in a fresh registry smoke before tagging.

The DSH SDK is now an **optional peer** (`*`): install
`@deepseek-ai/dsh-sdk-client` manually when using DSH. The development baseline
is **0.1.0-rc.6**; ordinary Pi users do not need that SDK.

## Scope

Pre-release feature range: **`v0.31.3..aa054f450da2440c44b604bb8e6d3e1f41ced0a3`**.
It contains **12 commits, 130 files changed, +11,047 / −1,491 lines**.
These statistics exclude this release's version, lockfile, and documentation
preparation and any later release commit; they are not final-tag statistics.

## Verification

- All selected `test:release` targets passed. The initial command stopped on
  stale integration contracts and a missing Codex Fast barrel export; those
  boundaries were corrected and rerun individually, then the unexecuted gate
  stages resumed. Unchanged passing targets were reused, not rerun wholesale.
- Changed Flow boundaries omitted from the root gate were additionally checked:
  Plan-auto/decision policy, exact Goal evidence, bounded OCR, browser bridge and
  profile attachment, classifier configuration, Codex Fast, and self-evolve.
- Real-tarball packed consumer and packed child Todo discovery passed. Two
  earlier packed attempts timed out during external npm/Python downloads;
  official PyPI wheels were cached in an isolated temporary directory for the
  successful attempt. Test contents and timeout limits were not weakened.
- One Windows Chromium screenshot-cleanup timing assertion failed in the gate
  and passed in its focused reproduction without changing production code.
  Credential-dependent DSH integration and platform-inapplicable POSIX tests
  retained their existing skips; one existing Vitest case is also skipped.
- Documentation-site `npm run build` (`tsc && vite build`) passed after the final
  homepage copy change: Vite **25.60s**, with only its >500 kB chunk-size advisory.
  Managed-browser checks confirmed the Chinese/English v0.32.0 banner, dismiss
  persistence, no horizontal overflow, and the updated browser bridge guide.
- Four unchanged workspace package dry-run SHAs matched their registry versions.

Publication and registry-backed fresh-install smoke are performed after this
preparation commit. The release tag is created only after registry SHA comparison
and isolated HOME/USERPROFILE Pi RPC/tool-catalog smoke pass.

## Locked publication artifacts

Each workspace dry-run matched its actual tarball SHA; `npm publish --dry-run`
passed for the locked tarballs. No private Pi host SDK/typebox copy is bundled.

| Package | Files | Packed / unpacked bytes | SHA-1 |
|---|---:|---:|---|
| pi-maestro-backend-core@0.1.5 | 7 | 13,165 / 38,757 | `bbaa0d5620a15d32da0343e9f6be9a7d7a614a91` |
| pi-maestro-backends@0.1.6 | 20 | 58,015 / 200,470 | `a78ade2163511c9715c062ec17a5f9041282effc` |
| pi-maestro-teammate@2.8.0 | 485 | 1,235,399 / 5,536,921 | `aa0dbfaf37d11a48291c92b61b39502337f01b74` |
| pi-cockpit@0.24.2 | 115 | 332,557 / 1,248,528 | `427d4097afe3da0ac74a874915a45bed7cc7eaec` |
| pi-maestro-flow@0.32.0 | 1,154 | 3,765,034 / 14,520,453 | `c203fe91c562921875f9b59ad734ded2adeffaf4` |

## Install / upgrade

Requires **Node.js ≥ 22.19.0**. Use **Pi 0.99.0** as the validation baseline;
legacy Pi **0.87–0.98** uses version-gated compatibility paths.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install npm:pi-maestro-flow@0.32.0
pi list
```

Close running Pi processes before upgrading, then restart Pi. Flow-managed
companion registrations migrate automatically; preserved local development
overrides must be upgraded or removed explicitly to match this suite.
