# Review Workflow

Tiered multi-dimensional code review with parallel agents, severity classification, and iterative deep-dive.

---

## Spec Compliance Pre-Check (Phase 0)

1. Load `convergence.criteria[]` from each `.task/TASK-{NNN}.json`
2. For each criterion, grep for functions/endpoints/components named in the criterion
3. Classify: **MET** (evidence found) | **UNMET** (not implemented) | **PARTIAL** (incomplete)

| Result | Action |
|--------|--------|
| All MET | Proceed to Step 1 (dimensional review) |
| Any UNMET | Report as spec_compliance_failures, add to findings with severity=critical, dimension="spec-compliance" |
| Any PARTIAL | Report with severity=high |

---

## Receiving Review Feedback

1. **Verify before implementing** — Check each suggestion against codebase reality.
2. **Technical acknowledgment only** — No performative agreement. State the fix or provide technical reasoning.
3. **Push back when wrong** — If a suggestion would break functionality or violate constraints, explain why with evidence.
4. **YAGNI check** — Verify suggested features/abstractions are actually needed.
5. **Implement one at a time** — Fix one item, test, then next. NEVER batch-implement all feedback.
6. **Priority order** — Blocking (breaks, security) → Simple (typos, imports) → Complex (refactoring, logic).

---

## Phase Resolution

```
Input: <phase> argument (number or slug)

Resolve phase from .workflow/state.json artifacts (type=execute, match by phase number or slug)
→ PHASE_DIR = ".workflow/" + artifact.path
→ Error if not found or no completed tasks
```

---

## Flag Processing

| Flag | Effect |
|------|--------|
| `--level quick\|standard\|deep` | Explicit review level (default: auto-detect) |
| `--dimensions <list>` | Comma-separated subset (overrides level defaults) |
| `--skip-specs` | Skip loading project specs |

---

## Review Levels

| Aspect | Quick | Standard | Deep |
|--------|-------|----------|------|
| **Trigger** | `--level quick`, or auto ≤3 files | Default, or auto 4-19 files | `--level deep`, or auto ≥20 files / critical phase |
| **Dimensions** | correctness, security | All 6 | All 6 |
| **Execution** | Inline (no agents) | Parallel agents | Parallel agents |
| **Deep-Dive** | None | Auto (if critical > 0) | Forced, max 3 iterations |
| **Issue Creation** | Critical only | Critical + High | Critical + High + Medium |
| **Cross-File Analysis** | None | Critical files (3+ dims) | Full impact radius |

---

## Step 1: Collect Changed Files

### 1a: Extract from task summaries

```
Collect changed_files from PHASE_DIR:
  - .summaries/TASK-{NNN}-summary.md → extract referenced file paths (created/modified/deleted)
  - .task/TASK-{NNN}.json → extract files[].path where action is create|modify
Deduplicate result
```

### 1b: Validate files exist

```
review_files = changed_files filtered to: exists on disk AND not in excluded patterns

Excluded patterns:
  - node_modules/**, vendor/**, dist/**, build/**
  - *.lock, *.min.js, *.min.css
  - .workflow/**, .claude/**
```

### 1c: Error if empty

```
Abort E004 if review_files is empty
```

---

## Step 2: Determine Review Level

```
level = --level flag value, or auto-detect:
  ≤3 files → quick | ≥20 files or critical phase → deep | otherwise → standard

Log: "Review level: {level} ({file_count} files)"
```

### Determine dimensions

```
dimensions = --dimensions flag (comma-separated), or level defaults:
  quick → [correctness, security]
  standard|deep → [correctness, security, performance, architecture, maintainability, best-practices]
```

---

## Step 3: Load Project Specs

**Skip if `--skip-specs`.**

```
specs_content = maestro spec load --category review
→ Pass to reviewer agents as quality standards context
```

---

## Step 4: Load Review Context

Build context object for reviewer agents:

```
review_context = {
  phase_goal: index.json.goal || index.json.description,
  success_criteria: index.json.success_criteria,
  tech_stack: detect from package.json / pyproject.toml / go.mod / Cargo.toml,
  specs: specs_content (from Step 3),
  verification_gaps: load from ${PHASE_DIR}/verification.json .gaps if exists, else []
}
```

---

## Step 5: Execute Review

### Quick Level — Inline Scan

```
Scan each review_file against each dimension, collecting findings:

  correctness: unhandled null/undefined, missing error propagation, type mismatches,
               off-by-one, missing boundary checks, unreachable code, logic contradictions
  security:    SQL/command injection, hardcoded secrets/keys/passwords,
               missing input validation, XSS vectors

Each finding: { id: "{PREFIX}-{NNN}", dimension, severity, title, file, line, snippet,
               description, impact, suggestion }
```

**After inline scan, skip to Step 6.**

### Standard Level — Parallel Agent Review

```
MANDATORY, NOT SUBSTITUTABLE by manual Read/Grep: Per dimension → spawn workflow-reviewer agent (all parallel):
  Context: dimension, phase_name, phase_goal, review_files, success_criteria,
           tech_stack, specs_content, verification_gaps
  Instructions:
    - Read each file, analyze for {dimension}-specific issues only
    - Classify: critical / high / medium / low
    - Return JSON array: id, dimension, severity, title, file, line, snippet,
      description, impact, suggestion, spec_violation (if applicable)
    - Top 20 findings by severity, each with file:line evidence
```

Launch ALL dimension agents in a single message. Collect dimension_results (JSON findings array). Log W001 on agent failure, continue with partial results; flag review as [LOW CONFIDENCE] (partial results).

### Deep Level — Enhanced Agent Review

```
Same as standard, with deep-mode enhancements:
  - Also read direct imports for context
  - Trace callers/dependents for critical/high findings
  - Cross-reference patterns across files (duplication, inconsistency)
  - Return includes additional field: related_files[]
  - Top 30 findings (vs 20 for standard)
```

---

## Step 6: Aggregate Findings

### 6a: Merge all findings

```
all_findings = merge all dimension results, sorted by severity (critical > high > medium > low), then dimension
```

### 6b: Severity distribution

```
severity_dist = count all_findings by severity {critical, high, medium, low}
```

### 6c: Identify critical files (standard + deep only)

```
IF level != "quick":
  critical_files = files with critical/high findings across 3+ distinct dimensions
  → [{ file, dimensions[] }]
```

### 6d: Determine verdict

```
verdict:
  BLOCK → any critical, or >5 high
  WARN  → any high (≤5)
  PASS  → no critical or high
```

---

## Step 6.5: CLI Supplementary Analysis (standard + deep only)

**Skip for quick level or if no enabled CLI tools.**

```
IF level == "quick" OR no CLI tools enabled: skip to Step 7

# Gather critical/high findings for CLI cross-check
cli_targets = all_findings.filter(f => f.severity in ["critical", "high"])
IF cli_targets.length == 0: skip to Step 7

# Build concise review prompt from findings
finding_summary = cli_targets.map(f => "${f.id}: [${f.severity}] ${f.file}:${f.line} — ${f.title}").join("\n")

MANDATORY, NOT SUBSTITUTABLE by manual Read/Grep:
Bash({
  command: 'maestro delegate "PURPOSE: Cross-verify code review findings and identify missed issues
TASK: For each finding, verify severity is accurate | Check for false positives | Identify any critical issues missed by initial review in the same files
MODE: analysis
CONTEXT: @${review_files as glob pattern}
EXPECTED: JSON array of { finding_id, verified: bool, adjusted_severity?, missed_issues?: [{ severity, file, line, title, description }] }
CONSTRAINTS: Only report missed issues of severity high or above | Do not duplicate existing findings

Existing findings to verify:
${finding_summary}
" --role review --mode analysis',
  run_in_background: true
})
```

**On callback:**
```
cli_result = maestro delegate output <id>
Parse JSON from cli_result

For each verified finding:
  If adjusted_severity differs: update finding.severity, add finding.cli_note = "severity adjusted by CLI review"
For each missed_issue:
  Append to all_findings with id: "CLI-{NNN}", source: "cli-supplementary"

Recalculate severity_dist after merge
```

---

## Step 7: Deep-Dive (Conditional)

**Skip for quick level.**

| Level | Trigger |
|-------|---------|
| Standard | `severity_dist.critical > 0` |
| Deep | Always |

### 7a: Select deep-dive targets

```
deep_dive_targets:
  deep  → critical + high findings, top 15
  standard → critical findings only, top 10
```

### 7b: Deep-dive iteration

```
Iterate up to max_iterations (deep=3, standard=1) over unresolved targets:

  MANDATORY, NOT SUBSTITUTABLE by manual Read/Grep: Per target → spawn workflow-reviewer agent:
    Context: original finding JSON, previous analysis (if iteration > 1)
    Tasks: read affected file, find callers/imports, check test coverage
    Analyze: root cause, impact radius, remediation (with code example), risk if unfixed

    Return JSON:
    {
      "finding_id": "{target.id}",
      "root_cause": "...",
      "impact_radius": ["file1.ts", "file2.ts"],
      "remediation": { "approach": "...", "code_example": "..." },
      "risk_if_unfixed": "...",
      "reassessed_severity": "critical|high|medium|low",
      "confidence": 0.0-1.0
    }

  Merge: enrich original finding, mark complete if confidence >= 0.8,
         update severity if reassessed. Stop early if all resolved.
```

---

## Step 8: Auto-Create Issues

| Level | Create issues for |
|-------|-------------------|
| Quick | Critical only |
| Standard | Critical + High |
| Deep | Critical + High + Medium |

```
Filter findings by level threshold

For each qualifying finding → append issue to .workflow/issues/issues.jsonl:
  id: "ISS-{YYYYMMDD}-{NNN}" (auto-increment from existing today's entries)
  title: "[{dimension}] {title}" (max 100 chars)
  status: "registered"
  priority: severity_to_priority (critical→1, high→2, medium→3)
  severity, source: "review", phase_ref, gap_ref: finding.id
  description, fix_direction: finding.suggestion
  context: { location: "{file}:{line}", suggested_fix, notes: impact }
  tags: ["review", dimension]
  Timestamps: created_at, updated_at = now()

Link finding.issue_id back to created issue
```

---

## Step 9: Write review.json

Archive existing `review.json` → `${PHASE_DIR}/.history/review-{YYYY-MM-DDTHH-mm-ss}.json`

```
Write ${PHASE_DIR}/review.json:
{
  "phase": PHASE_NUM,
  "level": "quick" | "standard" | "deep",
  "verdict": "PASS" | "WARN" | "BLOCK",
  "reviewed_at": now(),
  "reviewer": "workflow-reviewer",
  "dimensions_reviewed": dimensions,
  "files_reviewed": review_files,
  "severity_distribution": {
    "critical": N,
    "high": N,
    "medium": N,
    "low": N,
    "total": N
  },
  "critical_files": critical_files,
  "findings": all_findings,
  "deep_dives": deep_dive_results (if any),
  "issues_created": issue_ids[]
}
```

---

## Step 10: Update index.json

```
Update index.json.updated_at = now()
Glob review.json MUST exist before Step 10 complete; BLOCKED if missing.
Set index.json.review = { level, verdict, reviewed_at, severity_distribution,
                          findings_count, issues_created count }
```

---

## Report Format

```
=== CODE REVIEW RESULTS ===
Phase:     {phase_name}
Level:     {quick | standard | deep}
Files:     {files_reviewed.length} files across {dimensions.length} dimensions
Duration:  {duration}

Severity Distribution:
  Critical: {critical}
  High:     {high}
  Medium:   {medium}
  Low:      {low}

Top Issues:
  1. [{severity}] {finding_id}: {title} ({file}:{line})
  2. [{severity}] {finding_id}: {title} ({file}:{line})
  3. [{severity}] {finding_id}: {title} ({file}:{line})
  ... (up to 10)

{IF level != "quick":
Critical Files (3+ dimensions flagged):
  - {file} ({dimension1}, {dimension2}, {dimension3})
}

Verdict: {PASS | WARN | BLOCK}
Issues Created: {count}

Files:
  {artifact_dir}/review.json

Next steps:
  {suggested_next_command}
```

---

## Next Step Routing

| Verdict | Suggestion |
|---------|------------|
| PASS | Skill({ skill: "quality-test", args: "{phase}" }) for UAT, or Skill({ skill: "maestro-milestone-audit" }) if UAT already passed |
| WARN | Review findings, then Skill({ skill: "quality-test", args: "{phase}" }) — acknowledge warnings before proceeding |
| BLOCK (≤3 findings, all medium/low) | **Lightweight fix loop**: fix inline → re-run review on affected files only → repeat until PASS/WARN (max 2 iterations) |
| BLOCK (>3 findings or any critical) | Full fix cycle: Skill({ skill: "maestro-plan", args: "{phase} --gaps" }) -> Skill({ skill: "maestro-execute", args: "{phase}" }) -> re-run Skill({ skill: "quality-review", args: "{phase}" }) |

---

## Error Handling

| Error | Action |
|-------|--------|
| Phase directory not found | Abort: "Phase {phase} not found." |
| No execution results | Abort: "No completed tasks found. Run maestro-execute first." |
| No changed files | Abort: "No changed files detected in this phase." |
| Reviewer agent fails | Log W001, continue with available dimension results |
| All agents fail | Abort: "Review could not complete — all dimension agents failed." |
| Deep-dive agent fails | Log finding as unresolved, skip enrichment; flag finding as [LOW CONFIDENCE] (enrichment skipped) |

---

## State Updates

| When | Field | Value |
|------|-------|-------|
| Step 5 start | index.json.status | "reviewing" (if currently "verifying") |
| Step 10 | index.json.review | Review results summary |
| Step 10 | index.json.updated_at | Current timestamp |
