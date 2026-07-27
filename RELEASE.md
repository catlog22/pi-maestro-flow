# v0.6.1 — Companion Auto-Registration, bash_bg Completion Semantics & Cockpit Footer Row

## Overview

A patch release with four focuses. **Installing `pi-maestro-flow` now auto-registers its companion extensions** (`pi-maestro-teammate` and `pi-cockpit`) into Pi's `settings.packages` via a best-effort postinstall step — closing the gap caused by Pi deliberately not scanning transitive dependencies. **`bash_bg` completion semantics are corrected** so foreground/background jobs settle deterministically, completion results are delivered instantly, and the log entry surfaces only when output is actually truncated. **`pi-cockpit` moves the `bash_bg` status onto a dedicated footer row**. The **`maestro-flow` core engine is bumped `0.5.55` → `0.5.57`** to pick up upstream fixes.

`pi-maestro-teammate` is unchanged at `0.6.0` and is not republished.

## Package Versions

| Package | Version | npm |
|---------|---------|-----|
| `pi-maestro-flow` | 0.6.1 | `npm i pi-maestro-flow@0.6.1` |
| `pi-maestro-teammate` | 0.6.0 (unchanged) | `npm i pi-maestro-teammate@0.6.0` |
| `pi-cockpit` | 0.1.1 | `npm i pi-cockpit@0.1.1` |

`pi-maestro-flow@0.6.1` depends on `pi-cockpit@0.1.1`, `pi-maestro-teammate@0.6.0`, and `maestro-flow@0.5.57`.

## Detailed Changes

### 📦 Companion Extension Auto-Registration (install)

Pi only reads the `pi` field of packages explicitly listed in `settings.packages`; it never walks a package's `dependencies` to load dependent extensions. Previously this meant installing `pi-maestro-flow` left `teammate` and `cockpit` unregistered unless added by hand.

- **`scripts/register-companion-packages.mjs`** (new, +106) — a best-effort postinstall step that locates each companion package directory (resolving the package entry point and walking up to the `name`-matched `package.json`, since the exports maps don't expose `./package.json`) and idempotently merges it into `~/.pi/agent/settings.json`'s `packages` array (realpath + case-normalized dedupe, other settings keys preserved).
- **Wired into `postinstall`** after keybinding and workflow setup; a registration hiccup only warns and never fails `npm install`.
- **`pi-cockpit` is now a dependency of `pi-maestro-flow`** (exact pin), so it installs together and is available for registration.
- 8 focused tests (`test/register-companion-packages.test.mjs`), wired into `test:install`.

### 🔧 maestro-flow Core Engine Bump

- **`maestro-flow` 0.5.55 → 0.5.57** — picks up upstream fixes published after v0.6.0. The exact pin is updated in `package.json` and the lockfile so the published artifact carries the current engine rather than a stale one.

### ⏱️ bash_bg Completion Semantics (flow)

- **Correct foreground/background completion semantics** — background jobs that auto-background and foreground jobs that finish inline now settle deterministically (`src/tools/bash-bg.ts`, +165)
- **Instant delivery of completion results** — `bash_bg` completion results are delivered immediately rather than waiting on a later poll (`src/tools/bash-bg.ts`)
- **Log entry only on truncation** — the log-path entry is shown only when output is actually truncated, removing noise for short commands (`src/tui/components.ts`, +10)
- Substantial test coverage for the new semantics (`test/bash-bg.test.ts`, +160)

### 🛰️ Cockpit Footer bash_bg Row (pi-cockpit 0.1.1)

- **`bash_bg` status moved to a dedicated second footer row** so background-job state no longer competes with the primary footer line (`src/footer.ts`, `src/index.ts`, `src/stack-widget.ts`)
- Updated footer / stack-widget / integration-contract tests

## Statistics

- **9 commits** since `v0.6.0`
- **15 files changed**, +586 / −78 lines
- `pi-maestro-flow`: 6 files, +499 / −35
- `pi-cockpit`: 6 files, +54 / −43

## Installation & Upgrade

```bash
# Upgrade from 0.6.0
npm i pi-maestro-flow@0.6.1
```

**Upgrade notes:**

1. Installing `pi-maestro-flow@0.6.1` automatically pulls `pi-cockpit@0.1.1` (now a dependency) and registers both `pi-maestro-teammate` and `pi-cockpit` into `settings.packages` on postinstall — no manual extension setup required.
2. `pi-maestro-teammate` is unchanged; flow `0.6.1` still pins teammate `0.6.0`. The `maestro-flow` engine advances `0.5.55` → `0.5.57`.
3. Registration is best-effort: if it cannot write your Pi settings, the install still succeeds and you can add the packages manually.
