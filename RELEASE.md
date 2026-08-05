# v0.15.0 - Claude-Style Terminal Interactions, In-Composer Wizard, and TUI Hardening

## Overview

Flow `0.15.0` bundles Teammate `1.8.0` and Cockpit `0.10.0`. This suite
release delivers the claude-style terminal interaction set (fullscreen fixed
editor, copy-on-select, crash-safe cleanup), an in-composer ask wizard with
step-completion marks, per-task nesting budgets with schema contract
hardening, knowledge attribution notifications, optional (选装) skills
support, and broad TUI flicker/robustness hardening across all three
packages.

## Package Versions and Requirements

| Package | v0.14.2 | v0.15.0 |
|---------|---------|---------|
| pi-maestro-flow | 0.14.2 | **0.15.0** |
| pi-maestro-teammate | 1.7.1 | **1.8.0** |
| pi-cockpit | 0.9.1 | **0.10.0** |
| pi-maestro-settings-core | 0.1.0 | 0.1.0 |
| maestro-flow | 0.5.61 | **0.5.62** |

- Requires Node.js `>=22.19.0`.
- Validated with Pi SDK `0.83.0` and `typebox@1.3.7`.
- Pi core packages remain optional wildcard peers supplied by the host; the
  release tarballs do not bundle private SDK copies.
- `pi-maestro-settings-core` is unchanged in this release.
- `pi-maestro-flow` pins the core engine `maestro-flow` exactly at `0.5.62`
  (knowledge attribution `record`/`--content-file` and optional-skill toggle
  live in the core engine).

## Highlights

### Cockpit - Claude-Style Terminal Interactions

- Fullscreen fixed editor with application-owned transcript scroll; drag
  selection always works in fullscreen while copy-on-select only gates the
  copy.
- Copy-on-select in the fullscreen transcript with copied char/line count
  notification and flowing (normal text) selection style.
- Double-Escape clears the input via the Cockpit custom editor; Escape-first
  UX plumbed through claude-style interaction settings.
- Crash-safe terminal cleanup: unconditional raw-mode reset, bracketed paste
  and cursor restore, keyboard protocol restore (`?2031l`) on
  SIGTERM/SIGHUP, deterministic alternate-screen seeding, forced full redraw
  on alternate-screen enter/leave, and process-lifetime cleanup so the
  exit-flush always runs. Capability fallback and docs included.
- `pinEditorBottom` stays inert inside fullscreen on live toggles.
- bash-bg, split-pane, and thinking-timer overlays plus the todo store.
- Agent overlay (`Alt+A`) with agent-priority layout; interrupt/steer overlay;
  trimmed agent roster fields.
- Ambient key hooks yield to capturing overlays and focused custom components;
  modal overlays keep `←/→` instead of empty-composer agent cycling; wheel
  captured by bit-mask so modifier-wheel still scrolls the transcript.
- P2 flicker hardening: footer throttle, thinking-fold cache, monitor
  snapshot gate.

### Teammate - Nesting Budgets, Composer, and Reliability

- Per-task nesting budget with schema contract hardening; the per-task
  `maxNestingDepth` override is documented in the dispatch guide.
- Multi-line composer with auto-wrap and cursor navigation.
- Tool heartbeat, cockpit agent commands, and task labels.
- Attach-overlay rework with TUI rendering fixes; smart-search paste flush
  rendering, progress-tree tweaks, and injectable goal-overlay clock.
- Odyssey-review fixes: generalized fence monitor ownership, reclaimed failed
  admission, hardened foreground ownership.
- Stream read error retry; P2 flicker hardening shared with Cockpit.
- Dropped the noisy mailbox authoritative-mode log line.

### Flow - Ask Wizard, Knowledge Attribution, and Skills

- Ask wizard rendered as an in-composer interactive panel (not an overlay):
  navigation-only `←/→`, answered-step `✓` marks in the tab bar, and a
  `已选/未选择` status line; covered by a new ask-sessionbar integration test.
- Knowledge attribution `record`/`stage` commands with run/session
  notifications.
- `maestro-skills` CLI adapter with a per-skill enabled toggle; optional
  (选装) skills support synced with the maestro2 skill cleanup.
- AI review subagent in plan confirmation.
- GUI server/events, statusline, and todo tool hardening.
- Recovery fixes: canonical Session binding when the claim is absent, advisor
  config load guarded against a stale extension context, and fff background
  index-scan runaway guard.
- Release guard: `test:release` now asserts workspace package version drift
  and manifest contract consistency.

## Behavior and Upgrade Notes

- Close all running Pi processes before upgrading. The installer updates disk
  settings that an older in-memory SettingsManager could otherwise overwrite.
- The ask wizard no longer renders as a modal overlay; it is an in-composer
  panel. `Esc` returns to the input, and answered steps are marked `✓` in the
  tab bar while switching with `←/→/Tab`.
- Fullscreen transcript interactions (copy-on-select, double-Esc clear) are
  controlled by the claude-style interaction settings; they are off unless
  enabled.
- Companion registration order remains mandatory: Teammate, then Cockpit,
  then Flow. Verify all three versions after restart.

## Install / Upgrade

```bash
# Close running Pi processes first.
pi install npm:pi-maestro-flow@0.15.0
pi list
```

After restarting Pi, verify that Flow, Teammate, and Cockpit are registered at
the versions in the table above before running model-sensitive workflows.

## Release Verification

The release candidate passed the serial root `test:release` gate, including
all changed Flow subsystems, Teammate declarations, Cockpit tests, and the
packed-consumer tests. Packed tests remain intentionally serial because Flow
prepack/postpack share `packages/pi-maestro-flow/.pi/skills`.

Dry-run tarballs from the verified candidate:

| Package | Files | Packed | Unpacked | SHA-1 |
|---------|------:|-------:|---------:|-------|
| pi-maestro-teammate@1.8.0 | 135 | 335.4 kB | 1.4 MB | `ea51a05649f60cbacd70b4d935e2c4cc84ca525d` |
| pi-cockpit@0.10.0 | 66 | 167.4 kB | 0.6 MB | `d539c09fc59b4fb85fbbdb2ab59df67fdd38837c` |
| pi-maestro-flow@0.15.0 | 502 | 1409.5 kB | 5.3 MB | `3d23e06e52b3f1c006b68704859fabb87ad1897b` |

Publication order is mandatory:

1. Publish and verify `pi-maestro-teammate@1.8.0`.
2. Publish and verify `pi-cockpit@0.10.0`.
3. Publish and verify `pi-maestro-flow@0.15.0` with exact companion versions.
4. Run a fresh temporary-home registry install and Pi runtime smoke test.
5. Create and push `v0.15.0`, then create the GitHub Release.

## Change Statistics

Final candidate compared with `v0.14.2`:

- 56 commits including the release commit
- 829 files changed
- 11,166 insertions and 86,374 deletions
- 3 published packages plus the unchanged settings-core package

Package-level code deltas (excluding docs/skills/tooling):

| Package | Files | Insertions | Deletions |
|---------|------:|-----------:|----------:|
| pi-maestro-teammate | 38 | +2,197 | -228 |
| pi-cockpit | 56 | +3,882 | -176 |
| pi-maestro-flow | 48 | +3,173 | -221 |
