---
role: executor
prefix: EXEC
inner_loop: true
message_types:
  success: impl_complete
  error: impl_failed
---

# Executor

## Phase 2: Task & Solution Loading

| Input | Source | Required |
|-------|--------|----------|
| Issue ID | Task description `Issue ID:` field | Yes |
| Solution file | Task description `Solution file:` field | Yes |
| Session folder | Task description `Session:` field | Yes |
| Execution method | Task description `Execution method:` field | Yes |
| Wisdom | `{run_dir}/work/team/wisdom/` | No |

1. Extract issue ID, solution file path, session folder, execution method
2. Load solution JSON from file (file-first)
3. If file not found -> report the missing Run solution artifact and STOP
4. Load wisdom files for conventions and patterns
5. Verify solution has required fields: title, tasks

## Phase 3: Implementation

### Backend Selection

| Method | Backend | CLI Tool |
|--------|---------|----------|
| `codex` | `teammate({ taskType: "development", /* --to codex */ })` | Background CLI |
| `agy` | `teammate({ taskType: "development", /* --to agy */ })` | Background CLI |

### CLI Backend (Codex/Agy)

```bash
teammate({ agent: "delegate", taskType: "development", task: "PURPOSE: Implement solution for issue <issueId>; success = all tasks completed, tests pass\nTASK: <solution.tasks as bul…", prompt: "development-implement-feature" })
```

Wait for CLI completion before proceeding to verification.

## Phase 4: Verification + Commit

### Test Verification

| Check | Method | Pass Criteria |
|-------|--------|---------------|
| Tests | Detect and run project test command | All pass |
| Syntax | IDE diagnostics or `tsc --noEmit` | No errors |

If tests fail: retry implementation once, then report `impl_failed`.

### Commit

```bash
git add -A
git commit -m "feat(<issueId>): <solution.title>"
```

### Update Issue Status

`Bash("maestro issue close <issueId> --status completed --resolution \"Plan executed and verified\" --json")`

### Report

Send `impl_complete` message to coordinator via team_msg + SendMessage.

## Boundaries

| Allowed | Prohibited |
|---------|-----------|
| Load solution from file | Create or modify issues |
| Implement via CLI tools (Codex/Agy) | Modify solution artifacts |
| Run tests | Spawn additional agents (use CLI tools instead) |
| git commit | Direct user interaction |
| Update issue status | Create tasks for other roles |
