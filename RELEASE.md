# v0.14.2 - Routing, Structured Results, Compaction Recovery, and Safe Upgrades

## Overview

Flow `0.14.2` bundles Teammate `1.7.1` and Cockpit `0.9.1`. This suite
release makes teammate routing and schema results durable, adds persistent
session navigation and optional Advisor supervision, hardens multimodal
compaction and provider failover, and safely migrates Flow-managed companion
registrations.

## Package Versions and Requirements

| Package | v0.14.1 | v0.14.2 |
|---------|---------|---------|
| pi-maestro-flow | 0.14.1 | **0.14.2** |
| pi-maestro-teammate | 1.7.0 | **1.7.1** |
| pi-cockpit | 0.9.0 | **0.9.1** |
| pi-maestro-settings-core | 0.1.0 | 0.1.0 |
| maestro-flow | 0.5.61 | 0.5.61 |

- Requires Node.js `>=22.19.0`.
- Validated with Pi SDK `0.83.0` and `typebox@1.3.7`.
- Pi core packages remain optional wildcard peers supplied by the host; the
  release tarballs do not bundle private SDK copies.
- Smart Search is source-locked to commit `667c465d0f6ea16a423f03c434f94e21505d3595`
  because the npm `0.1.14` artifact and upstream source expose different
  routing/configuration contracts under the same version.
- Smart Search postinstall requires Python `>=3.10`. It remains optional:
  `search` and `fetch` retain fallback providers if installation is omitted,
  while `route` and `research` report that the optional package is unavailable.

## Highlights

### Teammate Routing and Reliability

- Persist per-role model, fallback, and thinking settings, and inherit the
  active main-session model when no explicit task or role mapping wins.
- Rank fallback candidates by circuit health, classify provider failures by
  kind, apply bounded backoff, and fence replay after tool side effects.
- Recover silent child startup exits and harden mailbox routing, fencing,
  cleanup, public v1 registration, and isolated agent-session ownership.
- Refresh the model registry with its receiver intact and coalesce refreshes
  per registry instance.

### Structured Results and Session Navigation

- Return validated schema output in foreground teammate results and expose it
  through `observe` and `watch` detail.
- Persist completed schema output for `agent://<id>/<key-or-index>` reads. The
  old `/json` path prefix is not part of the resource contract.
- Keep `@main` and teammate sessions in Cockpit's persistent session bar;
  switch the viewed session with Left/Right when the composer is empty.
- Remove the legacy `/teammate-session` workflow in favor of the session bar,
  and use `Alt+B` consistently to detach foreground teammates.

### Compaction, Vision, and Recovery

- Preserve image routing, image-aware placeholders, and non-Anthropic thinking
  across compaction.
- Add tool-loop completion handling, spill digest validation, invalid-thinking
  recovery, and safer native/model fallback behavior.
- Persist per-workspace input history with bounded, merge-aware storage.

### Advisor, Supervision, and Settings

- Add optional asynchronous Advisor reviews at agent and tool checkpoints;
  only concerns and blockers are injected into the main session.
- Unify supervision events across Flow, Teammate, and Cockpit.
- Add settings providers for MCP, skills, smart search, failover, and related
  operational configuration surfaces.

### Cockpit Operability

- Prevent per-second and streaming updates from bouncing or clearing the
  visible terminal viewport.
- Add model selection for generated session titles and preserve rule-based
  fallback behavior.
- Harden guarded edit matching and keep teammate content plus the active route
  target visible.
- Color quiet tool names by lifecycle state (`warning`, `success`, `error`).
  Existing `toolPalette` values remain readable for migration but no longer
  select call/result colors.

### Upgrade Safety and Documentation

- Track Flow-managed Teammate and Cockpit registrations in a versioned sidecar.
- Replace proven Flow-owned and legacy nested companion paths while preserving
  readable local development overrides that Flow does not own.
- Preserve string/object settings entries and resource filters during atomic,
  recoverable settings writes.
- Add the React/Vite documentation site and GitHub Pages deployment with
  guides for routing, compaction, Advisor, mailbox, Cockpit, and settings.
- Lock Smart Search to a reproducible HTTPS commit tarball so intent routing,
  research providers, Jina, and Zhipu MCP configuration match the runtime
  command surface.

## Behavior and Upgrade Notes

- Close all running Pi processes before upgrading. The installer updates disk
  settings that an older in-memory SettingsManager could otherwise overwrite.
- Back up Pi's `settings.json` and `pi-maestro-flow-companions.json` before an
  upgrade that changes companion registrations.
- Start Pi again after installation; extension reload alone is not the
  authoritative companion-registration boundary.
- Unspecified teammate models now inherit the main-session model.
- Use Cockpit's session bar instead of `/teammate-session`.
- A reported local Teammate or Cockpit override was intentionally preserved;
  update or remove it explicitly, then restart Pi.

## Install / Upgrade

```bash
# Close running Pi processes first.
pi install npm:pi-maestro-flow@0.14.2
pi list
```

After restarting Pi, verify that Flow, Teammate, and Cockpit are registered at
the versions in the table above before running model-sensitive workflows.

## Release Verification

The release candidate passed the serial root `test:release` gate, including
all changed Flow subsystems, Teammate declarations, Cockpit tests, and both
fresh packed-consumer tests. The enhanced packed consumer also installs and
loads Cockpit without its optional Teammate peer, verifies the source-pinned
Smart Search package, and runs its offline regression command. Packed tests
remain intentionally serial because Flow prepack/postpack share
`packages/pi-maestro-flow/.pi/skills`.

Dry-run tarballs from the verified candidate:

| Package | Files | Packed | Unpacked | SHA-1 |
|---------|------:|-------:|---------:|-------|
| pi-maestro-teammate@1.7.1 | 135 | 332.7 kB | 1.5 MB | `ae6d2ca4f071d505fa2b19dcebd2c3506e149681` |
| pi-cockpit@0.9.1 | 58 | 147.7 kB | 542.3 kB | `ed65e92a99e8ac17c6898d51e5e0f11d5146186b` |
| pi-maestro-flow@0.14.2 | 820 | 1.9 MB | 7.3 MB | `05e88ed93522271984708fdff5bd37d4ff6ede85` |

Publication order is mandatory:

1. Publish and verify `pi-maestro-teammate@1.7.1`.
2. Publish and verify `pi-cockpit@0.9.1`.
3. Publish and verify `pi-maestro-flow@0.14.2` with exact companion versions.
4. Run a fresh temporary-home registry install and Pi runtime smoke test.
5. Create and push `v0.14.2`, then create the GitHub Release.

## Change Statistics

Final candidate compared with `v0.14.1`:

- 40 commits including the release commit
- 323 files changed
- 42,397 insertions and 7,237 deletions
- 3 published packages plus the unchanged settings-core package
