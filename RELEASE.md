# v0.20.0 — Execution-Generation Model, Teammate Output Management, and Cockpit Zen Stack

## Overview

Flow `0.20.0` bundles Teammate `1.13.0`, Cockpit `0.15.0`, and the unchanged
`pi-maestro-settings-core` `0.1.3`. This release lands the execution-generation
session model with run-response/1.1 and v3 capability negotiation, teammate
output data management with capacity rollover, agent:// publication-id
persistence, compaction hardening at hard tool boundaries, the Cockpit zen
stack projection, and the in-flight viewport-stability detach refactor that was
committed as part of this release.

The core engine reference stays at `maestro-flow@0.5.69` — release preflight
verified it matches both npm latest and the local upstream source
(`D:/maestro2`), so no pin change was needed.

## Highlights

### Session Model — Execution Generations and v3 Capability Negotiation

- New execution-generation session model with `run-response/1.1` and a
  statusless projection; session/run architecture analysis and migration docs
  are included (`docs: add session-run architecture analysis`,
  `docs: plan session/execution/run model migration`).
- Session capability negotiation migrated to v3.
- Todo task-result snapshots slimmed to cut context overhead.

### Teammate — Output Management and Dispatch Hardening

- Teammate output data management wired into Flow: capacity accounting with
  oldest-record rollover and graceful fallback for skipped output; unpersisted
  inline results are capped.
- Per-dispatch mode, delegation drafts, publication acknowledgements, and
  observe/retry hardening.
- Multi-agent messaging identity and delivery hardened: expert rules packaged
  with sender identity preserved, replay-neutral child IPC fallback, monitor
  stall/cooldown thresholds now honor configured values, graph wait and queue
  stall separated, delivery routing declarations synced, and lifecycle tests
  moved off fixed waits.

### Flow — agent:// Publication IDs, Compaction, and Tool Activation

- agent:// outputs persist under immutable publication ids; duplicate name
  queries return id/time/preview lists instead of ambiguity.
- Compaction: hard tool boundary blocks and terminates instead of `abort()`,
  output-limit continuation attempts are bounded, and continuation proceeds
  directly below context pressure.
- Deferred tool activation choices survive reload; low-frequency tool schemas
  are deferred for startup performance.
- Browser tool reuses or launches managed Chrome profiles, eliminating the
  EBUSY exit crash; goal verification recovers transient verifier
  module-load failures and surfaces the infra error cause.

### Cockpit — Zen Stack Projection and Viewport Stability

- Zen stack projection added with design prototypes and docs-site pages.
- Expert-mode Leader rows marked with the strategy indicator.
- Viewport-stability patch is now detachable across TUI swaps and released
  cleanly on shutdown (committed as release scope).

### Pi Mirror and Packaged Skills

- Pi mirror deploy tooling (`deploy-pi-mirror.mjs` + tests, `.pi-mirror-managed.json`).
- Packaged skill contracts synchronized (`convert-pi.mjs` / `sync-pi.mjs`):
  the Maestro `--dry-run` interface is stabilized against source drift with a
  generated action block and transition, and the generated package
  `AGENTS.md` is committed with test coverage.

## Package Versions

| Package | Previous | v0.20.0 closure |
|---------|---------:|----------------:|
| pi-maestro-flow | 0.19.0 | **0.20.0** |
| pi-maestro-teammate | 1.12.0 | **1.13.0** |
| pi-cockpit | 0.14.0 | **0.15.0** |
| pi-maestro-settings-core | 0.1.3 | **0.1.3** (unchanged) |
| maestro-flow | 0.5.69 | **0.5.69** (unchanged) |

- Requires Node.js `>=22.19.0`.
- Pi core packages remain optional wildcard peers supplied by the host.
- Publication order is Teammate, Cockpit, then Flow. Flow pins the exact
  companion versions shown above; Cockpit's devDependency on Teammate moves to
  `1.13.0` and its peer range `^1.6.0` still covers `1.13.0` and is
  intentionally left unchanged.

## Install / Upgrade

Close running Pi processes before upgrading, then run:

```bash
pi install npm:pi-maestro-flow@0.20.0
pi list
```

After restart, verify Flow `0.20.0`, Teammate `1.13.0`, Cockpit `0.15.0`, and
Settings-Core `0.1.3`.

## Release Verification

- Serial release gate passed: Settings-Core typecheck/tests and unchanged-tarball
  SHA check (local dry-run shasum equals registry `dist.shasum`); Teammate
  typecheck, 1,302-test suite (one intermittent failure on the first full-gate
  run did not reproduce across two dedicated reruns, both 1,300/1,300), build
  and check declarations; Cockpit typecheck and tests; Flow typecheck and all
  release suites including both packed-consumer tests. The manifest contract
  (three consumers pin `pi-maestro-settings-core` exactly at `0.1.3`; Flow pins
  teammate/cockpit at their local versions) was re-run after the version bump.
- Fresh isolated `USERPROFILE` + `HOME` registry install passed: Flow `0.20.0`,
  Teammate `1.13.0`, Cockpit `0.15.0`, and each consumer's exact
  Settings-Core `0.1.3` dependency resolved from the registry. Fresh Pi RPC
  startup loaded Flow/Teammate/Cockpit and discovered 33 packaged Skills,
  including `skill:maestro`. A prompt-level Skill invocation reached model
  authentication and was blocked only because the deliberately isolated HOME
  contains no API credentials.

Dry-run tarballs from the verified candidate:

| Package | Files | Packed | Unpacked | SHA-1 |
|---------|------:|-------:|---------:|-------|
| pi-maestro-settings-core@0.1.3 (unchanged) | 7 | 5,551 | 20,774 | `e572d7fd284aed7cb9de01342a57f44ac987ee62` |
| pi-maestro-teammate@1.13.0 | 232 | 567,257 | 2,494,207 | `60176cafefd0790ab147f0a928944608719afe54` |
| pi-cockpit@0.15.0 | 86 | 235,911 | 881,497 | `4039a4d40b5074a8e54e60b16d0c3ed3612d2156` |
| pi-maestro-flow@0.20.0 | 637 | 1,840,213 | 7,015,929 | `61fc3429d66afd4265e77ec16d526d33e27294ee` |

Publication order is mandatory: publish and verify Teammate, then Cockpit,
then Flow; registry smoke, tag, and GitHub Release follow.

## Change Statistics

Candidate compared with `v0.19.0`: 38 commits (35 since the v0.19.0 tag plus 3
release-scope WIP-collection commits for the viewport-stability refactor, the
pi-mirror tooling and skill contract sync, and the dry-run/generated-AGENTS
test coverage); 267 files changed; 23,259 insertions and 4,299 deletions.

---
# v0.19.0 — Experts Mode, Managed Monitor Windows, and Dispatch Hardening

## Overview

Flow `0.19.0` bundles Teammate `1.12.0`, Cockpit `0.14.0`, and the unchanged
`pi-maestro-settings-core` `0.1.3`. This release adds an opt-in Experts Mode
policy layer over the existing Teammate and Maestro Session/Run runtime, expands
cross-session monitor/window operations, and hardens dispatch, permission audit,
model-routing, and interrupted-run behavior.

The core engine reference is updated from `maestro-flow@0.5.68` to
`maestro-flow@0.5.69`, matching both npm latest and the local upstream source at
release preflight.

## Highlights

### Experts Mode

- New `/experts on|off|status|roster|config|waiting|harvest` surface with a
  read-only TUI overlay and statusline harvest indicator.
- Stage-aware policies map Maestro stages to typed expert pipelines before the
  existing model router runs; explicit task models retain precedence.
- Configurable per-role model, channel, thinking, fallback, and skill profiles
  through `.experts-rules.json`.
- Leader hard-gate redirects business-file writes and heavy shell work to
  teammates while allowing child experts to execute their assigned work.
- Durable waiting, in-flight, stage, and knowledge-suggestion state with
  settle-time knowledge harvesting. Harvesting is suggestion-only by default;
  automatic staging remains opt-in.
- New packaged `experts` skill and taskType-aware team skill templates.

### Teammate and Monitor Runtime

- Managed monitor windows, workspace inbox views, cross-window delivery
  reminders, and authenticated owner reconciliation.
- Browser tool exposure to child agents through a dedicated broker.
- Permission audit and tool-preview contracts shared across extension and run
  execution paths.
- Model-routing precedence is preserved when callers explicitly select a model.
- Improved graph settle, retry, progress, waiting, and structured-output state.

### Flow and Cockpit

- Flow exposes child-safe tools and supports top-level skill discovery in
  run-control paths.
- Interrupted compaction continuations are preserved rather than silently lost.
- Cockpit agent bar, overlay, session detail, and agents store now present the
  expanded monitor/window state and localized controls.

## Package Versions

| Package | Previous | v0.19.0 closure |
|---------|---------:|----------------:|
| pi-maestro-flow | 0.18.0 | **0.19.0** |
| pi-maestro-teammate | 1.11.0 | **1.12.0** |
| pi-cockpit | 0.13.0 | **0.14.0** |
| pi-maestro-settings-core | 0.1.3 | **0.1.3** (unchanged) |
| maestro-flow | 0.5.68 | **0.5.69** |

- Requires Node.js `>=22.19.0`.
- Pi core packages remain optional wildcard peers supplied by the host.
- Publication order is Teammate, Cockpit, then Flow. Flow pins the exact
  companion versions shown above.

## Install / Upgrade

Close running Pi processes before upgrading, then run:

```bash
pi install npm:pi-maestro-flow@0.19.0
pi list
```

After restart, verify Flow `0.19.0`, Teammate `1.12.0`, Cockpit `0.14.0`, and
Settings-Core `0.1.3`. Experts Mode remains off until explicitly enabled with
`/experts on`.

## Release Verification

- Serial release gate passed: Settings-Core typecheck/tests and unchanged-tarball
  SHA check; Teammate typecheck, 1,326-test suite, declarations and declaration
  contract; Cockpit typecheck and 687 tests; Flow typecheck and all release
  suites, including both real packed-consumer tests.
- The four stale contract assertions exposed by the merge were corrected and
  rerun as focused files; the adapter's missing `expertsCaller` public type was
  fixed before Flow typecheck passed.
- Fresh isolated `USERPROFILE` + `HOME` registry install passed: package/companion versions, RPC Skill discovery,
  and a real `/skill:experts status --dry-run` invocation all succeeded without changing mode or workflow state.

Dry-run tarballs from the verified candidate:

| Package | Files | Packed | Unpacked | SHA-1 |
|---------|------:|-------:|---------:|-------|
| pi-maestro-settings-core@0.1.3 (unchanged) | 7 | 5,551 | 20,774 | `e572d7fd284aed7cb9de01342a57f44ac987ee62` |
| pi-maestro-teammate@1.12.0 | 230 | 540,473 | 2,375,962 | `3d1262a7fddbf26e9d885b81e99ebcca82f17b71` |
| pi-cockpit@0.14.0 | 82 | 221,972 | 823,010 | `a6c3c1915f174477608677be0d6443a168f2a272` |
| pi-maestro-flow@0.19.0 | 603 | 1,773,465 | 6,644,998 | `0c9e3e715733dfa3798aa2d9c65909a1fe336a4a` |

## Change Statistics

Candidate compared with `v0.18.0`: 15 commits including release verification; 137 files changed;
13,752 insertions and 360 deletions across Teammate, Cockpit, Flow, docs, and skills.

---

# v0.18.0 — Packaged Skill Discovery Fix, Teammate Cross-Session Delivery Hardening, and Scholar Skills Suite

**supersedes v0.17.0 (withdrawn).** v0.17.0 was published and then withdrawn
because fresh npm installs started with no Skills available in Pi. v0.18.0 is
the fixed release: it restores packaged Pi resources so Skills are discovered
and invocable after a clean install (see the Withdrawal Notice below for the
incident record), and it carries the teammate cross-session delivery
hardening and documentation updates prepared on top of the v0.17.1
packaging-fix commit.

## Withdrawal Notice (2026-08-09) — v0.17.0 Historical Record

**Do not install v0.17.0.** After publication, fresh npm installs were reported to
start with no Skills available in Pi. The release was removed from every npm
`latest` tag and the complete v0.17.0 package closure was deprecated:

| Package | Withdrawn version | Restored `latest` |
|---------|------------------:|------------------:|
| pi-maestro-flow | 0.17.0 | **0.16.0** |
| pi-maestro-teammate | 1.10.0 | **1.9.0** |
| pi-cockpit | 0.12.0 | **0.11.0** |
| pi-maestro-settings-core | 0.1.2 | **0.1.1** |

A physical `npm unpublish` of Flow 0.17.0 was attempted but rejected by npm:
the current granular token cannot perform destructive unpublish operations
under npm's 2FA policy. The versions remain available for audit, but all four
are deprecated and are no longer selected by `latest`.

Registry tarball inspection found 194 Skill entries in both Flow 0.16.0 and
0.17.0, so the incident is not a simple missing-file tarball. The
install/registration/discovery path is fixed in v0.18.0: packaged Pi
resources are restored (see `prepare-package-skills.mjs`,
`src/resources/maestro-package.ts`, and the new
`test/package-resources-runtime.test.ts` / `test/package-resources.test.mjs`
coverage in the v0.17.1 commit) and the release gate now requires a genuinely
isolated `USERPROFILE` + `HOME` fresh install with a runtime Skill listing
and at least one installed Skill invocation.

Users who installed v0.17.0 should close all Pi processes and downgrade
directly without running `pi remove`:

```bash
pi install npm:pi-maestro-flow@0.18.0
pi list
```

`pi remove npm:pi-maestro-flow` can remove the shared npm dependency tree and
leave absolute Cockpit/Teammate registrations pointing to missing paths.

## Overview

Flow `0.18.0` bundles Teammate `1.11.0`, Cockpit `0.13.0`, and
`pi-maestro-settings-core` `0.1.3`. This is the fixed successor of the
withdrawn v0.17.0: it re-introduces the v0.17.0 feature set (cross-session
scheduler with durable monitor supervision, teammate dispatch hardening,
shared TUI locale, self-evolve auto-deposit Phase 2B, run-loop fixes,
api-manager model-ID rename, core engine `maestro-flow@0.5.68`) with the
packaged-resource restoration fix, plus:

- **Packaged Pi resources restored**: the v0.17.1 packaging fix
  (`prepare-package-skills.mjs`, `maestro-package.ts`, skill-loader /
  skill-manager / skill-runtime wiring) is included, with new runtime tests
  that assert packaged resources survive `pi install` and are discoverable.
- **Teammate cross-session delivery hardening**: WindowThread delivery
  journal with explicit queued/injected/accepted/rejected/timeout state
  machine; workspace-peer message metadata (`source`, `messageKind`,
  `traceId`, `replyTo`, `fromSessionName`); incoming root-queue replay after
  reload so queued peer messages are re-delivered instead of dropped; monitor
  intervention delivery acknowledgements with retry and stale detection;
  cross-session abort explicitly rejected with a clear error.
- **Teammate Monitor loop supervision**: Monitor mode context rewritten as
  agent-operated supervision guidance — one bounded prompt loop for the
  complete target set, never one loop per session and never a shell loop;
  the extension tracks active prompt loops via `loop:update` and warns on
  Monitor exit when monitoring loops keep running (`loop list` / `loop
  cancel` to stop); `MonitorRuntime` is marked deprecated as a legacy
  compatibility runtime for target-bound `/monitor` commands.
- **Flow companion registration extension enablement**: managed companion
  entries with an empty `extensions` array are registered with extensions
  enabled (`enableManagedCompanionExtensions` in
  `register-companion-packages.mjs`), with new test coverage.
- **Scholar skills suite (optional)**: `optional/skills/scholar-*` — 10
  optional academic-research skills covering ideation, experiments,
  writing, review/rebuttal, citation verification, anti-AI-writing polish,
  LaTeX organizing, conference publication, and thesis DOCX layout. Skills
  stay out of the default install surface; enable via
  `maestro install toggle --enable <skill>`.
- **Docs**: self-evolve guide pages (zh/en) added to the docs site, landing
  feature card updated, changelog carries the withdrawal record and the
  v0.18.0 entry, and all install commands point at v0.18.0.

The core engine reference is bumped to **`maestro-flow@0.5.68`** (exact
pin, up from v0.17.0's 0.5.67 — user decision at preflight: 0.5.68 was
released after the v0.17.0 preflight; the local `maestro2` source is already
at 0.5.68).

## Package Versions and Requirements

| Package | v0.16.0 | v0.17.0 (withdrawn) | v0.18.0 |
|---------|---------|---------|---------|
| pi-maestro-flow | 0.16.0 | 0.17.0 | **0.18.0** |
| pi-maestro-teammate | 1.9.0 | 1.10.0 | **1.11.0** |
| pi-cockpit | 0.11.0 | 0.12.0 | **0.13.0** |
| pi-maestro-settings-core | 0.1.1 | 0.1.2 | **0.1.3** |
| maestro-flow | 0.5.65 | 0.5.67 | **0.5.68** |

- Requires Node.js `>=22.19.0`.
- Pi core packages remain optional wildcard peers supplied by the host; the
  release tarballs do not bundle private SDK copies. The dev verification
  baseline stays at `@earendil-works/pi-*@0.83.0`.
- `pi-maestro-flow` pins the core engine `maestro-flow` exactly at `0.5.68`
  (bumped from 0.5.67 per preflight decision — upstream 0.5.68 released
  2026-08-09; see `TIP-20260727-exact-pin-stale-upstream-dep`).
- Exact workspace pins are bumped together with the closure: settings-core
  `0.1.2` → `0.1.3` (un-deprecates the pin after the withdrawal) in
  Teammate, Cockpit, and Flow; teammate `1.10.1` → `1.11.0` and cockpit
  `0.12.1` → `0.13.0` in Flow; cockpit's devDependency on teammate moves to
  `1.11.0`. Cockpit's peer range `^1.6.0` for Teammate still covers `1.11.0`
  (1.x caret semantics) and is intentionally left unchanged.

## Highlights

### Flow - Packaged Skill Discovery Fix (v0.17.1 restored)

- `scripts/prepare-package-skills.mjs` and `src/resources/maestro-package.ts`
  restored so packaged Pi resources (Skills, agents, catalog entries) are
  materialized into the installed plugin directory after `pi install`.
- Skill loader/manager/runtime wiring hardened; new tests:
  `test/package-resources-runtime.test.ts` (runtime resource discovery),
  `test/package-resources.test.mjs` (tarball content), and
  `test/prepare-package-skills.test.mjs`.
- The release gate now includes a fresh isolated install smoke with runtime
  Skill listing and one Skill invocation (see Release Verification).

### Teammate - Cross-Session Delivery Hardening

- WindowThread delivery journal: incoming/outgoing messages transition
  through `queued → injected → accepted/rejected/timeout` with idempotent
  re-delivery; persisted thread entries survive reload.
- Workspace-peer messages carry `source` (user/monitor/system),
  `messageKind` (message/supervision), `traceId`, `replyTo`, and
  `fromSessionName`; formatted root-message rendering
  (`formatWorkspaceRemoteRootMessage`) for delivery into the main session.
- Incoming root-queue replay (`shouldReplayWorkspaceRootQueue`): queued peer
  messages addressed to the workspace main session are re-delivered after an
  extension reload instead of being lost.
- Monitor interventions: delivery acknowledgement with retry and stale
  detection (`InterventionDeliveryAck`, `sendInterventionWithRetry`).
- Cross-session `abort` requests are explicitly rejected with a clear error
  instead of being silently ignored.
- New/updated tests: session-core, workspace-peers, monitor-runtime,
  monitor-supervision, session-mode.

### Settings-Core - Re-release 0.1.3 (un-deprecate)

- No code changes since the withdrawn 0.1.2; version bump only to remove the
  deprecated marker so the closure installs cleanly.

### Scholar Skills Suite (optional)

- `optional/skills/scholar-*`: 10 optional academic-research skills —
  `scholar-ideation`, `scholar-experiment`, `scholar-writing`,
  `scholar-review`, `scholar-rebuttal-pro`, `scholar-citation-verify`,
  `scholar-anti-ai-writing`, `scholar-latex-organizer`, `scholar-publish`,
  `scholar-thesis-docx`.
- Not part of the default install surface; listed by
  `maestro install toggle --list` as `available`, enabled with
  `maestro install toggle --enable scholar-writing,scholar-review`.
- Full suite description in `optional/skills/README.md`.

### Docs

- New self-evolve guide pages (`docs-site/.../guides/self-evolve.md` +
  `.en.md`) with landing feature card and static loader registration.
- Changelog: withdrawal record for v0.17.0 plus the v0.18.0 entry.
- All install commands in README/GUIDE/USAGE/docs-site updated to v0.18.0.

## Core Engine Reference — maestro-flow@0.5.68 (bumped from 0.5.67)

Carries the v0.5.67 run-chain fixes (projections registered on all session
creation paths plus enum-arg validation and session prune, chain-file step
args and explicit topic preserved in chain start, and `--arg` passed
through chain dispatch with failed sessions kept canonical-reachable) plus
the v0.5.68 Run-completion path fixes: `--evidence` / `--artifact` /
`--chain-proposal` relative paths resolve with an explicit Run-directory
base and CWD fallback (error messages include the resolved absolute path,
the Run base, and repair guidance), a Windows cross-drive containment
bypass is fixed (`path.relative()` across drives returned an absolute path
instead of `..`, defeating the old `outputs/` containment check), and
skill-layer verification docs align with evidence-reuse discipline.

## Behavior and Upgrade Notes

- Close all running Pi processes before upgrading. The installer updates
  disk settings that an older in-memory SettingsManager could otherwise
  overwrite.
- v0.17.0 users: downgrade/upgrade path is the same command —
  `pi install npm:pi-maestro-flow@0.18.0` installs the fixed closure.
- Companion registration order remains mandatory: Teammate, then Cockpit,
  then Flow. Verify all three versions after restart.
- TUI language follows the shared in-shell locale (unchanged from v0.17.0).
- Repo-level: pipeline output lives in `.pi-sync` (affects repository layout
  only, not package content).

## Install / Upgrade

```bash
# Close running Pi processes first.
pi install npm:pi-maestro-flow@0.18.0
pi list
```

After restarting Pi, verify Flow `0.18.0`, Teammate `1.11.0`, Cockpit
`0.13.0`, and Settings-Core `0.1.3`, and confirm Skills are listed before
running model-sensitive workflows.

## Release Verification

- Serial root `test:release` gate passed: settings-core typecheck/test,
  workspace version-drift and manifest-contract assertions (three consumers
  pin `pi-maestro-settings-core` exactly at `0.1.3`), all changed Flow
  subsystems (packaged resources, conversion, todo, compaction, settings,
  gui, hooks, permissions, providers, mcp, goal, bash-bg, plan, session,
  swarm, intelligence, packed consumers), Teammate declarations and tests,
  and Cockpit tests. Packed tests remain intentionally serial because Flow
  prepack/postpack share `packages/pi-maestro-flow/.pi/skills`.
- Fresh isolated smoke (mandatory gate after the withdrawal): isolated
  `USERPROFILE` + `HOME` install of the published closure, `pi list`
  version assertion, runtime Skill listing, and at least one installed
  Skill invocation. (Result recorded in the release notes for the final
  tag.)
- Dry-run tarballs from the verified candidate:

| Package | Files | Packed | Unpacked | SHA-1 |
|---------|------:|-------:|---------:|-------|
| pi-maestro-settings-core@0.1.3 | 7 | 5,551 | 20,774 | `e572d7fd284aed7cb9de01342a57f44ac987ee62` |
| pi-maestro-teammate@1.11.0 | 178 | 458,423 | 2,080,238 | `f8c7b9ae6feb5848423535e9a0a55b1919f95d63` |
| pi-cockpit@0.13.0 | 82 | 218,611 | 810,488 | `03ece98a01edae47f94c31bc4ec9341e149f25fe` |
| pi-maestro-flow@0.18.0 | 600 | 1,764,219 | 6,615,356 | `ea723dff296f6f56b9a48b3903c5355c02d986e8` |

Publication order is mandatory:

1. Publish and verify `pi-maestro-settings-core@0.1.3`.
2. Publish and verify `pi-maestro-teammate@1.11.0` (pins settings-core 0.1.3).
3. Publish and verify `pi-cockpit@0.13.0` (pins settings-core 0.1.3).
4. Publish and verify `pi-maestro-flow@0.18.0` with exact companion versions
   and `maestro-flow@0.5.68`.
5. Run the fresh isolated registry install + RPC + Skill discovery smoke.
6. Create and push `v0.18.0`, then create the GitHub Release.

## Change Statistics

Candidate compared with `v0.17.0` (4 commits since the v0.17.0 tag plus the
WIP-collection commit and the release commit):

- 69 files changed
- 3,113 insertions and 229 deletions
- 4 published packages (settings-core, teammate, cockpit, flow)

Package-level code deltas (excluding repo-level docs and knowledge):

| Package | Files | Insertions | Deletions |
|---------|------:|-----------:|----------:|
| pi-maestro-settings-core | 1 | +1 | -1 |
| pi-maestro-teammate | 18 | +906 | -109 |
| pi-cockpit | 1 | +3 | -3 |
| pi-maestro-flow | 16 | +343 | -55 |
