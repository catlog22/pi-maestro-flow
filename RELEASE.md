# v0.14.1 - Durable Settings, Compaction Fixes, and Runtime Hardening

## Overview

This patch release hardens the Flow runtime after v0.14.0. It fixes several
compaction threshold and large-context failure paths, makes settings writes
durable with strict integer budget validation, prevents slow vision assistance
 from hanging for 60 seconds, and tightens lifecycle, subprocess, SSRF, and
 trust-boundary behavior across the plugin. It also ships the latest teammate
 and cockpit packages and updates the external engine pin to `maestro-flow@0.5.61`.

## Package Versions

| Package | v0.14.0 | v0.14.1 |
|---------|---------|---------|
| pi-maestro-flow | 0.14.0 | **0.14.1** |
| pi-maestro-teammate | 1.6.0 | **1.7.0** |
| pi-cockpit | 0.8.0 | **0.9.0** |
| pi-maestro-settings-core | 0.1.0 | 0.1.0 |
| maestro-flow | 0.5.60 | **0.5.61** |

## Highlights

### Compaction and Context Stability

- Fixed four threshold and overflow paths that could leave oversized turns
  uncompressed (`3d5b0e7f`).
- Added a replay regression covering a stuck 272K context window
  (`b52b777c`).
- Added broader compaction settings validation and failure-path coverage.

### Durable Settings

- Added fsync-backed atomic settings writes and strict integer budget
  validation (`826a20a2`).
- Extended settings provider tests for persistence and validation behavior.
- Refreshed generated teammate declarations and package documentation
  (`c886e1bb`).

### Model and Vision Reliability

- Prevented deleted models from being reloaded from stale registry snapshots
  (`2d1a98dc`).
- Added teammate fallback-chain editing and circuit-health visibility in the
  TUI (`acd4249b`).
- Added cockpit title-generation model configuration (`c6c6df84`).
- Fixed slow vision assistance timeout behavior so `describe_image` does not
  remain blocked for 60 seconds (`38fb242a`).

### Security and Lifecycle Hardening

- Hardened project MCP trust gating and resource ownership in the core plugin
  (`d9fac2c0`, `07143dc0`, `cd350533`).
- Hardened markdown-review subprocess handling, including stdin failures,
  process-tree timeout cleanup, path/token sanitization, and narrow preview
  behavior (`64254da9`, `9eb2b60a`, `0dc0adc9`).
- Added the markdown-review multi-select and Markdown/DOCX/PDF export command
  (`8a0e703b`).
- Standardized smart-search synchronization status rendering so it is not
  confused with a checkbox (`0b332f37`).

## Dependency Notes

The published Flow package now uses exact pins for the published workspace
artifacts and external engine:

- `maestro-flow@0.5.61`
- `pi-maestro-teammate@1.7.0`
- `pi-cockpit@0.9.0`
- `pi-maestro-settings-core@0.1.0`

The cockpit peer range `pi-maestro-teammate@^1.6.0` remains compatible with
teammate 1.7.0 under npm semver.

## Statistics

- 19 commits since v0.14.0
- 112 files changed, +13,672 / -1,242 lines
- pi-maestro-flow: 76 files, +12,153 / -1,022 lines
- pi-maestro-teammate: 12 files, +471 / -26 lines
- pi-cockpit: 21 files, +1,029 / -188 lines

## Install / Upgrade

```bash
npm install pi-maestro-flow@0.14.1
```

## Verification

- `pi-maestro-teammate@1.7.0` published before dependent packages.
- `pi-cockpit@0.9.0` published with teammate dev dependency 1.7.0.
- `pi-maestro-flow@0.14.1` lockfile resolves maestro-flow 0.5.61,
  pi-maestro-teammate 1.7.0, and pi-cockpit 0.9.0.
