# v0.14.2 - Companion Upgrade Safety and Model Registry Refresh Fix

## Overview

This patch release supersedes `v0.14.1` for installations that use model
routing. It fixes a receiver-loss crash in Teammate's model-registry refresh,
adds safe migration for Flow-managed companion registrations, and aligns the
suite's development and release verification baseline with Pi `0.83.0`.

## Package Versions

| Package | v0.14.1 | v0.14.2 |
|---------|---------|---------|
| pi-maestro-flow | 0.14.1 | **0.14.2** |
| pi-maestro-teammate | 1.7.0 | **1.7.1** |
| pi-cockpit | 0.9.0 | **0.9.1** |
| pi-maestro-settings-core | 0.1.0 | 0.1.0 |
| maestro-flow | 0.5.61 | 0.5.61 |

## Important Fixes

### Model Registry Reliability

- `refreshModelRegistry()` now invokes `ModelRegistry.refresh()` through its
  registry object, preserving the host method's `this.runtime` receiver.
- In-flight refreshes are coalesced per registry instance rather than across
  unrelated extension runtimes.
- Direct teammate dispatch refreshes the catalog before it builds child model
  capabilities, with receiver-dependent regression coverage.

### Upgrade-safe Companion Registration

- Flow records the Teammate and Cockpit sources it manages in a versioned
  sidecar beside Pi settings.
- Upgrades replace a source owned by Flow, including legacy direct dependency paths
  at `<old-flow>/node_modules/<companion>`.
- Same-name local development registrations without Flow ownership evidence are
  intentionally retained and reported instead of silently overwritten.
- `settings.packages` entries retain their original string/object shape and
  resource configuration during migration.
- Registration writes use an fsynced temporary file and rename; a failed
  sidecar write is recovered on the next registration pass.

### Compatibility and Release Checks

- Flow, Teammate, and Cockpit now develop and test against Pi SDK `0.83.0`.
- Host SDK peers remain optional wildcard peers. This release is validated with
  Pi `0.83.0`; it does not claim an untested upper compatibility bound.
- The root `test:release` command runs type, declaration, package, provider,
  permission, packed-consumer, and packed-todo release gates.

## Install / Upgrade

```bash
pi install npm:pi-maestro-flow@0.14.2
pi list
```

Restart Pi or reload extensions before retrying model-sensitive actions.

If startup reports a preserved local Teammate or Cockpit override, that source
was not proven to be Flow-managed. Update or remove the local override
explicitly; the installer will not replace it automatically.

## Release Verification

1. Run `npm run test:release` and `npm publish --dry-run` for each package.
2. Publish `pi-maestro-teammate@1.7.1`, then verify that exact version through
   the registry.
3. Publish `pi-cockpit@0.9.1`, then verify that exact version through the
   registry.
4. Publish `pi-maestro-flow@0.14.2` and verify its published dependencies are
   exactly `pi-maestro-teammate@1.7.1` and `pi-cockpit@0.9.1`.
5. Tag the release only after a fresh temporary-home `pi install` smoke test
   succeeds.
