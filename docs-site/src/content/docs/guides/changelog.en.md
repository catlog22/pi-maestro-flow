---
title: "Changelog"
icon: "🔄"
---

This page records user-visible features, behavior changes, fixes, and upgrade requirements from the previous stable release to the current version of the pi maestro flow suite.

> **Current stable release: v0.25.0 (2026-09-01).** SSH host management, remote-window supervision, session Artifacts, Todo result cards, and hardened Goal/Plan lifecycle; exact engine pin `maestro-flow@0.5.83`; bundles Teammate 2.3.0, Cockpit 0.20.0, Settings-Core 0.2.1, Backend-Core 0.1.2, and Backends 0.1.2.

## v0.25.0 (2026-09-01)

> This release ships Flow 0.25.0, Teammate 2.3.0, Cockpit 0.20.0, Backend-Core 0.1.2, and Backends 0.1.2; Settings-Core 0.2.1 is unchanged; exact engine pin `maestro-flow` 0.5.82 → 0.5.83. 52 implementation commits / 358 files / +59,108 −17,907 (excluding this release metadata).

- **Flow SSH and connectivity**: add encrypted `/ssh` host references and configuration, improve DSH remote SSH launch, add authenticated browser-extension pairing on an explicit channel, and connect flow-schedule, data-manager, and session Artifacts with ownership metadata.
- **Flow orchestration boundaries**: add atomic Todo batch mutations, task timing, and result cards; harden compaction, tool-result spill, provider/usage history, and browser tooling. Goal verification now allows bounded 10-minute verifiers and 5-minute acceptance commands, while canonical Workflow identity drift and terminal state fail closed; Plan approval no longer forces Goal creation.
- **Flow context continuity**: add bounded `session_history` and exact `session://` entry resources; explicit `new_context` resets are opt-in and carry deterministic Todo/Goal/Plan recovery capsules with validated resource references.
- **Flow Todo durability**: Todo tasks retain validated `resourceUris`, while agent output eviction preserves records referenced by durable completion manifests and aliases.
- **Teammate 2.3.0**: add agent/runtime provenance, Monitor window lifecycle and remote-window protocols, and a workspace-peer observation rewrite; harden SSH/remote workers, ACP configuration, completion-outbox GC, and cross-window delivery ordering and crash consistency.
- **Teammate model routing and settlement**: saved Profiles can be listed, resolved, and activated by stable ID or name, with `/teammate-model` opening the Profiles tab; structured-output failures preserve provider causes alongside the applicable settlement diagnostic. Managed SSH host references preserve the OpenSSH default port without materializing an inline override; runtime-broker mailbox recovery exposes awaitable client prewarm for deterministic startup ordering.
- **Cockpit 0.20.0**: add window autocomplete, session/window owner identity, structured tool-call/result cards, Todo task cards and duration charts; stabilize the regular main-screen viewport and working row, and show only relevant shortcut hints while Todo is collapsed.
- **Backend contracts**: expose the SSH host contract from Backend-Core and improve DSH SSH launch and remote event handling in Backends, while preserving the OpenSSH default port for managed SSH hosts.

Upgrade: `pi install npm:pi-maestro-flow@0.25.0`



> This release ships Flow 0.24.0, Teammate 2.2.0, and Cockpit 0.19.0. Settings-Core 0.2.1, Backend-Core 0.1.1, Backends 0.1.1, and the `maestro-flow@^0.5.82` engine range remain unchanged.

- **Flow process lifecycle**: Maestro CLI, self-evolve stages, and SmartSearch share fail-closed process-tree reclamation; CLI runners accept `AbortSignal`, FFF initialization follows session cancellation, and SmartSearch enforces a host wall-clock deadline.
- **Flow Plan and providers**: approved Plan decomposition/compaction handoffs preserve Goal continuation; `/api-manager` and the settings shell keep managed provider registries synchronized, including explicit-empty lists and legacy fallback.
- **Teammate messaging**: `steer` now uses Pi's queued non-interrupting turn-boundary delivery; explicit `interrupt` performs abort + prompt and safely degrades to `follow_up` when interruption cannot be confirmed.
- **Teammate durability and coordination**: adds the `pi-teammate-outbox` CLI and lock-race coverage for remnant cleanup; teammate-send can address workspace-peer agents and dispatch accepts a `steeringMode` override.
- **Teammate resources and terminal state**: terminal results publish before completion callbacks; streaming progress is bounded; sleeping-runtime defaults are smaller and environment-configurable; corrupt outbox GC indexes self-heal.
- **Cockpit responsiveness**: `/usage` gains manual refresh and a polling toggle; Todo state-change events project immediately; input-history saves are crash-consistent with transient retry; ambient writes are deduplicated on a 500ms animation cadence.
- **MCPX**: quick tunnels now use HTTP/2.

Upgrade: `pi install npm:pi-maestro-flow@0.24.0`

## v0.23.0 (2026-08-27)

> This release ships Flow 0.23.0, Teammate 2.1.0, Cockpit 0.18.0, Settings-Core 0.2.1, Backend-Core 0.1.1, and Backends 0.1.1; engine pin `maestro-flow` 0.5.79 → 0.5.82 (caret). 121 commits / 789 files / +135,044 −12,784.

- **Teammate runtime identity & runtime-broker v3**: workspace identity is centralized in `getRuntimeWorkspaceIdentity` (canonical path + stable `workspaceId` + legacy id list), shared by flow-schedule, completion delivery, workspace peers and mailbox, still matching pre-realpath legacy ids. The runtime-broker protocol bumps to schema v3 with a `broker.probe` handshake, paginated `stream.events.page` (stable `throughRevision` upper bound to bound replay snapshots), and a readiness challenge. completion-outbox / mailbox file stores gain crash-consistent replace ordering and GC; workspace peers add an immutable per-session owner claim with lock-protected acquire and stale takeover.
- **Fork / wait-cycle / todo-context public contracts**: add `fork-snapshot` (`context: "fork"` children start from an ancestor-chain snapshot), `wait-cycle` self-wait deadlock detection (observe `wait` rejects a barrier that would require a cyclic target), and a versioned `todo-context` public API (`./v1/todo-context` export) so forked/spawned teammates receive compact Todo state directly in their prompt with no extra IPC.
- **completion-manifest extraction + compaction state relay**: extract the completion-intent manifest into a standalone `completion-manifest` module (version, dir, byte caps, canonical-name resolver, ordered replace, summary truncation) shared by the durability provider and agent output store; the manifest is persisted with revision fencing and replayed, invalid transactions are quarantined. Add `teammate-compaction-relay`: detects fork-context child startup and publishes compaction phase events (pending/continuation/completed/failed) over the Pi child IPC, so the parent Cockpit tracks mid-turn auto-compaction recovery without polling.
- **plan-decompose tool**: add `plan-decompose` — given the approved Plan handoff key it returns a self-contained decomposition prompt that the main flow turns into one complete, topologically ordered Todo batch (the simplified counterpart of Maestro's decomposition.goals). Plan execution guidance now routes complex approved work through plan-decompose before creating Todos. Plan confirmation is simplified: it no longer carries the full refine output and R-toggle preview, only a refine-attached metadata flag plus Apply/Discard actions. Plan review threads the notify user-attention handler so blocking prompts fire desktop alerts.
- **Desktop notify + user-attention prompts**: `/notify` now prefers native desktop notifications (`desktop-notifier`, falling back to `ctx.ui.notify` toast) and adds an `onInput` category fired when Pi is blocked waiting for a user decision. A shared `user-attention` handler wires permission prompts and the ask tool to the same path. `/notify` switches are now `on|off|error|complete|input|status`.
- **Browser bridge (explicit limited channel)**: add an optional token-authenticated Chrome MV3 extension channel. It is selected only with `app.channel:"extension"`; disconnects and unsupported APIs fail closed with no automatic takeover or fallback. The first adapter supports URL/title, goto/evaluate, raw CDP/batch, cookies, tabs, and CDP screenshots rather than full Puppeteer parity. `browser status` reports live server/authentication/tab and named-entry metadata, while `/install` checks only a historical verified marker plus valid configuration. The extension and setup guide ship under `optional/`.
- **flow-schedule workspace identity + Todo mutation gating**: the flow-schedule actor runtime resolves identity via `getRuntimeWorkspaceIdentity` and accepts `todoMutationSupported`, so the tool gates Todo mutations on managed-worker windows.
- **Cockpit session-projection fences + CLI agent badge + usage bars**: agents-store and endpoint-store carry a `SessionProjectionIdentity` (workspaceId/sessionId/sourceId/generation), fencing rows and endpoints to the live root session and rejecting stale registry generations on connect. External CLI backends (`cli/*` model prefix) render a dedicated badge, and the stall timeout is owned locally (30s) instead of importing the broker constant. A usage module (`usage/core.ts` + `extension.ts`) polls provider quota/balance/spend and renders bars on a dedicated footer line, configured via Cockpit config (`usage.enabled/footer/pollIntervalMs/barWidth/commandKey`) and the settings provider.
- **observe lastResult unconditional rendering**: observe output now renders `lastResult` unconditionally — a one-line flattened excerpt without verbose and the full multiline block under verbose — so a polling observer can tell "finished what it was asked" from "not started yet" without requesting detail. Paired with a window-side `mainLastSettle` single-slot projection that keeps the most recent `agent_settled` result across turns.
- **Teammate runtime core upgrade — model-registry model registration**: replaces the backend-registry v2 mode with canonical model-registration ids + deployment topology + a four-gate pipeline (registered/resolvable/sessionAvailable/healthy); DSH deployments use an adapter-model selector; remote routing is available only in the current root Monitor session with a deterministic `unavailableReason`; a shared model health coordinator and circuit-breaker policy (`model-circuit-breaker`); `model-routing` wires in registration-id resolution and circuit-strategy sync; `registry-host` reads the model-registry mode and projects pair publications with three-state mode switching. New `pi-teammate-models` CLI (list/edit/add) and connection TUI wizards (`connection-forms` / `connection-wizards` reuse cli-edit/cli-add), with `model-mapping-overlay` / `remote-config-pane` / `locale-catalog-model` adaptations.
- **completion-durability delivery (teammate output no longer lost on interrupt/compaction)**: `completion-outbox` (coordinator/file-store/registry/types) persists an outbox + redelivery; `public/v1/completion-durability` registry symbols and provider contract; `runs/execution` + `extension/index` + `extension/teammate-proxy` bind the sub-session, replay `receiveMessageEnd`, and seed `reply_to`/`correlationId` delivery; flow-side `FlowCompletionDurabilityProvider` + `agent-output-capture`/`store` metadata. Multiple follow-up review fixes (crash consistency, backward compatibility + pin semantics, WAL recovery and caller notification, aggregated import paths).
- **briefing assembly**: `runs/briefing.assembleTaskPrompt` lazily inlines `agent://` / `file:` references into subtask prompts; `execution` assembles uniformly before using `params.task`.
- **DSH remote ssh launch mode**: `dsh/driver.composeDshLaunch` supports ssh remote launch, and the local subprocess allowlist adds `SSH_AUTH_SOCK` so ssh children reach the host agent; `DSH_CONFIG_FIELDS` is exported for reuse by the models CLI edit flow, with new `mode`/`host`/`user`/`port` ssh launch-face fields; `resolveBackendConfig` surfaces backend advisory warnings (so useful risk hints are not silently dropped at the resolution boundary).
- **backend-core contract exposure**: `TeammateExecutionMode` adds `model-registry` (teammate first resolves stable model registrations onto the existing v1 backend registry); new `TeammateExecutionTransport` descriptive transport metadata (local-process / acp-direct-ssh / dsh-direct-ssh / remote-worker) for safe exposure in settled results; `ResolveConfigResult` gains an optional `warnings` field carrying advisory risk hints.
- **computer-use / local vision (OCR)**: new computer-use tool — platform abstraction (windows/macos/linux bridge-process), coordinate conversion, artifacts bound, manifest schema and optional notices; local vision `local-vision` provider + `computer-use/vision` module (OCR/detect/worker/image/model-assets), with `tesseract.js` as an optional dependency that returns `{ok:false,hint}` when absent.
- **Browser stealth + attach + visible**: `stealth.ts` injects navigator.webdriver/plugins/chrome/permissions anti-fingerprint patches and the `--disable-blink-features=AutomationControlled` launch flag; `BrowserOpenOptions` adds `visible` and `attachUserProfile`/`userProfileDir` to take over a user's daily browser (preserving login state and a real fingerprint); `browser-tool` exposes `visible`/`app.attach_user_profile`/`app.user_profile_dir` parameters with CAPABILITY MAP notes, clarifying that stealth alone is insufficient to pass Cloudflare managed challenges.
- **abort/cancel semantics fix**: when `stopReason="error"` but the message contains abort wording, the turn is classified as cancelled/non-retryable — it does not consume the circuit breaker or switch models, preventing the system from retrying on another model after the user presses ESC (`model-failover` and `retry-classifier` gain ABORT diagnostic regexes).
- **Routing observability**: `model-routing` adds `unreachableRoutingTargets()` and `formatModelRoutingConfig(..., availableModels)`; task-type/role mappings pointing at models unreachable in the current catalog emit warnings in the routing table; an empty catalog does not warn.
- **Manifest write-time validation**: cli-edit/connection-wizards mirror the add flow's ssh host/user required-field validation; cli-write runs `compileModelRegistryManifest` after parsing to surface topology/selector failures at write time.
- **MCPX dashboard enhancements**: `E` key permanently registers/deregisters a workspace (no lease; survives window close; `e` remains the TTL-lease registration); `collectWindows`/`collectThread` scan all peer workspaces, so under oauth-mode runtime 401 the fallback list still shows windows and tool calls from other workspaces; quick-tunnel process discovery and adopt (the wizard can take over an existing tunnel and validate the port); fixes `sanitizeTerminalText` stripping ESC and degrading color codes to mojibake.
- **Cockpit cross-platform shortcut display**: `Alt` shortcuts display as `Option` on macOS — `key-labels.altLabel()` returns the platform display name, the render state shows Option+X, while the match token stays `alt+X` on all platforms.
- **Flow loop status line + terminal callback**: the loop status line uses status glyphs and relative time, with a new terminal `onTerminal` callback and `loopId` prefix parsing.
- **teammate output bucket writes `.workspace` metadata and supports cwd subtree discovery**; **interrupted tasks no longer stall after compaction** — late zombie completions are replayed to continue, with a unified recovery strategy; **unknown-model failures are retryable by default** + agent-output short-id prefix addressing.
- **plan fixes**: `teammate-send` admits steer/follow_up + planner sub-dispatch boundary clarification.
- **ACP integration completion (PR #18 merge)**: ACP-CLI backend gains catalog/snapshot/registry refresh scripts, with `acp-driver` and `acp-config-options` enhancements; `registry-host` layers a global fallback (workspace-root + global composite key) compatible with the local model-registry mode; `teammate-backends-settings-provider` merges the PR catalog copy with the local deploymentDescriptors document-driven join, fills in the DSH ssh field catalog, and adds the pi-subprocess backend catalog.
- **Docs & specs**: new `packages/pi-maestro-flow/AGENTS.md` package-level coding spec; teammate 2.0.0 release docs (README/CHANGELOG + in-package agents role rewrite + adapter contract adds model-registry); `.pi/agents` role definitions structurally rewritten + `.pi/SYSTEM.md` adds agent-result reuse rules; skills rename `maestro-session-seal` to `maestro-session-manage`; user docs sync for `pi-teammate-models` CLI, DSH ssh, model-registry mode, and macOS Alt/Option; browser-control gap analysis and attach/stealth usage docs; a Windows Git Bash frequent-tool failure-mode tip.

## v0.22.0 (2026-08-20)

> This release ships Flow 0.22.0, Teammate 2.0.0 (breaking), Cockpit 0.17.0, and Settings-Core 0.2.0, plus the first public releases of the contract packages `pi-maestro-backend-core@0.1.0` and `pi-maestro-backends@0.1.0`; engine pin `maestro-flow` 0.5.75 → 0.5.79.

- **Teammate 2.0.0 (breaking major)**: remote journal format `REMOTE_JOURNAL_VERSION` 1 → 2 with **no migration path** — old v1 journals hard-fail on parse and must be deleted/rebuilt; the `RemoteCapability` vocabulary is removed and the protocol bumps to `remote/2`; inline `cli/<tool>` dispatch is removed and routing goes through the backend registry, so third-party adapters must implement the backend contract. New generic ACP-CLI TeammateBackend (facts returned via `outcome.recovery`; `settleAcpRun` observes ACP tool events and carries completed/in-flight counts; ACP handshake timeout is now configurable instead of hardcoded 15s; the failover gate is judged by observed activity). `optionsSource` becomes a usable mechanism, the model namespace is owned by the executor, and `backendOptionsOf` delivers real `host.proxyToolCall`. New pure-contract package `pi-maestro-backend-core` (capability table exhaustive to 12 items; credentials modeled as references, not masked values) + registry routing + Pi subprocess backend adapter + dsh backend (per-run hosted loopback MCP todo endpoint; `outputSchema` host-side compensation upgrades unsupported → emulated). Numerous remote/teammate robustness fixes (subscription established with start, single-dispatch capability adjudication, failed diagnosis no longer rendered twice, etc.). **Upgrade note: old v1 remote journals are unreadable and must be rebuilt; third-party backends must implement the backend contract instead of inline `cli/<tool>` dispatch.**
- **MCPX config wizard & connection monitor**: new `/mcpx` config wizard (README-driven guided setup) with a Cloudflare quick-tunnel step (keeps only the quick tunnel, auto-start, cloud MCP connection preview, surfaces cloudflared exit/timeout cause), dynamic workspace registration with heartbeat lease, and step navigation (Enter advances / Esc back / `c` shortcut to the monitor). New MCPX connection monitor TUI showing MCP servers and client connections with start/stop controls.
- **Dynamic model discovery & in-process failover**: API Manager supports dynamic model discovery (querying a provider for its live model list), **offered only when a saved API key exists**; in-process model failover hot-swaps the model via the `set_model` RPC instead of restarting the run; manually switching a model resets that model's circuit breaker so automatic failover retries it.
- **`/notify` toast toggle**: new `/notify [on|off|error|complete|status]` toggling toast notifications (model error / turn completion); an errored turn suppresses the completion toast so at most one toast per turn; state is persisted.
- **Next-suggest**: after each settled turn a next-step suggestion renders as a widget below the editor; F2 (configurable) fills the editor and any typing dismisses it; configured via API Manager (`/api-manager nextsuggest`), persisted in the `nextSuggest` section of `api-manager.json`.
- **API Manager config import/export + expose teammate CLI tool availability + show blocked knowledge candidates**.
- **`.pi/SYSTEM.md` single-authority migration**: project system instructions come only from `.pi/SYSTEM.md`; the bundled `AGENTS.md` injection is retired — users relying on the old injection must migrate content to `.pi/SYSTEM.md`.
- **Defensive-programming fixes (DEF-001..004)**: corrected false-success reporting (DEF-001/002) and silent-eviction reorder (DEF-003/004), with regression tests added.
- **MCPX dashboard enhancements (task-orchestration Phase 4)**: tunnel health monitoring with anomaly key guidance, one-key tunnel restart (T) with automatic URL sync to config + mcpx restart, OAuth ops-password display + persistence, W-key workspace management sub-mode (list/select/remove any workspace), delegated-task status and result display, mcpx-for-pmf fork detection, auth-mode 401 no longer misread as offline, tunnel URL shown with `/mcp` suffix + client hints, and dashboard client-ification (`mcpx-client.ts`).
- **Prompt enhance**: new prompt-enhancement feature on `Alt+Shift+E` (Ctrl+Shift+E removed to avoid conflict with Pi `app.thinking.cycle`).
- **submit-gate**: new submit-gate extension (pre-submit gate).
- **Usage insights**: statusline usage history, usage chart, and history backfill.
- **Cockpit Todo overlay**: `Alt+Shift+T` Todo overlay; blocked-todo priority demoted; visible cap raised.
- **Browser**: GenericAgent DOM probe, list folding, navigation detection.
- **Hardening waves (odyssey-review)**: lock retries raised to 64 for high-contention trust, unified `serializeMutation` lock, event-bus cleanup + replay cap, usage-history perf + index atomicity, mcpx tunnel/pid/yaml hardening, ops-password masking, backup mode/cap, PID identity verify.
- Other: cockpit batches same-file edits and rejects identical edits atomically; 3 defensive-programming spec candidates promoted.

## v0.21.6 (2026-08-16)

- **Teammate 1.14.0 — Remote workers (`pi-teammate-remote`)**: new `pi-teammate-remote` CLI binary and public `./v1/remote` API surface (worker protocol, config, bridge, journal, adapter contracts under `src/remote/`: ACP driver, Pi RPC driver, SSH transport, child security and process-tree management, worker-manager, remote state). New runtime deps `@agentclientprotocol/sdk@1.3.0`, `jiti@2.7.0`, `ssh2@1.17.0`, `zod@4.4.3` (bundled settings core unchanged). Monitor control window: `MonitorToolExposureController` switches local vs Monitor tool variants with exclusive tools (`workspace-window`, `remote-worker`) without granting cross-window authority before admission; `teammate-list` merges local workspace peers with remote runs; monitor-mode context covers SSH-backed remote supervision. **Ask-before-dispatch gate**: when enabled in the model routing config (`~/.pi/agent/teammate-models.json` → `askBeforeDispatch: true`, toggleable via `/teammate-models`), root dispatches pause for per-task model/thinking/location confirmation before spawning; nested/proxied dispatches never ask. Delivery hardening: monitor interventions carry an in-process `authorize` fence before external publication; `ActiveAgent` gains a resolved `cwd` (local path or `remote:<targetId>`).
- **Flow 0.21.6 — Plan Knowledge Gate + engine sync**: the approved-plan execution contract now opens with the Knowledge Gate, instructing agents to run `maestro search "<1-3 task keywords>"` before project work and `maestro load` every governing hit (search is exposure, load records consumption), then re-search at subsystem/architecture boundaries. Core engine pin synced `maestro-flow@0.5.74 → 0.5.75` (upstream v3 runtime updates; v2 branch untouched).
- **Upgrade notes**: Teammate requires the new runtime deps (`ssh2`, `jiti`, `@agentclientprotocol/sdk`); reinstall (`pi install npm:pi-maestro-teammate@1.14.0` or clean `npm install`) rather than copying an old node_modules. `askBeforeDispatch` defaults to off; enable it in `/teammate-models` (Ctrl+A); contexts without overlay UI support skip the gate instead of failing. `maestro-flow` is exact-pinned, bumped to 0.5.75.
- Install: `pi install npm:pi-maestro-flow@0.21.6`.

## v0.21.5 (2026-08-15)

- Engine pin: `maestro-flow` 0.5.73 → **0.5.74**. 0.5.74 hardens v3: `session migrate --to-v3` accepts running Runs (projected run/3.0 running with the active run bound) and orphaned running/failed steps (projected pending) — migration can no longer deadlock; `knowledge stage` works on session/3.0 (sidecar v3 branch + artifact evidence via the registry); `requireV3Session` derives the CAS fence from the explicit `--session` target; `session unarchive` is a v3 orchestration target; publishPlanV3 replays are idempotent (already-exists is success).
- Pi skills conversion pipeline v3-ified: `sync-pi.mjs --also-pi` regenerated `.pi/skills` (194 files) and `.pi/agents` (35 files) — convert-pi drops all live v2 rewrite rules (no `--platform pi` on run brief/next/complete; `run create` stays as the legal v3 self-start; run prepare/session create/start/done/run start/done/edit/skill rewrites and prepare-asset synthesis removed); v2 residue zeroed in the run-executor agent and skill-iter-tune/maestro-help sources; Pi-native `self-evolve` uses `run complete --advance` / `session complete`.
- Conversion contract tests and prompt audit updated to v3 semantics (convert-pi 33 cases + skill-contract-lint all green); teammate window-inbox/listing refactor included.
- Install: `pi install npm:pi-maestro-flow@0.21.5`.

## v0.21.4 (2026-08-15)

- Engine pin upgrade: `maestro-flow` 0.5.72 → **0.5.73**. 0.5.73 is the canonical v3 convergence release: the default workspace writer is `session/3.0` (six-key capability set, no Execution writes); `run next`/`run create` emit a full birth packet (run_dir/step_id/upstream/guidance/knowledge_context/brief.command/run_already_created; replays return the identical packet); `run brief` returns a `brief-result/3.0` Resume Packet (orchestration_revision + suggest-only next); canonical prompts/gates/mirrors are v3-ified (v2 moved into labeled Legacy branches).
- v3 adapter updates: the Pi execution chain is fully v3 — next/done via the lease-free CAS execV3, run brief consumes the v3 Resume Packet, run complete --advance seals Runs; publishPlan in session-v3 mode opens the Session, persists the plan document (`.workflow/plans/`), inserts the plan chain step and returns a synthetic envelope; extension v3 receipts (session-complete/run-complete-and-seal) drive knowledge review, the Run-sealed pipeline reads the run knowledge-delta; the run-executor role is fully v3 (no session next/done/ralph-meta).
- Real-CLI integration suites migrated to v3 fixtures (all 4 pre-existing v2 baseline failures eliminated); new v3 full-lifecycle case (open→chain→run next→brief→check→complete→decide→session complete).
- Install: `pi install npm:pi-maestro-flow@0.21.4`.

## v0.21.3 (2026-08-15)

- Engine pin upgrade: `maestro-flow` 0.5.71 → **0.5.72**. 0.5.72 carries the cross-repo audit fixes: `run complete` persists knowledge candidates atomically with the receipt (immediately visible to `knowledge review`), `run next` derives the default Run ID deterministically from the request ID (retries replay the original mutation), artifact republish uses the canonical `--expected-orchestration-revision`, transition receipts force `participant_id = actor_id`, ResumeMap drops `identityRevision`/`paused`, resolved/escalated decisions can no longer be bound as new gates, and all 30 release-machine proofs pass.
- v3 adapter updates (8 cross-repo findings): `next/done` delegate to the lease-free CAS `execV3` path, `edit` refuses loudly under v3 and points to `session chain insert|skip|replace`; capability v3 selection is writer-strict (`session_schema_writes` declares `session/3.0`, no execution writes, `run-response/1.2` declared, all v2 features false); execV3 binds the response envelope (operation + request-id); ResumeMap validation is allowlist-strict (unknown keys incl. `identityRevision` rejected); bridge maps `paused`→running explicitly and projects decisions/retry lineage; the v3 operation surface of run-control/run-response is trimmed.
- Install: `pi install npm:pi-maestro-flow@0.21.3`.

## v0.21.2 (2026-08-14)

- Engine pin: `maestro-flow` 0.5.70 → **0.5.71**. 0.5.71 is the v3 simplification release: decision gates (chain step `decision_ref`, unresolved gates block `run next`/`session complete`, escalated gates pass with concerns, `decide escalate` no longer pauses the Session); removed chain-proposal/TC-P0-3 extra inputs/22 retired stubs/resume-map truncation/per-check knowledge reconciliation; dropped the participant entity and command family (`--participant` still accepted), `identity_revision`, `paused`, and the gates system (receipts store `participant_id = actorId`, legacy v3 files stay readable).
- v3 adapter updates: removed participant pre-registration preflight, bridge identity-revision parsing and gates projection, and the `session-pause/resume` operation surface; the six-key capability negotiation is unchanged.

- Engine pin bump: `maestro-flow` 0.5.69 → **0.5.71** (supersedes v0.21.0). 0.5.71 carries run-response/1.1, session/run v3 schemas, and the execution lifecycle, matching the suite's execution-generation session model; the v0.21.0 API Manager `api.models` and Cockpit input-history features are unchanged.
- Install with `pi install npm:pi-maestro-flow@0.21.2`.

## v0.21.0 (2026-08-13)

- API Manager gains `api.models`: a structured model list that reuses each provider's url/key.
- Cockpit's unified editor now owns input history (the Flow `history-editor` is removed): a `historyEnabled` config and settings toggle (on by default, requires /reload) and a history banner inside the fullscreen editor region.
- Claude editor hardening with `unified-editor` and `input-history-store` test coverage plus review-finding fixes.
- Install with `pi install npm:pi-maestro-flow@0.21.0`.

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
