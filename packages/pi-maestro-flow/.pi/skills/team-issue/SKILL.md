---
name: team-issue
description: Unified team skill for issue resolution. Uses team-worker agent architecture with role directories for domain logic. Coordinator orchestrates pipeline, workers are team-worker agents. Triggers on "team issue".
allowed-tools:
  - AskUserQuestion
  - Bash
  - Edit
  - Glob
  - Grep
  - Read
  - SendMessage
  - Write
  - mcp__maestro__team_msg
  - teammate
  - todo
session-mode: run
---

<required_reading>
@~/.maestro/workflows/run-mode.md
</required_reading>

# Team Issue Resolution

Orchestrate issue resolution pipeline: explore context -> plan solution -> review (optional) -> marshal queue -> implement. Supports Quick, Full, and Batch pipelines with review-fix cycle.

## Architecture

```
Skill(skill="team-issue", args="<issue-ids> [--mode=<mode>]")
                    |
         SKILL.md (this file) = Router
                    |
     +--------------+--------------+
     |                             |
  no --role flag              --role <name>
     |                             |
  Coordinator                  Worker
  roles/coordinator/role.md    roles/<name>/role.md
     |
     +-- clarify -> dispatch -> spawn workers -> STOP
                                    |
             +-------+-------+-------+-------+
             v       v       v       v       v
          [explor] [plann] [review] [integ] [imple]
```

## Role Registry

| Role | Path | Prefix | Inner Loop |
|------|------|--------|------------|
| coordinator | [roles/coordinator/role.md](roles/coordinator/role.md) | — | — |
| explorer | [roles/explorer/role.md](roles/explorer/role.md) | EXPLORE-* | false |
| planner | [roles/planner/role.md](roles/planner/role.md) | SOLVE-* | false |
| reviewer | [roles/reviewer/role.md](roles/reviewer/role.md) | AUDIT-* | false |
| integrator | [roles/integrator/role.md](roles/integrator/role.md) | MARSHAL-* | false |
| implementer | [roles/implementer/role.md](roles/implementer/role.md) | BUILD-* | false |


## Pre-load (coordinator, before dispatch)

1. **Codebase docs**: If `.workflow/codebase/ARCHITECTURE.md` exists, read for module boundaries
2. **Specs (coding)**: `maestro load --type spec --category coding` — load coding constraints as shared context
3. **Specs (debug)**: `maestro load --type spec --category debug` — load debug constraints as shared context
4. **Wiki knowledge**: `maestro search "issue resolution fix" --json` — top 5 entries as prior context
5. All optional — proceed without if unavailable
## Role Router

Parse `$ARGUMENTS`:
- Has `--role <name>` → Read `roles/<name>/role.md`, execute Phase 2-4
- No `--role` → `@roles/coordinator/role.md`, execute entry router

## Shared Constants

- **Session prefix**: `TISL`
- **Session path**: `.workflow/.team/TISL-<slug>-<date>/`
- **Team name**: `issue`
- **CLI tools**: `maestro delegate --mode analysis` (read-only), `maestro delegate --mode write` (modifications)
- **Message bus**: `mcp__maestro__team_msg(session_id=<session-id>, ...)`

## Worker Spawn Template

Coordinator spawns workers using this template:

```
teammate({ agent: "team-worker", name: "<role>", description: "Spawn <role> worker", context: "fresh" })
```

**Parallel spawn** (Batch mode, N explorer or M implementer instances):

```
teammate({ agent: "team-worker", name: "<role>-<N>", context: "fresh" })
```

## User Commands

| Command | Action |
|---------|--------|
| `check` / `status` | View execution status graph, no advancement |
| `resume` / `continue` | Check worker states, advance next step |

## Session Directory

```
.workflow/.team/TISL-<slug>-<date>/
├── session.json                    # Session metadata + pipeline + fix_cycles
├── task-analysis.json              # Coordinator analyze output
├── .msg/
│   ├── messages.jsonl              # Message bus log
│   └── meta.json                   # Session state + cross-role state
├── wisdom/                         # Cross-task knowledge
│   ├── learnings.md
│   ├── decisions.md
│   ├── conventions.md
│   └── issues.md
├── explorations/                   # Explorer output
│   └── context-<issueId>.json
├── solutions/                      # Planner output
│   └── solution-<issueId>.json
├── audits/                         # Reviewer output
│   └── audit-report.json
├── queue/                          # Integrator output (also .workflow/issues/queue/)
└── builds/                         # Implementer output
```

## Specs Reference

- [specs/pipelines.md](specs/pipelines.md) — Pipeline definitions and task registry

## Error Handling

| Scenario | Resolution |
|----------|------------|
| Unknown command | Error with available command list |
| Role not found | Error with role registry |
| CLI tool fails | Worker fallback to direct implementation |
| Fast-advance conflict | Coordinator reconciles on next callback |
| Completion action fails | Default to Keep Active |
| Review rejection exceeds 2 rounds | Force convergence to integrator |
| No issues found for given IDs | Coordinator reports error to user |
| Deferred BUILD count unknown | Defer to MARSHAL callback |
