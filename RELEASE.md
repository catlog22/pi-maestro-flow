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
api-manager model-ID rename, core engine `maestro-flow@0.5.67`) with the
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
- **Scholar skills suite (optional)**: `optional/skills/scholar-*` — 10
  optional academic-research skills covering ideation, experiments,
  writing, review/rebuttal, citation verification, anti-AI-writing polish,
  LaTeX organizing, conference publication, and thesis DOCX layout. Skills
  stay out of the default install surface; enable via
  `maestro install toggle --enable <skill>`.
- **Docs**: self-evolve guide pages (zh/en) added to the docs site, landing
  feature card updated, changelog carries the withdrawal record and the
  v0.18.0 entry, and all install commands point at v0.18.0.

The core engine reference stays at **`maestro-flow@0.5.67`** (exact pin,
unchanged from v0.17.0 — verified equal to the latest upstream at preflight).

## Package Versions and Requirements

| Package | v0.16.0 | v0.17.0 (withdrawn) | v0.18.0 |
|---------|---------|---------|---------|
| pi-maestro-flow | 0.16.0 | 0.17.0 | **0.18.0** |
| pi-maestro-teammate | 1.9.0 | 1.10.0 | **1.11.0** |
| pi-cockpit | 0.11.0 | 0.12.0 | **0.13.0** |
| pi-maestro-settings-core | 0.1.1 | 0.1.2 | **0.1.3** |
| maestro-flow | 0.5.65 | 0.5.67 | **0.5.67** |

- Requires Node.js `>=22.19.0`.
- Pi core packages remain optional wildcard peers supplied by the host; the
  release tarballs do not bundle private SDK copies. The dev verification
  baseline stays at `@earendil-works/pi-*@0.83.0`.
- `pi-maestro-flow` pins the core engine `maestro-flow` exactly at `0.5.67`
  (verified `npm view maestro-flow version` = `0.5.67` at preflight — no
  stale pin; see `TIP-20260727-exact-pin-stale-upstream-dep`).
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

## Core Engine Reference — maestro-flow@0.5.67 (unchanged)

Same exact pin as v0.17.0. Carries the run-chain fixes: projections
registered on all session creation paths plus enum-arg validation and
session prune, chain-file step args and explicit topic preserved in chain
start, and `--arg` passed through chain dispatch with failed sessions kept
canonical-reachable.

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
| pi-maestro-settings-core@0.1.3 |  |  |  |  |
| pi-maestro-teammate@1.11.0 |  |  |  |  |
| pi-cockpit@0.13.0 |  |  |  |  |
| pi-maestro-flow@0.18.0 |  |  |  |  |

Publication order is mandatory:

1. Publish and verify `pi-maestro-settings-core@0.1.3`.
2. Publish and verify `pi-maestro-teammate@1.11.0` (pins settings-core 0.1.3).
3. Publish and verify `pi-cockpit@0.13.0` (pins settings-core 0.1.3).
4. Publish and verify `pi-maestro-flow@0.18.0` with exact companion versions
   and `maestro-flow@0.5.67`.
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
