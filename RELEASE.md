# v0.21.0 — API Manager Model List and Cockpit Unified Editor Input History

## Overview

Flow `0.21.0` bundles Cockpit `0.16.0`, Teammate `1.13.0`, and the unchanged
`pi-maestro-settings-core` `0.1.3`. This release adds the structured `api.models`
list to the API Manager settings page and merges input history into Cockpit's
unified editor: the Flow-side history editor is removed, a `historyEnabled`
config and settings toggle is added (on by default, requires `/reload`), and
the history banner renders inside the fullscreen editor region.

The core engine reference stays at `maestro-flow@0.5.69` by explicit decision:
npm latest and the local upstream source (`D:/maestro2`) have both advanced to
`0.5.70`, but the release baseline and every gate ran against the registry
`0.5.69` install and this release touches no engine APIs. The pin is kept at
the tested version; the bump should be re-evaluated at the next release.

## Highlights

### Flow — API Manager `api.models`

- New structured model list (`api.models`) in the API Manager settings page
  that reuses each provider's url/key.
- Settings page assertions now cover both the Providers and Models groups;
  review findings on the unified editor and `api.models` were addressed.

### Cockpit — Unified Editor Input History

- Flow's `history-editor` is merged into Cockpit's unified editor; the
  Flow-side implementation (`src/tui/history-editor.ts`, 186 lines) and its
  571-line test file are removed.
- New `historyEnabled` config key plus an In-Shell settings toggle ("Input
  history" / "输入历史"): persistent ↑/↓ prompt history owned by the Cockpit
  editor, on by default, effective after `/reload`.
- The history banner renders inside the fullscreen editor region and
  `historyEnabled` is honored inside the installed editor.
- New `unified-editor` and `input-history-store` test suites cover the merged
  behavior.

## Package Versions

| Package | Previous | v0.21.0 closure |
|---------|---------:|----------------:|
| pi-maestro-flow | 0.20.0 | **0.21.0** |
| pi-maestro-teammate | 1.13.0 | **1.13.0** (unchanged) |
| pi-cockpit | 0.15.0 | **0.16.0** |
| pi-maestro-settings-core | 0.1.3 | **0.1.3** (unchanged) |
| maestro-flow | 0.5.69 | **0.5.69** (unchanged; 0.5.70 available) |

- Requires Node.js `>=22.19.0`.
- Pi core packages remain optional wildcard peers supplied by the host.
- Publication order is Cockpit, then Flow — Teammate and Settings-Core have no
  unpublished changes and are not re-published. Flow pins the exact companion
  versions shown above; Cockpit's peer range `^1.6.0` still covers Teammate
  `1.13.0` and is intentionally left unchanged.
- `maestro-flow` pin: registry latest and local upstream are `0.5.70`; the pin
  deliberately stays at `0.5.69` (the tested baseline) — see Overview.

## Install / Upgrade

Close running Pi processes before upgrading, then run:

```bash
pi install npm:pi-maestro-flow@0.21.0
pi list
```

After restart, verify Flow `0.21.0`, Teammate `1.13.0`, Cockpit `0.16.0`, and
Settings-Core `0.1.3`.

## Release Verification

- Serial release gate (`npm run test:release`) passed on the bumped tree:
  Settings-Core typecheck and tests; Teammate typecheck, 1,302-test suite
  (1,300 pass, matching the known stable baseline), build and check
  declarations; Cockpit typecheck and 754-test suite (a single intermittent
  failure on the first full-gate run did not reproduce on the second full
  run, 754/754); Flow typecheck and all 18 release suites including both
  packed-consumer tests. 3,435 tests total, zero failures, exit 0.
- The manifest contract was re-verified after the version bump: all three
  consumers pin `pi-maestro-settings-core` exactly at `0.1.3`; Flow pins
  `pi-cockpit` at the new local `0.16.0` and `pi-maestro-teammate` at
  `1.13.0`; Cockpit's peer range `^1.6.0` still covers Teammate `1.13.0`.
- Teammate and Settings-Core have no commits since their last published
  versions, so neither is re-published in this release.

Dry-run tarballs from the verified candidate:

| Package | Files | Packed | Unpacked | SHA-1 |
|---------|------:|-------:|---------:|-------|
| pi-cockpit@0.16.0 | 87 | 240,649 | 898,464 | `b594e769994e3e1bb21870526a71b733c01cf7b0` |
| pi-maestro-flow@0.21.0 | 635 | 1,836,625 | 7,007,529 | `29f901b6db7b404a7496414697cdb86117a8f49f` |

Publication order is mandatory: publish and verify Cockpit, then Flow (Teammate
and Settings-Core unchanged); registry smoke, tag, and GitHub Release follow.

Fresh isolated `USERPROFILE` + `HOME` registry install passed: Flow `0.21.0`,
Cockpit `0.16.0`, Teammate `1.13.0`, and each consumer's exact Settings-Core
`0.1.3` dependency resolved from the registry (nested under all three
consumers). `pi list` registered `npm:pi-maestro-flow@0.21.0` in the isolated
home, and packaged Skills were materialized under the installed plugin
(`.pi/skills/maestro/SKILL.md` and companions).

## Change Statistics

Candidate compared with `v0.20.0`: 7 commits; 21 files changed; 1,032
insertions and 968 deletions.
