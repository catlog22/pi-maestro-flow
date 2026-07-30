---
role: implementer
prefix: BUILD
inner_loop: false
message_types: [impl_complete, impl_failed, error]
---

# Issue Implementer

## Modes

| Backend | Condition | Method |
|---------|-----------|--------|
| codex | task_count > 3 or explicit | `teammate({ taskType: "development", /* --to codex */, name: "issue-<issueId>" })` |
| agy | task_count <= 3 or explicit | `teammate({ taskType: "development", /* --to agy */, name: "issue-<issueId>" })` |
| qwen | explicit | `teammate({ taskType: "development", /* --to qwen */, name: "issue-<issueId>" })` |

## Phase 2: Load Solution & Resolve Executor

| Input | Source | Required |
|-------|--------|----------|
| Issue ID | Task description (GH-\d+ or ISS-\d{8}-\d{3}) | Yes |
| Solution artifact | `{run_dir}/outputs/solutions/solution-<issueId>.json` | Yes |
| Explorer context | `{run_dir}/work/team/explorations/context-<issueId>.json` | No |
| Execution method | Task description (`execution_method: Codex|Agy|Qwen|Auto`) | Yes |
| Code review | Task description (`code_review: Skip|Agy Review|Codex Review`) | No |

1. Extract issue ID from task description
2. If no issue ID -> report error, STOP
3. Load solution artifact: `Read("{run_dir}/outputs/solutions/solution-<issueId>.json")`
4. If no solution artifact -> report error, STOP
5. Load explorer context (if available)
6. Resolve execution method (Auto: task_count <= 3 -> agy, else codex)
7. Update issue status: `Bash("maestro issue update <issueId> --status in_progress --json")`

## Phase 3: Implementation (Multi-Backend Routing)

**Execution prompt template** (all backends):

```
## Issue
ID: <issueId>
Title: <solution.bound.title>

## Solution Plan
<solution.bound JSON>

## Codebase Context (from explorer)
Relevant files: <explorerContext.relevant_files>
Existing patterns: <explorerContext.existing_patterns>
Dependencies: <explorerContext.dependencies>

## Implementation Requirements
1. Follow the solution plan tasks in order
2. Write clean, minimal code following existing patterns
3. Run tests after each significant change
4. Ensure all existing tests still pass
5. Do NOT over-engineer

## Quality Checklist
- All solution tasks implemented
- No TypeScript/linting errors
- Existing tests pass
- New tests added where appropriate
```

Route by executor:
- **codex**: `Bash("teammate({ agent: "delegate", taskType: "development", task: "<prompt>", /* --to codex: set model via model-availability */, name: "issue-<issueId>" }) { background: false })`
- **agy**: `Bash("teammate({ agent: "delegate", taskType: "development", task: "<prompt>", /* --to agy: set model via model-availability */, name: "issue-<issueId>" }) { background: false })`
- **qwen**: `Bash("teammate({ agent: "delegate", taskType: "development", task: "<prompt>", /* --to qwen: set model via model-availability */, name: "issue-<issueId>" }) { background: false })`

On CLI failure, resume: `teammate({ agent: "delegate", taskType: "development", task: "Continue", /* --to <tool>: set model via model-availability */, /* --resume: no teammate equivalent; re-dispatch or use resident agent */ })

## Phase 4: Verify & Commit

| Check | Method | Pass Criteria |
|-------|--------|---------------|
| Tests pass | Detect and run test command | No new failures |
| Code review | Optional, per task config | Review output logged |

- Tests pass -> optional code review -> `Bash("maestro issue close <issueId> --status completed --resolution \"Implemented and verified\" --json")` -> report `impl_complete`
- Tests fail -> report `impl_failed` with truncated test output

Update `{run_dir}/work/team/wisdom/.msg/meta.json` under `implementer` namespace:
- Read existing -> merge `{ "implementer": { issue_id, executor, test_status, review_status } }` -> write back
