# v0.21.1 — Engine Sync to maestro-flow 0.5.70 (supersedes v0.21.0)

## Overview

Flow `0.21.1` supersedes `v0.21.0` and bumps the core engine pin from
`maestro-flow@0.5.69` to `maestro-flow@0.5.70`. The `0.5.70` release carries
the runtime pieces the suite's execution-generation session model is built
against — `run-response/1.1`, session/run v3 schemas and protocol, and the
execution lifecycle (`session/2.0` engine) — so the published artifact now
matches the feature surface described in the v0.20.0/v0.21.0 release notes.

The API Manager `api.models` list, the Cockpit unified-editor input history,
and all other v0.21.0 content are unchanged; this release only corrects the
engine reference.

## Highlights

### Engine Pin — maestro-flow 0.5.69 → 0.5.70

- `feat(runtime)`: minimal session run v3 protocol; session and run v3
  schemas.
- `feat(run)`: `run-response/1.1` + reuse acceptance + execution-bound
  runtime; execution lifecycle + `session/2.0` engine; execution-bound `next`
  with an execution test suite.
- `feat(knowledge)`: reconciliation schema + reconcile hardening; session
  knowledge transcript evidence snapshots; recall source-fence v11 and
  session-knowledge promotion.
- `feat(cli)`: execution/session/run/plan/knowledge command surfaces; fail
  closed with `--id` guidance when session/run start misses; guidance-delivery
  fallbacks and dead flag removal.
- Search usage recording, dashboard status routes, and Sidebar fixes and
  hardening (canonical download links, knowledge refresh frequency-only
  changes, md preview escaping, editor accessibility baseline).

## Package Versions

| Package | Previous | v0.21.1 closure |
|---------|---------:|----------------:|
| pi-maestro-flow | 0.20.0 / 0.21.0 | **0.21.1** (supersedes 0.21.0) |
| pi-maestro-teammate | 1.13.0 | **1.13.0** (unchanged) |
| pi-cockpit | 0.15.0 / 0.16.0 | **0.16.0** (unchanged) |
| pi-maestro-settings-core | 0.1.3 | **0.1.3** (unchanged) |
| maestro-flow | 0.5.69 | **0.5.70** |

- Requires Node.js `>=22.19.0`.
- Pi core packages remain optional wildcard peers supplied by the host.
- Only Flow is re-published: Cockpit `0.16.0` and Teammate `1.13.0` are
  already on the registry and have no unpublished changes.

## Install / Upgrade

Close running Pi processes before upgrading, then run:

```bash
pi install npm:pi-maestro-flow@0.21.1
pi list
```

After restart, verify Flow `0.21.1`, Teammate `1.13.0`, Cockpit `0.16.0`,
Settings-Core `0.1.3`, and the engine `maestro-flow@0.5.70`.

## Release Verification

- Serial release gate (`npm run test:release`) re-ran in full on the `0.5.70`
  closure: Settings-Core typecheck and tests; Teammate typecheck, 1,302-test
  suite (1,300 pass, the known stable baseline), build and check
  declarations; Cockpit typecheck and 754-test suite; Flow typecheck and all
  18 release suites including both packed-consumer tests. 3,435 tests total,
  zero failures, exit 0 — identical to the `0.5.69` baseline, confirming the
  engine bump is non-breaking for the suite.
- Manifest contract re-verified after the bump: three consumers pin
  `pi-maestro-settings-core` at `0.1.3`; Flow pins `pi-cockpit@0.16.0` and
  `pi-maestro-teammate@1.13.0`; the engine dependency now resolves to
  `maestro-flow@0.5.70`.

Dry-run tarball from the verified candidate:

| Package | Files | Packed | Unpacked | SHA-1 |
|---------|------:|-------:|---------:|-------|
| pi-maestro-flow@0.21.1 | 635 | 1,836,623 | 7,007,529 | `10b549b7a613c674db2fccad4747af9221e82411` |

Only Flow is published in this release; Cockpit `0.16.0` (SHA-1
`b594e769994e3e1bb21870526a71b733c01cf7b0`) and Teammate `1.13.0` stay as
published with v0.21.0.

Fresh isolated `USERPROFILE` + `HOME` registry install passed: Flow `0.21.1`,
Cockpit `0.16.0`, Teammate `1.13.0`, the engine `maestro-flow@0.5.70`, and
each consumer's exact Settings-Core `0.1.3` dependency resolved from the
registry. `pi list` registered `npm:pi-maestro-flow@0.21.1` in the isolated
home and packaged Skills were materialized under the installed plugin.

## Change Statistics

Engine delta `v0.5.69..v0.5.70`: 384 files changed, 56,350 insertions and
1,853 deletions across the upstream `D:/maestro2` source. Flow-side candidate:
version bump `0.21.0 → 0.21.1` plus the engine pin change; docs and changelog
synced to the new version.
