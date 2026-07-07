# Debug Workflow

---

## Iron Law

**NO FIX PROPOSALS WITHOUT ROOT CAUSE EVIDENCE.**

Before proposing any fix, you MUST have:
1. Reproduced or confirmed the symptom
2. Gathered evidence (logs, code traces, test output)
3. Identified the specific root cause with file:line references

Fix proposals without root cause evidence are forbidden — even "obvious" fixes.

---

## Red Flags — These Thoughts Mean STOP

If you catch yourself thinking any of these, STOP and return to evidence gathering:

- "Quick fix for now, investigate later"
- "I don't fully understand but this might work"
- "This is just a simple case, no need for full investigation"
- "Let me just try changing X and see if it works"
- "The fix is obvious, I don't need to reproduce it"
- "I'll skip the reproduction step to save time"
- "Multiple changes at once will be faster"
- "I already know what the problem is" (without evidence)

All of these mean: **return to Step 3/6 evidence gathering**.

---

## Rationalization Table

| Excuse | Reality |
|--------|---------|
| "It's probably just a typo" | Verify before assuming — typos cause cascading failures |
| "The error message says X so it must be X" | Error messages point to symptoms, not causes |
| "I fixed something similar before" | Similar symptoms can have different root causes |
| "The fix works in my test" | One passing test doesn't prove root cause was found |
| "We don't have time for full investigation" | Quick fixes create more bugs than they solve |
| "The code looks correct" | Reading code is not tracing execution |
| "Let me just add a try-catch/null check" | Suppressing errors hides the real problem |
| "3 failed hypotheses, let me try a 4th" | After 3 failures, STOP — escalate |

---

## Escalation Rule — 3-Strike Architecture Check

After **3 failed hypotheses**, STOP:

1. Summarize all failed hypotheses and evidence
2. Question architecture: "Is the problem deeper than individual code?"
3. AskUserQuestion: Continue with different approach? / Re-examine architecture? / Bring in additional context?

NEVER propose a 4th hypothesis without user confirmation.

---

## Backward Tracing Method

1. **Find** where incorrect value/behavior first appears
2. **Trace backward** through call chain — what called this? What value was passed?
3. **Continue** until you find where correct data becomes incorrect
4. **Fix at the source**, not the symptom location

---

### Step 1: Check Active Sessions

```bash
# Check scratch dirs (resolved via artifact registry) for debug sessions
find .workflow/scratch -path "*/.debug/*" -name "understanding.md" 2>/dev/null | head -5
find .workflow/scratch -type d -name "debug-*" 2>/dev/null | head -5
```

**If active sessions exist AND no $ARGUMENTS:**

Read each session's understanding.md header for status and current hypothesis.

Display:
```
## Active Debug Sessions

| # | Location | Status | Current Hypothesis |
|---|----------|--------|--------------------|
| 1 | scratch/20260420-plan-P3-auth/.debug/jwt-expiry/ | investigating | Token not refreshed on 401 |
| 2 | scratch/20260314-debug-nav-crash/ | checkpoint | Awaiting user input |

Reply with a number to resume, or describe a new issue.
```

Wait for user response.
- Number -> resume that session (load state, go to Step 11: Spawn Continuation)
- Text -> treat as new issue (go to Step 3 or Step 2)

| Result | Action |
|--------|--------|
| Active session found, no args | Offer resume list |
| Active session found, args given | Start new investigation |
| No active sessions, no args | Error E001 |
| No active sessions, args given | Continue to appropriate mode |

If resuming: load understanding.md + evidence.ndjson, spawn continuation agent.

---

### Step 1.5: Load Project Specs

```
# MANDATORY, NOT SUBSTITUTABLE by manual Read/Grep
specs_content = maestro spec load --category debug
→ Pass to debug agents as prior knowledge
```

---

### Step 2: Load UAT Gaps (if --from-uat)

Skip if --from-uat not set → go to Step 3.

Read `{artifact_dir}/uat.md` Gaps section. For each gap:
```yaml
- test: T-003
  truth: "User can reply to comments"
  status: failed
  reason: "User reported: clicking reply does nothing"
  severity: major
  requirement_ref: SC-002
```

**Cluster gaps by component/area:**
- Parse affected features from truth + reason
- Group by likely component (same module, same flow, same file area)
- Each cluster becomes one debug investigation

| Clustering | Example |
|-----------|---------|
| Same component | T-003 (reply) + T-004 (edit comment) -> "comment-actions" cluster |
| Same flow | T-001 (login) + T-002 (session) -> "auth-flow" cluster |
| Unrelated | T-005 (nav color) -> standalone "nav-styling" cluster |

**Issue enrichment:** For each gap with `issue_id`, look up in `.workflow/issues/issues.jsonl` and attach `issue_context` to the gap.

If `--parallel`: → Step 5. Else: → Step 6 (sequential).

---

### Step 3: Gather Symptoms (standalone mode only)

Skip if `--from-uat`. Generate slug from issue description (lowercase, hyphens, max 40 chars).

Ask 5 questions via AskUserQuestion:
1. "What should happen? (expected behavior)"
2. "What happens instead? (actual behavior)"
3. "Any error messages? Paste them or describe."
4. "When did this start? Did it ever work?"
5. "How do you trigger this? (reproduction steps)"

Also gather: `git log --oneline -10`, `git diff --stat HEAD~3`.

Store responses → create debug session directory → Step 6.

---

### Step 4: Determine Output Directory

| Mode | Directory |
|------|-----------|
| Phase-scoped (from UAT) | `{ARTIFACT_DIR}/.debug/{gap-slug}/` |
| Standalone | `.workflow/scratch/{YYYYMMDD}-debug-{slug}/` |

Create the directory.

---

### Step 5: Spawn Parallel Debug Agents — MANDATORY, NOT SUBSTITUTABLE

For each cluster, spawn concurrently (`run_in_background: false`):

- **Input**: cluster name, phase, all gaps (test_id, truth, reason, severity). Mode: `symptoms_prefilled`.
- **Process**: form 2-3 hypotheses per gap, search code for evidence, log NDJSON, confirm/refute.
- **Output per gap**: `root_cause`, `fix_direction`, `affected_files` (file:line), `confidence` (multi-factor + legacy `confidence_level`), `evidence` summary.
- **Files**: `{debug_dir}/evidence-{cluster_slug}.ndjson`, `{debug_dir}/understanding-{cluster_slug}.md`

---

### Step 5.5: CLI Supplementary Evidence Gathering (optional)

**Skip if** no enabled CLI tools or standalone mode with minimal context.

```
IF no CLI tools enabled: skip to Step 6

# Build evidence request from symptoms
symptom_summary = symptoms or gap descriptions, concatenated

Bash({
  command: 'maestro delegate "PURPOSE: Gather codebase evidence related to a bug investigation
TASK: Trace call chains for affected functions | Find recent changes to related files | Identify error handling gaps | Check for similar patterns elsewhere
MODE: analysis
CONTEXT: @${affected_files or scoped_path}/**/*
EXPECTED: JSON { call_chains: [{ entry, chain: [file:line...] }], recent_changes: [{ file, commits: [...] }], error_gaps: [{ file, line, description }], similar_patterns: [{ file, line, description }] }
CONSTRAINTS: Focus on code paths related to the symptoms | Max 20 entries per category

Symptoms: ${symptom_summary}
" --role explore --mode analysis',
  run_in_background: true
})
```

**On callback:**
```
cli_evidence = maestro delegate output <id>
Parse and append to evidence.ndjson with type: "cli-exploration"
Pass cli_evidence as supplementary_context to debug agent prompts in Step 5/6
```

---

### Step 6: Spawn Single Debug Agent (sequential mode) — MANDATORY, NOT SUBSTITUTABLE

Spawn agent (`run_in_background: false`):

- **Input**: slug, description, symptoms. `symptoms_prefilled: {true if from UAT}`, goal: `find_and_fix`.
- **Process**: form hypotheses, test each, log NDJSON evidence, update understanding.md.
- **Return**: `## ROOT CAUSE FOUND` | `## CHECKPOINT REACHED` | `## INVESTIGATION INCONCLUSIVE`
- **Files**: `{$DEBUG_DIR}/understanding.md`, `{$DEBUG_DIR}/evidence.ndjson`

---

### Step 7: Collect and Unify Results

Build unified diagnosis from all agent results:
```json
{
  "session_id": "{debug session ID}",
  "completed_at": "{ISO timestamp}",
  "clusters": [
    {
      "name": "{cluster_name}",
      "gaps": [
        {
          "test_id": "T-003",
          "root_cause": "...",
          "fix_direction": "...",
          "affected_files": ["src/components/Comments.tsx:42"],
          "confidence": { "overall": 0.78, "dimensions": {} }
        }
      ]
    }
  ],
  "confidence": {}
}
```

### Step 7.0: Debug Confidence Scoring

Dimensions (4): hypothesis_quality, evidence_completeness, root_cause_isolation, fix_confidence. Factors (weights): evidence_depth(.30), evidence_strength(.25), coverage_breadth(.20), reproduction(.15), consistency(.10). Map to legacy levels: <40% = low, 40-70% = medium, >70% = high.

Quality mechanisms: Pressure Pass (before Step 9) — cross-check confirmed vs refuted hypotheses. Devil's Advocate — root_cause_isolation > 0.7 → "根因在更深层？". Stall Detection — no new evidence + delta < 5% for 2 continuations → "调查可能停滞".

Readiness Gate (blocks Step 9): evidence_completeness ≥ 40% | pressure pass done | no contradicting evidence | fix_direction has specific files. If blocked → AskUserQuestion: 补充调查 or 忽略风险并确认. Append confidence table to understanding.md.

### Step 7.1: Update Issues with Diagnosis

For each diagnosed gap with `issue_id`, update in `.workflow/issues/issues.jsonl`:
- Set `status: "diagnosed"`, `context.suggested_fix: fix_direction`, `context.notes: root_cause`
- Append to `issue_history`: `{ from: previous_status, to: "diagnosed", changed_at: now(), actor: "debug-agent" }`

---

### Step 8: Update UAT (if --from-uat)

Skip if standalone. For each diagnosed gap, update uat.md Gaps:
```yaml
- test: T-003
  truth: "User can reply to comments"
  status: failed
  reason: "User reported: clicking reply does nothing"
  severity: major
  root_cause: "Reply handler not wired to API endpoint"
  fix_direction: "Connect onReply to POST /api/comments/{id}/reply"
  affected_files: ["src/components/Comments.tsx:42", "src/api/comments.ts:78"]
```

---

### Step 9: Handle Root Cause Found

```
------------------------------------------------------------
  ROOT CAUSE IDENTIFIED
------------------------------------------------------------

{root cause description}

Evidence:
{key evidence points with file:line references}

Recommended fix:
{fix recommendation}

------------------------------------------------------------
Options:
1. Fix now -- Skill({ skill: "maestro-quick", args: "apply fix" })
2. Plan fix -- Skill({ skill: "maestro-plan", args: "{phase} --gaps" })
3. Manual fix -- investigate/fix yourself
------------------------------------------------------------
```

---

### Step 10: Handle Checkpoint

Present checkpoint to user via AskUserQuestion. Input → spawn continuation agent. Pause → save state, exit.

---

### Step 11: Handle Inconclusive

Display what was checked/eliminated. Offer: 1) Continue (fresh agent with prior state) 2) Add context 3) Manual investigation.

---

### Step 12: Spawn Continuation Agent

Load prior state (understanding.md + evidence.ndjson) + user checkpoint response. Handle return same as Step 6.

---

**GATE Step 12→13**: Glob `{$DEBUG_DIR}/understanding.md` AND `{$DEBUG_DIR}/evidence.ndjson` MUST exist before Step 13 report; BLOCKED if missing.

### Step 13: Report

```
=== DEBUG SESSION ===
Mode:        {standalone | from-uat | parallel}
Target:      {issue or phase}

Clusters:    {cluster_count} investigated
Gaps:        {total_gaps} total
  Diagnosed: {diagnosed_count} root causes found
  Uncertain: {uncertain_count} need more investigation

Files:
  {debug_dir}/understanding.md (or understanding-{cluster}.md per cluster)
  {debug_dir}/evidence.ndjson (or evidence-{cluster}.ndjson per cluster)

UAT Updated: {yes/no} ({uat_path} if yes)

Next steps:
  {suggested_next_command}
```

**Next step routing:**

| Result | Suggestion |
|--------|------------|
| All root causes found | Skill({ skill: "maestro-quick", args: "apply fixes" }) or Skill({ skill: "maestro-plan", args: "--gaps" }) |
| Some inconclusive | Resume with more context or manual investigation |
| From UAT, all diagnosed | Skill({ skill: "quality-test", args: "{phase} --auto-fix" }) to trigger gap-fix loop |

---

## Evidence Format

**evidence.ndjson** — one JSON object per line, append-only:

```json
{"timestamp":"2026-03-14T10:30:00+08:00","hypothesis":"JWT token not refreshed on 401","action":"grep for 401 handler","result":"Found handler but no refresh call","conclusion":"confirmed"}
```

---

## Understanding Template

```markdown
# Debug: {issue slug}

## Status
{investigating | checkpoint | resolved | inconclusive}

## Issue
{original issue description}

## Symptoms
- Expected: {expected}
- Actual: {actual}
- Errors: {errors}
- Timeline: {timeline}
- Reproduction: {steps}

## Hypotheses

### H1: {hypothesis} [CONFIRMED/REFUTED/TESTING]
Evidence: {summary of evidence}

### H2: {hypothesis} [CONFIRMED/REFUTED/TESTING]
Evidence: {summary}

## Root Cause
{filled when found}

## Fix
{filled when determined}
```
