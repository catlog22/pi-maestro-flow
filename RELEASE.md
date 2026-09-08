# v0.30.0 — Gateway Control Surfaces & Progressive Todo Reads

## Overview

This feature release publishes **Flow 0.30.0** and **Teammate 2.6.2** on top
of v0.29.0. **Cockpit 0.23.0**, **Settings-Core 0.2.1**,
**Backend-Core 0.1.3**, and **Backends 0.1.3** are unchanged. Flow keeps the
current external engine pin, `maestro-flow@0.5.86`.

The release extends the authenticated Gateway with durable handoff, governed
Skill, and fixed-schema Maestro CLI services. Todo reads become progressive and
bounded, while resumable New Context updates and content-addressed persistence
reduce prompt and state-file growth. Supporting fixes harden knowledge staging,
Skill context budgets, SSH Gateway guidance, API request headers, and Teammate
terminal lifecycle behavior.

## Highlights

### Flow 0.30.0

- **Gateway handoff lifecycle** — Board and Session handoffs use versioned
  contracts, append-only records, idempotent projection, authorization, and
  completion snapshots across the Gateway catalog, runtime, stores, and
  services.
- **Governed Gateway Skill and Maestro CLI services** — policy-bound Skill
  access and fixed Maestro search/load/stage operations expose constrained
  schemas, private execution authority, sanitized environments, receipts, and
  duplicate-stage protection.
- **Progressive Todo reads** — `list` returns compact indexes, `get` supports
  bounded field paging, activation returns an execution brief, and large task
  content is deduplicated into referenced Todo v8 content records.
- **Resumable context transitions** — an active Todo update can persist current
  progress, handoff, and resources before scheduling `new_context`; completed
  agents record whether their runtime remains wakeable.
- **Knowledge and Skill safety** — knowledge candidates are staged through
  private `--content-file` inputs instead of process argv, and the final
  deduplicated Skill stack is checked against the context budget.
- **Provider and SSH interoperability** — API Manager adds OpenCode request
  header presets and correct clearing semantics; SSH Gateway launches expose a
  `monitorHandle` and require schema discovery before dynamic calls.
- **Project defaults and guidance** — automatic spec/knowhow skill invocation,
  default compaction model selection, Gateway/MCP boundary documentation, and
  refreshed installation guidance align the shipped package with the new
  control surfaces.

### Teammate 2.6.2

- **Stable agent discovery** — built-in mirrors are deduplicated without hiding
  project or user roles, with focused discovery regression coverage.
- **Actionable terminal errors** — settled local agents consistently explain
  why they cannot receive another message and direct callers toward a fresh
  dispatch; generated declarations are refreshed from the release source.

## Package version table

| Package | Previous | New |
|---|---|---|
| pi-maestro-flow | 0.29.0 | 0.30.0 |
| pi-maestro-teammate | 2.6.1 | 2.6.2 |
| pi-cockpit | 0.23.0 | 0.23.0 (unchanged) |
| pi-maestro-settings-core | 0.2.1 | 0.2.1 (unchanged) |
| pi-maestro-backend-core | 0.1.3 | 0.1.3 (unchanged) |
| pi-maestro-backends | 0.1.3 | 0.1.3 (unchanged) |
| maestro-flow (engine pin) | 0.5.86 | 0.5.86 (unchanged) |

## Stats

- **14 commits** on top of baseline tag `v0.29.0` before the release metadata
  commit.
- **82 implementation/test/support files**, **+4,037 / -270** lines before
  version, lockfile, release-note, and documentation updates.

## Install / Upgrade

```bash
pi install npm:pi-maestro-flow@0.30.0
```

This pulls the exact published companion `pi-maestro-teammate@2.6.2` and
existing `pi-cockpit@0.23.0`, `pi-maestro-settings-core@0.2.1`,
`pi-maestro-backend-core@0.1.3`, and `pi-maestro-backends@0.1.3`.
