---
name: team-review
description: "Unified team skill for code review. 3-role pipeline: scanner, reviewer, fixer. Triggers on team-review."
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

# Team Review

Orchestrate multi-agent code review: scanner -> reviewer -> fixer. Toolchain + LLM scan, deep analysis with root cause enrichment, and automated fix with rollback-on-failure.

## Architecture

```
Skill(skill="team-review", args="task description")
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
     +-- analyze -> dispatch -> spawn workers -> STOP
                                    |
                    +-------+-------+-------+
                    v       v       v
                [scan]  [review]  [fix]
                team-worker agents, each loads roles/<role>/role.md
```

## Role Registry

| Role | Path | Prefix | Inner Loop |
|------|------|--------|------------|
| coordinator | [roles/coordinator/role.md](roles/coordinator/role.md) | — | — |
| scanner | [roles/scanner/role.md](roles/scanner/role.md) | SCAN-* | false |
| reviewer | [roles/reviewer/role.md](roles/reviewer/role.md) | REV-* | false |
| fixer | [roles/fixer/role.md](roles/fixer/role.md) | FIX-* | true |

## Role Router

Parse `$ARGUMENTS`:
- Has `--role <name>` -> Read `roles/<name>/role.md`, execute Phase 2-4
- No `--role` -> `@roles/coordinator/role.md`, execute entry router

## Shared Constants

- **Session prefix**: `RV`
- **Session path**: `{run_dir}/work/team/`
- **Team name**: `review`
- **CLI tools**: `maestro delegate --mode analysis` (read-only), `maestro delegate --mode write` (modifications)
- **Message bus**: `mcp__maestro__team_msg(session_id=<run-id>, ...)`

## Worker Spawn Template

Coordinator spawns workers using this template:

```
teammate({ agent: "team-worker", name: "<role>", description: "Spawn <role> worker", context: "fresh" })
```

## User Commands

| Command | Action |
|---------|--------|
| `check` / `status` | View pipeline status graph |
| `resume` / `continue` | Advance to next step |
| `--full` | Enable scan + review + fix pipeline |
| `--fix` | Fix-only mode (skip scan/review) |
| `-q` / `--quick` | Quick scan only |
| `--dimensions=sec,cor,prf,mnt` | Custom dimensions |
| `-y` / `--yes` | Skip confirmations |

## Completion Action

When pipeline completes, coordinator presents:

```
AskUserQuestion({
  questions: [{
    question: "Review pipeline complete. What would you like to do?",
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

## Session Directory

```
{run_dir}/work/team/
├── .msg/messages.jsonl     # Team message bus
├── .msg/meta.json          # Session state + cross-role state
├── wisdom/                 # Cross-task knowledge
├── {run_dir}/outputs/scan/                   # Scanner output
├── {run_dir}/outputs/review/                 # Reviewer output
└── {run_dir}/outputs/fix/                    # Fixer output
```

## Specs Reference

- [specs/pipelines.md](specs/pipelines.md) — Pipeline definitions and task registry
- [specs/dimensions.md](specs/dimensions.md) — Review dimension definitions (SEC/COR/PRF/MNT)
- [specs/finding-schema.json](specs/finding-schema.json) — Finding data schema
- [specs/team-config.json](specs/team-config.json) — Team configuration

## Error Handling

| Scenario | Resolution |
|----------|------------|
| Unknown --role value | Error with available role list |
| Role not found | Error with expected path (roles/<name>/role.md) |
| CLI tool fails | Worker fallback to direct implementation |
| Scanner finds 0 findings | Report clean, skip review + fix |
| User declines fix | Delete FIX tasks, complete with review-only results |
| Fast-advance conflict | Coordinator reconciles on next callback |
| Completion action fails | Default to Keep Active |
