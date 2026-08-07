# v0.16.0 - In-Shell Settings Suite, Self-Evolve M1-M5, and Core Engine 0.5.65

## Overview

Flow `0.16.0` bundles Teammate `1.9.0`, Cockpit `0.11.0`, and the first
`pi-maestro-settings-core` bump (`0.1.1`). This suite release delivers the
complete in-shell settings experience (API manager, hooks, theme, provider
navigation — no legacy picker jumps), the self-evolve automation layer
(M1-M5 deliverables plus parallel-session runtime/TUI work), session-level
knowledge governance with window transcript evidence staging, compaction
critical-pressure hardening, and teammate todo-bound dispatch.

The core engine reference is updated from `maestro-flow@0.5.62` to
**`maestro-flow@0.5.65`** (exact pin). The engine bump carries the sharp
runtime chain security fix (GHSA-f88m-g3jw-g9cj / CVE-2026-33327,
CVE-2026-33328, CVE-2026-35590, CVE-2026-35591), three prompt quality gates
(Staging Quality Bar, frontmatter quality gate, Review Presentation
Protocol), session-level knowledge governance, and the K12-K17 window
transcript evidence flow.

## Package Versions and Requirements

| Package | v0.15.0 | v0.16.0 |
|---------|---------|---------|
| pi-maestro-flow | 0.15.0 | **0.16.0** |
| pi-maestro-teammate | 1.8.0 | **1.9.0** |
| pi-cockpit | 0.10.0 | **0.11.0** |
| pi-maestro-settings-core | 0.1.0 | **0.1.1** |
| maestro-flow | 0.5.62 | **0.5.65** |

- Requires Node.js `>=22.19.0`.
- Pi core packages remain optional wildcard peers supplied by the host; the
  release tarballs do not bundle private SDK copies.
- `pi-maestro-flow` pins the core engine `maestro-flow` exactly at `0.5.65`.
  Exact pins do not auto-follow upstream: the 0.5.62 → 0.5.65 bump is an
  explicit preflight decision (see `TIP-20260727-exact-pin-stale-upstream-dep`).
- Exact workspace pins were bumped together with the closure
  (settings-core `0.1.0` → `0.1.1` in Teammate, Cockpit, and Flow).

## Highlights

### Settings-Core - In-Shell Action Results

- `provider.ts` exposes action-result rendering and the permission overview
  so settings actions render their output in-shell instead of jumping to a
  native picker.

### Teammate - Todo-Bound Dispatch, Evidence Records, and Failover Hardening

- Todo binding in teammate dispatch: dispatched agents take ownership of
  bound todo tasks, auto-activate the first runnable one, and advance the
  injected queue themselves.
- `agent://` records the final answer text of tasks without an outputSchema.
- Thinking depth is no longer restricted for teammates — all levels are
  selectable and passed through.
- Packaged agents are discovered globally; structured output schemas
  hardened with precise task-prompt offset diagnostics and outputSchema type
  validation.
- Steer control-plane failures no longer masquerade as task failures
  (unconfirmed/rejected abort degrades to a queued follow-up).
- Model failover: `stream_read_error` rewritten as a native retry marker —
  transient stream drops retry the same model first, then switch.
- Unified prompt-cache policy with tiered cache levels in the API manager;
  teammate roles catalog now rendered in-shell.

### Cockpit - In-Shell Settings Suite and Terminal Interaction Fixes

- Full in-shell settings suite: `pi-native` provider (Pi's own settings.json
  in maestro-settings), theme as an in-shell enum, provider-level navigation
  with settings inside, two-level group navigation with adaptive-height
  overlay, and vertical-list/per-setting popup layout.
- Config/footer/settings UI updates and focused-session Agent roster
  collapsed to a single-line summary (detail reuse frees row height).
- Cost-rate backfill for custom API channels with footer/cockpit updates.
- Mouse/wheel fixes: legacy urxvt wheel buttons 4/5 treated as scroll,
  legacy X10 mouse events captured so the wheel never escapes to native
  scrollback, and the editor is no longer misreported as foreign after
  resume/reload.
- Dynamic visible rows scale to terminal height; compatibility with Pi
  `0.84` dynamic TUI references.

### Flow - Self-Evolve M1-M5, Knowledge Governance, and Compaction Hardening

- Self-evolve automation layer: M1-M5 deliverables (skill thin router,
  Phase 2A/2B extension, Phase 3 health sidecar, Phase 5 proposal/canary),
  parallel-session runtime/extension/TUI overlay work, and the
  multi-agent review-gap fixes (review gate / noise filter / executable
  templates / governance scripts / docs).
- Knowledge governance: plugin integration for session-level knowledge
  governance and window transcript evidence staging (engine 0.5.65 provides
  the transcript evidence snapshots and the K12-K17 harvest flow).
- Compaction hardening: critical-pressure abort→settle inside tool loops,
  transient-error retry for summary calls, circuit-breaker downgrade on
  gateway faults, output-truncation recovery no longer gated by context
  pressure, and mid-turn zombie-lease fix.
- Plan AI-review UX: progress overlay with Esc cancel and persistent
  report/plan key hints.
- Goal auto-resume when a Goal was paused by a compaction-preempted
  interruption.
- In-shell configuration: full API Manager configuration, hooks aggregating
  provider (`.pi/hooks.json`), explore provider, failover chains as list-CRUD,
  and a vision-delegation provider with native web-search keys.
- Provider cost-rate backfill for custom API channels with missing-config
  guard and api-aware catalog lookup.
- Plugin adapter session-source unbind + prompt sync for promote inline
  adjudication.

## Core Engine Update - maestro-flow 0.5.62 → 0.5.65

- **0.5.63 (security)**: removes the vulnerable `sharp@0.34.5` runtime chain
  (GHSA-f88m-g3jw-g9cj; resolves CVE-2026-33327, CVE-2026-33328,
  CVE-2026-35590, CVE-2026-35591). Maestro vendors the unmodified
  `@huggingface/transformers@3.8.1` runtime and constrains `sharp` to `^0.35.3`.
- **0.5.64 (governance + UX)**: session/run lifecycle ergonomics (8 friction
  points), dual-model knowledge-flow walkthrough fixes (8 friction points),
  three prompt quality gates (Staging Quality Bar, frontmatter quality gate,
  Review Presentation Protocol), session-level knowledge governance, promote
  inline adjudication, and knowledge-graph code-relation/FTS integrity fixes.
- **0.5.65 (evidence)**: transcript evidence snapshots for promotion
  decisions plus the run-mode/harvest K12-K17 window evidence flow, giving
  knowledge promotion auditable raw transcript backing.

## Behavior and Upgrade Notes

- Close all running Pi processes before upgrading. The installer updates
  disk settings that an older in-memory SettingsManager could otherwise
  overwrite.
- Settings are now configured fully in-shell: API manager, hooks, theme,
  failover chains, and the explore provider no longer jump to native pickers.
  Legacy jump actions were removed.
- Companion registration order remains mandatory: Teammate, then Cockpit,
  then Flow. Verify all three versions after restart.
- The core engine is pinned exactly at `0.5.65`; the engine bump is
  deliberate and includes security fixes — do not downgrade below `0.5.63`
  (sharp chain vulnerability).

## Install / Upgrade

```bash
# Close running Pi processes first.
pi install npm:pi-maestro-flow@0.16.0
pi list
```

After restarting Pi, verify that Flow, Teammate, and Cockpit are registered at
the versions in the table above before running model-sensitive workflows.

## Release Verification

The release candidate passed the serial root `test:release` gate, including
settings-core typecheck/test, workspace version-drift and manifest-contract
assertions (three consumers pin `pi-maestro-settings-core` exactly at
`0.1.1`), all changed Flow subsystems, Teammate declarations, Cockpit tests,
and the packed-consumer tests. Packed tests remain intentionally serial
because Flow prepack/postpack share `packages/pi-maestro-flow/.pi/skills`.

Dry-run tarballs from the verified candidate:

| Package | Files | Packed | Unpacked | SHA-1 |
|---------|------:|-------:|---------:|-------|
| pi-maestro-settings-core@0.1.1 | 7 | 5.1 kB | 0.0 MB | `9953fa821c569e3081b722513cc53dd89be66fda` |
| pi-maestro-teammate@1.9.0 | 142 | 347.3 kB | 1.5 MB | `ca0bd3cb162cae7a8365bf9327e88295fc106af6` |
| pi-cockpit@0.11.0 | 75 | 187.2 kB | 0.7 MB | `9e5f6fffd1a3528aec5c35736e8a2a5edba430fc` |
| pi-maestro-flow@0.16.0 | 518 | 1508.6 kB | 5.7 MB | `f28dff144fd406ef13091a184483027348f19583` |

Publication order is mandatory:

1. Publish and verify `pi-maestro-settings-core@0.1.1`.
2. Publish and verify `pi-maestro-teammate@1.9.0` (pins settings-core 0.1.1).
3. Publish and verify `pi-cockpit@0.11.0` (pins settings-core 0.1.1).
4. Publish and verify `pi-maestro-flow@0.16.0` with exact companion versions
   and `maestro-flow@0.5.65`.
5. Run a fresh temporary-home registry install and Pi runtime smoke test.
6. Create and push `v0.16.0`, then create the GitHub Release.

## Change Statistics

Final candidate compared with `v0.15.0`:

- 72 commits including the release commit
- 213 files changed
- 21,952 insertions and 1,707 deletions
- 4 published packages (settings-core, teammate, cockpit, flow)

Package-level code deltas (excluding docs/skills/tooling):

| Package | Files | Insertions | Deletions |
|---------|------:|-----------:|----------:|
| pi-maestro-settings-core | 1 | +6 | -0 |
| pi-maestro-teammate | 42 | +1,603 | -327 |
| pi-cockpit | 41 | +2,403 | -426 |
| pi-maestro-flow | 66 | +10,961 | -635 |
