# Test Workflow (UAT)

Conversational UAT testing with persistent state, auto-diagnosis, and gap-fix closure loop.

**Core**: Show expected behavior, ask if reality matches. One test at a time.
- "yes" / "y" / "next" / empty / "pass" → pass
- "skip" / "can't test" / "n/a" → skipped
- Anything else → logged as issue, severity auto-inferred

NEVER ask "how severe is this?"

---

### Step 1: Resolve Target

| Input | Action |
|-------|--------|
| Phase number (e.g., "3") | `TARGET_TYPE=phase`, resolve from `state.json` artifacts |
| Scratch task ID | `TARGET_TYPE=scratch`, `SCRATCH_DIR=.workflow/scratch/{id}/` |
| Nothing | Check active UAT sessions (Step 2), else prompt user |

**Flags:** `--smoke` (cold-start smoke tests before UAT), `--auto-fix` (auto gap-fix loop on failures)

Validate target exists and has verification.json (E002).

---

### Step 2: Check Active Sessions

```bash
# Check scratch dirs (resolved via artifact registry) for active UAT sessions
find .workflow/scratch -name "uat.md" -type f 2>/dev/null | head -5
```

Read each file's frontmatter (status, target) and Current Test section.

**If active sessions exist AND no $ARGUMENTS:**

Display inline:
```
## Active UAT Sessions

| # | Target | Status | Current Test | Progress |
|---|--------|--------|--------------|----------|
| 1 | 04-comments | testing | 3. Reply to Comment | 2/6 |
| 2 | quick-fix-nav | testing | 1. Nav Links | 0/4 |

Reply with a number to resume, or provide a phase/task to start new.
```

Wait for user response.
- Number -> resume that session (go to Step 9: Resume From File)
- Phase/task ID -> new session (go to Step 4: Find Testables)

**If active sessions exist AND $ARGUMENTS provided:**
Check if session exists for that target. If yes, offer resume or restart.

**If no active sessions AND no $ARGUMENTS:**
Prompt: "No active UAT sessions. Provide a phase number or scratch task ID to start testing."

**If no active sessions AND $ARGUMENTS:**
Continue to Step 3 or Step 4.

---

### Step 3: Run Smoke Tests (if --smoke)

Skip if --smoke not set.

Inject basic sanity tests BEFORE UAT scenarios:

| Smoke Test | Check | Method |
|------------|-------|--------|
| App starts | Process runs without crash | `bash: start command, check exit code` |
| Routes respond | Key endpoints return non-error | `bash: curl/fetch main routes` |
| Build clean | No build errors | `bash: build command succeeds` |
| Dependencies | No missing deps | `bash: install check` |

Record smoke results in uat.md under `## Smoke Tests` section.
If any smoke test fails: abort UAT, report as blocker, suggest Skill({ skill: "quality-debug" }). (E003)

---

### Step 4: Load Verification Context

Read from target directory: `verification.json`, `validation.json`, `index.json`, `plan.json`, `.summaries/TASK-*.md`.

Build testable list from success_criteria + must_haves + task accomplishments (user-observable outcomes only).

---

### Step 5: Design Test Scenarios

For each testable item, create a scenario:
- **id**: T-001, T-002, ...
- **name**: Brief test name
- **category**: "e2e" | "integration" | "unit"
- **expected**: Specific observable behavior (what user should see)
- **requirement_ref**: Which success criterion this covers

Write test-plan.json to `.tests/`:
```json
{
  "target": "{phase or scratch ID}",
  "generated_at": "{ISO timestamp}",
  "tests": [...],
  "coverage": {
    "requirements_mapped": ["SC-001"],
    "requirements_unmapped": ["SC-003"]
  }
}
```

```bash
mkdir -p "$OUTPUT_DIR/.tests"
```

Skip internal/non-observable items (refactors, type changes).

---

### Step 6: Create UAT File

Archive existing `uat.md` → `$OUTPUT_DIR/.history/uat-{YYYY-MM-DDTHH-mm-ss}.md`.

Create `$OUTPUT_DIR/uat.md`:

```markdown
---
status: testing
target: {phase slug or scratch ID}
source: [list of summary files]
started: {ISO timestamp}
updated: {ISO timestamp}
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

number: 1
name: {first test name}
expected: |
  {what user should observe}
awaiting: user response

## Smoke Tests
{results if ran, otherwise omitted}

## Tests

### 1. {Test Name}
expected: {observable behavior}
result: [pending]

### 2. {Test Name}
expected: {observable behavior}
result: [pending]

...

## Summary

total: {N}
passed: 0
issues: 0
pending: {N}
skipped: 0

## Gaps

[none yet]
```

→ Step 7.

---

### Step 7: Present Test

Display:

```
------------------------------------------------------------
  TEST {number}/{total}: {name}
------------------------------------------------------------

Expected behavior:
{expected}

------------------------------------------------------------
> Type "pass" or describe what's wrong
------------------------------------------------------------
```

Wait for user response (plain text).

---

### Step 8: Process Response

| Response | Action |
|----------|--------|
| empty / "yes" / "y" / "ok" / "pass" / "next" | Pass |
| "skip" / "can't test" / "n/a" | Skipped |
| Anything else | Issue (severity auto-inferred) |

For issues, update Tests section:
```yaml
### {N}. {name}
expected: {expected}
result: issue
reported: "{verbatim user response}"
severity: {inferred}
```

Append to Gaps section:
```yaml
- test: {N}
  truth: "{expected behavior}"
  status: failed
  reason: "User reported: {verbatim}"
  severity: {inferred}
  requirement_ref: {if mapped}
```

**Auto-create Issue from UAT Gap:**

Append to `.workflow/issues/issues.jsonl`: `ISS-{YYYYMMDD}-{NNN}`, title "UAT: {test.name} - {response}" (max 100 chars), `source: "uat"`, severity/priority from inference. Back-reference: set `gap.issue_id` in gap YAML.

**Write triggers:** 1) Issue found 2) Session complete 3) Every 5 passed tests (checkpoint).

More tests → Step 7. No more → Step 10.

---

### Step 9: Resume From File

Read uat.md → find first `result: [pending]` → update Current Test → Step 7.

---

### Step 10: Complete Session

Update uat.md: `status: complete`. Archive existing test artifacts → `.history/`.

Write `.tests/test-results.json`:
```json
{
  "target": "{phase or scratch ID}",
  "completed_at": "{ISO timestamp}",
  "results": [
    { "id": "T-001", "name": "...", "status": "pass|issue|skipped", "details": "..." }
  ],
  "summary": { "total": N, "passed": N, "issues": N, "skipped": N }
}
```

Write `.tests/coverage-report.json`:
```json
{
  "target": "{phase or scratch ID}",
  "generated_at": "{ISO timestamp}",
  "requirements_covered": ["SC-001"],
  "requirements_uncovered": ["SC-003"],
  "coverage_percentage": 66.7
}
```

Update index.json with uat results (`status`, `test_count`, `passed`, `gaps`).

issues == 0 → Step 13. issues > 0 → Step 11.

---

### Step 11: Auto-Diagnose

1. **Cluster gaps** by component/area (same file/module → one cluster, same flow → one cluster)
2. MANDATORY, NOT SUBSTITUTABLE by manual Read/Grep: **Spawn one debug agent per cluster** (parallel, `run_in_background: false`): pre-filled symptoms, `goal: find_root_cause`. Include `issue_id` refs.
3. **Collect results**, update uat.md gaps:
```yaml
- test: {N}
  truth: "..."
  status: failed
  reason: "..."
  severity: {inferred}
  root_cause: "{diagnosed cause}"
  fix_direction: "{suggested approach}"
  affected_files: ["{file1}", "{file2}"]
```

---

### Step 12: Gap Closure Decision

`AUTO_FIX` set → skip prompt, go to gap-fix loop. Otherwise present:

```
### Diagnosis Complete

| Gap | Severity | Root Cause | Fix Direction |
|-----|----------|------------|---------------|
| T-3 | major    | Missing null check | Add guard clause |
| T-5 | blocker  | Event not cleaned  | Add cleanup logic |

Options:
1. Auto-fix -- Plan and execute fixes, then re-verify
2. Debug deep -- Skill({ skill: "quality-debug" }) per issue
3. Plan fixes -- Skill({ skill: "maestro-plan", args: "{phase} --gaps" })
4. Manual fix -- Address issues yourself
```

| Choice | Action |
|--------|--------|
| 1 / "auto-fix" | Go to gap-fix loop |
| 2 / "debug" | Suggest Skill({ skill: "quality-debug" }) |
| 3 / "plan" | Suggest Skill({ skill: "maestro-plan", args: "{phase} --gaps" }) |
| 4 / "manual" | Done, report results |

**Gap-fix closure loop** (max 2 iterations):

1. `maestro-plan {phase} --gaps` → fix tasks
2. `maestro-execute {phase}` → execute fixes
3. `maestro-execute {phase}` → re-verify

Issue lifecycle: `registered` → `planning` → `executing` → `completed` | `failed`.

Pass → update uat.md gaps as resolved. Still gaps → report remaining, suggest manual intervention.

---

### Step 12.5: UAT Confidence Scoring

Dimensions (4): scenario_coverage, diagnostic_depth, observation_quality, closure_completeness. Factors (weights): requirements_mapped(.30), observation_specificity(.25), user_validation(.20), diagnostic_depth(.15), consistency(.10). Score at: init (Step 5), per user response (Step 8), after gap-fix loop (Step 12).

Quality mechanisms: Pressure Pass — >80% pass → ask user to try edge case. Devil's Advocate — >70% first-try pass → challenge scenario difficulty. Stall Detection — 2 gap-fix iterations without improvement → stop.

Readiness Gate (blocks Step 13): scenario_coverage < 40% | blocker gap without diagnosis | no pressure pass (if >80%) | unresolved gaps without acknowledgment. Append confidence summary to uat.md.

---

### Step 13: Report

```
=== UAT RESULTS ===
Target:      {target}

Smoke Tests: {smoke_count} run, {smoke_pass} passed (if ran)
UAT Tests:   {total} total
  Passed:    {passed}
  Issues:    {issues} ({blocker_count} blockers, {major_count} major)
  Skipped:   {skipped}

Diagnosis:   {diagnosed_count}/{issues} gaps diagnosed
Auto-fix:    {fixed_count} gaps resolved (if ran)

Files:
  {target_dir}/uat.md
  {target_dir}/.tests/test-results.json
  {target_dir}/.tests/coverage-report.json

Next steps:
  {suggested_next_command}
```

**Next step routing:**

| Result | Suggestion |
|--------|------------|
| All passed, no gaps | Skill({ skill: "maestro-milestone-audit" }) |
| Gaps auto-fixed | Skill({ skill: "maestro-milestone-audit" }) |
| Gaps remain, diagnosed | Skill({ skill: "quality-debug" }) or Skill({ skill: "maestro-plan", args: "--gaps" }) |
| Low coverage | Skill({ skill: "quality-auto-test", args: "{phase}" }) to generate missing tests |

---

## Severity Inference

| User says | Infer |
|-----------|-------|
| "crashes", "error", "exception", "fails completely", "can't use" | blocker |
| "doesn't work", "nothing happens", "wrong behavior", "broken" | major |
| "works but...", "slow", "weird", "minor issue", "inconsistent" | minor |
| "color", "spacing", "alignment", "looks off", "typo" | cosmetic |

Default: **major**. NEVER ask severity — infer and move on.
