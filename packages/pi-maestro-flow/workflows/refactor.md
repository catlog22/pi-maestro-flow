# Refactor Workflow

Reduce tech debt through scope analysis, task planning, and reflection-driven execution. Tests MUST pass after every change.

Output: `scratch/{YYYYMMDD}-refactor-{slug}/` with index.json + reflection-log.md + .task/ + .summaries/

---

### Step 1: Parse Scope

| Input | Action |
|-------|--------|
| Module path (e.g., "src/auth") | Scan that directory |
| Feature area (e.g., "authentication") | Search for related files |
| "all" | Full codebase scan |
| Empty | Prompt user |

Generate slug (lowercase, hyphens, max 40 chars). Set date = YYYYMMDD.

---

### Step 2: Create Scratch Directory

Create `REFACTOR_DIR=".workflow/scratch/${date}-refactor-${slug}"` with `.task/` and `.summaries/` subdirs.

Write index.json: id, type="refactor", title, status="active", scope, plan (empty task_ids), execution (method=agent, counts=0), reflection (rounds=0).

---

### Step 2.5: Load Project Specs

```
specs_content = maestro spec load --category coding
```

---

### Step 3: Scope Analysis

Read all files in scope. Use specs_content to detect convention violations. Categorize:

1. **Duplication** - copy-paste patterns
2. **Complexity** - long functions, deep nesting, high cyclomatic complexity
3. **Naming** - inconsistent or unclear names
4. **Dependencies** - circular deps, tight coupling, god objects
5. **Dead code** - unused functions, unreachable branches
6. **Pattern violations** - inconsistent with specs/ conventions

Present summary table. Confirm with user before planning.

---

### Step 4: Plan Refactoring

Write plan.json + `.task/TASK-{NNN}.json` per issue (id, title, status=pending, type=refactor, category, files, convergence criteria, risk level).

Order: quick wins first, high risk last, dependencies respected.

Present plan to user (affected files, risk areas, dependency impacts). Ask: approve / modify / reject.

---

### Step 5: Execute with Reflection

For each task:
- **5a.** Implement the change
- **5b.** Run test suite
- **5c.** Record in reflection-log.md: strategy, result, test status, adjustment, files changed
- **5d.** On test failure: revert, retry with adjusted strategy (max 2 retries). Still failing → mark "blocked"
- **5e.** Update task status, write summary, update index.json

---

### Step 6: Final Verification

Run full test suite. Record final state in reflection-log.md.

---

### Step 7: Complete

Glob plan.json AND .summaries/ MUST exist before marking completed; BLOCKED if missing.

Update index.json: `status="completed"`.

Present: tasks completed/blocked, reflection rounds, strategy adjustments, test status, key learnings. If regressions: list affected tests, suggest quality-debug.

