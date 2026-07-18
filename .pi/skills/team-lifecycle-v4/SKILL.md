---
name: team-lifecycle-v4
description: "Full lifecycle team skill — plan, develop, test, review in one coordinated session. Role-based architecture with coordinator-driven beat model. Triggers on \"team lifecycle v4\"."
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
@~/.maestro/workflows/run-mode-lite.md
</required_reading>

# Team Lifecycle v4

Orchestrate multi-agent software development: specification → planning → implementation → testing → review.

## Architecture

```
Skill(skill="team-lifecycle-v4", args="task description")
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
     +-- analyze → dispatch → spawn → STOP
                                 |
                    +--------+---+--------+
                    v        v            v
             [team-worker]  ...    [team-supervisor]
              per-task               resident agent
              lifecycle              message-driven
                                     (woken via SendMessage)
```

## Role Registry

| Role | Path | Prefix | Inner Loop |
|------|------|--------|------------|
| coordinator | [roles/coordinator/role.md](roles/coordinator/role.md) | — | — |
| analyst | [roles/analyst/role.md](roles/analyst/role.md) | RESEARCH-* | false |
| writer | [roles/writer/role.md](roles/writer/role.md) | DRAFT-* | true |
| planner | [roles/planner/role.md](roles/planner/role.md) | PLAN-* | true |
| executor | [roles/executor/role.md](roles/executor/role.md) | IMPL-* | true |
| tester | [roles/tester/role.md](roles/tester/role.md) | TEST-* | false |
| reviewer | [roles/reviewer/role.md](roles/reviewer/role.md) | REVIEW-*, QUALITY-*, IMPROVE-* | false |
| supervisor | [roles/supervisor/role.md](roles/supervisor/role.md) | CHECKPOINT-* | false |

## Role Router

Parse `$ARGUMENTS`:
- Has `--role <name>` → Read `roles/<name>/role.md`, execute Phase 2-4
- No `--role` → `@roles/coordinator/role.md`, execute entry router

## Shared Constants

- **Session prefix**: `TLV4`
- **Session path**: `{run_dir}/work/team/`
- **CLI tools**: `maestro delegate --mode analysis` (read-only), `maestro delegate --mode write` (modifications)
- **Message bus**: `mcp__maestro__team_msg(session_id=<run-id>, ...)`

## Worker Spawn Template

Coordinator spawns workers using this template:

```
teammate({ agent: "team-worker", name: "<role>", description: "Spawn <role> worker", context: "fresh" })
```

## Supervisor Spawn Template

Supervisor is a **resident agent** (independent from team-worker). Spawned once during session init, woken via SendMessage for each CHECKPOINT task.

### Spawn (Phase 2 — once per session)

```
teammate({ agent: "team-supervisor", name: "supervisor", description: "Spawn resident supervisor", context: "fresh" })
```

### Wake (handleSpawnNext — per CHECKPOINT task)

```
SendMessage({
  type: "message",
  recipient: "supervisor",
  content: `## Checkpoint Request
task_id: <CHECKPOINT-NNN>
scope: [<upstream-task-ids>]
pipeline_progress: <done>/<total> tasks completed`,
  summary: "Checkpoint request: <CHECKPOINT-NNN>"
})
```

### Shutdown (handleComplete)

```
SendMessage({
  type: "shutdown_request",
  recipient: "supervisor",
  content: "Pipeline complete, shutting down supervisor"
})
```

## User Commands

| Command | Action |
|---------|--------|
| `check` / `status` | View execution status graph |
| `resume` / `continue` | Advance to next step |
| `revise <TASK-ID> [feedback]` | Revise specific task |
| `feedback <text>` | Inject feedback for revision |
| `recheck` | Re-run quality check |
| `improve [dimension]` | Auto-improve weakest dimension |

## Completion Action

When pipeline completes, coordinator presents:

```
AskUserQuestion({
  questions: [{
    question: "Pipeline complete. What would you like to do?",
    header: "Completion",
    multiSelect: false,
    options: [
      { label: "Archive & Clean (Recommended)", description: "Archive session, clean up team" },
      { label: "Keep Active", description: "Keep session for follow-up work" },
      { label: "Export Results", description: "Export deliverables to target directory" }
    ]
  }]
})
```

## Specs Reference

- [specs/pipelines.md](specs/pipelines.md) — Pipeline definitions and task registry
- [specs/quality-gates.md](specs/quality-gates.md) — Quality gate criteria and scoring
- [specs/knowledge-transfer.md](specs/knowledge-transfer.md) — Artifact and state transfer protocols

## Session Directory

```
{run_dir}/work/team/
├── team-session.json           # Session state + role registry
├── {run_dir}/outputs/spec/                       # Spec phase outputs
├── {run_dir}/outputs/plan/                       # Implementation plan + TASK-*.json
├── artifacts/                  # scratch/intermediate; formal deliverables go to {run_dir}/outputs/
├── wisdom/                     # Cross-task knowledge
├── explorations/               # Shared explore cache
├── {run_dir}/evidence/discussions/                # Discuss round records
└── .msg/                       # Team message bus
```

## Error Handling

| Scenario | Resolution |
|----------|------------|
| Unknown command | Error with available command list |
| Role not found | Error with role registry |
| CLI tool fails | Worker fallback to direct implementation |
| Fast-advance conflict | Coordinator reconciles on next callback |
| Supervisor crash | Respawn with `recovery: true`, auto-rebuilds from existing reports |
| Supervisor not ready for CHECKPOINT | Spawn/respawn supervisor, wait for ready, then wake |
| Completion action fails | Default to Keep Active |
