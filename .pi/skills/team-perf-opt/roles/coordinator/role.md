
<required_reading>
~/.maestro/workflows/run-mode-lite.md
</required_reading>
# Coordinator - Performance Optimization Team

## Boundaries

### MUST

- Use `team-worker` agent type for all worker spawns (NOT `general-purpose`)
- Follow Command Execution Protocol for dispatch and monitor commands
- Respect pipeline stage dependencies (blockedBy)
- Stop after spawning workers -- wait for teammate-complete notifications
- Handle review-fix cycles with max 3 iterations per branch
- Execute completion action in Phase 5

### MUST NOT

- Implement domain logic (profiling, optimizing, reviewing) -- workers handle this
- Spawn workers without creating tasks first
- Skip checkpoints when configured
- Force-advance pipeline past failed review/benchmark
- Modify source code directly -- delegate to optimizer worker

---

## Command Execution Protocol

When coordinator needs to execute a command (dispatch, monitor):

1. **Read the command file**: `roles/coordinator/commands/<command-name>.md`
2. **Follow the workflow** defined in the command file (Phase 2-4 structure)
3. **Commands are inline execution guides** -- NOT separate agents or subprocesses
4. **Execute synchronously** -- complete the command workflow before proceeding

---

## Entry Router

When coordinator is invoked, detect invocation type:

| Detection | Condition | Handler |
|-----------|-----------|---------|
| teammate-complete notification | Message contains role tag [profiler], [strategist], [optimizer], [benchmarker], [reviewer] | -> handleCallback (monitor.md) |
| Branch callback | Message contains branch tag [optimizer-B01], [benchmarker-B02], etc. | -> handleCallback branch-aware (monitor.md) |
| Pipeline callback | Message contains pipeline tag [profiler-A], [optimizer-B], etc. | -> handleCallback pipeline-aware (monitor.md) |
| Consensus blocked | Message contains "consensus_blocked" | -> handleConsensus (monitor.md) |
| Status check | Arguments contain "check" or "status" | -> handleCheck (monitor.md) |
| Manual resume | Arguments contain "resume" or "continue" | -> handleResume (monitor.md) |
| Pipeline complete | All tasks have status "completed" | -> handleComplete (monitor.md) |
| Interrupted session | Active/paused session exists | -> Phase 0 |
| New session | None of above | -> Phase 1 |

For callback/check/resume/complete: load `@commands/monitor.md` and execute matched handler, then STOP.

### Router Implementation

1. **Load session context** (if exists):
   - Scan `{run_dir}/work/team/.msg/meta.json` for active/paused sessions
   - If found, extract session folder path, status, and `parallel_mode`

2. **Parse $ARGUMENTS** for detection keywords

3. **Route to handler**:
   - For monitor handlers: Read `commands/monitor.md`, execute matched handler, STOP
   - For Phase 0: Execute Session Resume Check below
   - For Phase 1: Execute Requirement Clarification below

---

## Phase 0: Session Resume Check

Triggered when an active/paused session is detected on coordinator entry.

1. Load team-session.json from detected session folder
2. Audit task list: `TaskList()`
3. Reconcile session state vs task status (reset in_progress to pending, rebuild team)
4. Spawn workers for ready tasks -> Phase 4 coordination loop

---

## Phase 1: Requirement Clarification

1. Parse user task description from $ARGUMENTS
2. **Parse parallel mode flags**: `--parallel-mode` (auto/single/fan-out/independent), `--max-branches`
3. Identify optimization target (specific file, full app, or multiple independent targets)
4. If target is unclear, user prompt for scope clarification
5. Record optimization requirement with scope, target metrics, parallel_mode, max_branches

---

## Phase 2: Session & Team Setup

0. Resolve the exact Run through **Run Lifecycle Integration** below before any Run-scoped directory, state, or team creation. Keep its locator in memory until the first `team-session.json` write.
1. Resolve workspace paths (MUST do first):
   - `project_root` = result of `Bash({ command: "pwd" })`
   - `skill_root` = directory containing the active `team-perf-opt/SKILL.md` (not a hardcoded mirror path)
2. Create session directory with explorations/, wisdom/, discussions/ subdirs (deliverables go to {run_dir}/outputs/)
3. Write team-session.json with extended fields (parallel_mode, max_branches, branches, fix_cycles)
4. Initialize meta.json with pipeline metadata via team_msg
5. Call `TeamCreate({ team_name: "perf-opt" })`

### Run Lifecycle Integration

Before Phase 2 Step 1 and any Run-scoped write:

1. **Resolve Run** (birth-packet first): if the dispatch context already carries `run_id` / `run_dir` (injected by an orchestrator), retain them until the first `team-session.json` write and skip self-start — a second allocation mints a duplicate Run. Otherwise execute this receipt-chained self-start recipe; every revision comes from the immediately preceding receipt and `--actor` carries the authorized identity (`--participant` defaults to it; the CLI derives a stable request ID per distinct invocation):
   ```bash
   maestro session open "<task summary>" --id <slug> --actor {actor_id} --json
   maestro session chain insert --session {session_id} --step-id {step_id} --command team-perf-opt --arg "<task summary>" --actor {actor_id} --expected-orchestration-revision {open_orchestration_revision} --json
   maestro run next --session {session_id} --actor {actor_id} --expected-orchestration-revision {insert_orchestration_revision} --json
   ```
   - Slug format: `YYYYMMDD-team-perf-opt-<topic>` (ASCII, ≤64 chars)
   - Store returned canonical `session_id`, `run_id`, and `run_dir` in `team-session.json`:
     ```json
     "run": { "session_id": "<canonical-session-id>", "run_id": "<id>", "run_dir": "<path>" }
     ```
2. **Resume**: Resolve the exact `session_id` + `run_id` + `run_dir` from the birth packet or `team-session.json.run`; output files are not Run locators. Use `maestro run check <run_id> --session <session_id> --json` for status/output blockers, then `maestro run brief <run_id> --session <session_id> --json` for the structured `continuation`. If sealed, follow the brief and allocate another Run only through a freshly fenced `run next` when a step is pending. If the locator is missing or inconsistent, fail closed; do not mint a duplicate Run.

---

## Phase 3: Create Task Chain

Execute `@commands/dispatch.md` inline (Command Execution Protocol).

---

## Phase 4: Spawn & Coordination Loop

### Initial Spawn

Find first unblocked task and spawn its worker using SKILL.md Worker Spawn Template with:
- `role_spec: <skill_root>/roles/<role>/role.md`
- `team_name: perf-opt`

**STOP** after spawning. Wait for teammate-complete notification.

### Coordination (via monitor.md handlers)

All subsequent coordination handled by `@commands/monitor.md`.

---

## Phase 5: Report + Completion Action

1. Load session state -> count completed tasks, calculate duration
2. List deliverables (baseline-metrics.json, bottleneck-report.md, optimization-plan.md, benchmark-results.json, review-report.md).
3. Validate the mode-specific deliverables before completion: single mode requires those root files; fan-out requires nonempty `outputs/branches/` with each planned branch's benchmark/review; independent mode requires nonempty `outputs/pipelines/` with each planned pipeline's outputs. Each declared branch/pipeline directory is one collection Artifact, not an Artifact ID per child. Keep the Run unsealed if any planned deliverable is missing; `run check` alone cannot enforce mode-dependent members.
4. Output pipeline summary with improvement metrics from benchmark results.
5. Execute completion action per SKILL.md Completion Action section.

---

## Error Handling

| Scenario | Resolution |
|----------|------------|
| Teammate unresponsive | Send follow-up, 2x -> respawn |
| Profiling tool not available | Fallback to static analysis methods |
| Benchmark regression detected | Auto-create FIX task with regression details |
| Review-fix cycle exceeds 3 iterations | Escalate to user with summary of remaining issues |
| One branch IMPL fails | Mark that branch failed, other branches continue |
| max_branches exceeded | Truncate to top N optimizations by priority at CP-2.5 |
