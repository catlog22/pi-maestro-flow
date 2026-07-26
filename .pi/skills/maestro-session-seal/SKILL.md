---
name: maestro-session-seal
description: "Seal current session with knowledge extraction and DAG progression Arguments: [--session <session_id>] [-y] [--skip-knowledge]"
allowed-tools: Read Write Edit Bash Glob Grep teammate maestro
disable-model-invocation: true
---

<required_reading>
~/.maestro/workflows/run-mode.md
</required_reading>

<host_mirror>

Pi mirrors canonical Session/Run state automatically:

- Advance only with `todo({ action: "next" })`; do not create or update mirror tasks manually.
- Goal completion is derived from terminal chain state and clean gates.
- After compaction, reattach through the current Run's `brief.command`.

</host_mirror>

<purpose>
Seal a completed session: verify all runs are done, extract knowledge (specs/knowhow promotion), mark session as sealed, and recommend the next dep-ready session from the DAG.

Replaces the deprecated `maestro-milestone-complete` with session-level semantics and integrated knowledge capture.
</purpose>

<context>
$ARGUMENTS -- optional session ID and flags.

**Flags:**
| Flag | Effect | Default |
|------|--------|---------|
| `--session <id>` | Target session (slug or full ID) | `active_session_id` |
| `-y` / `--yes` | Auto mode — skip confirmations | false |
| `--skip-knowledge` | Skip knowledge extraction step | false |
</context>

<execution>

### Step 1: Session Readiness Check

Note: maestro-next suggests session-seal when 'Tests green + active session'. This command additionally requires verify/review gates (or W002 if absent). Both conditions should be met for clean seal.

1. Resolve target session from `--session` flag or `active_session_id`
2. Read `session.json` — verify status is `running` or `paused`
3. Verify no active runs (all runs completed or sealed)
4. Verify critical gates passed (entry/exit gates from last verify/review run). If no verify/review run exists in this session, treat gate check as not applicable (pass) but emit W002.
5. If not ready → display blockers, suggest next action (e.g., "run the `review` step first")

### Step 2: Knowledge Extraction

This step is a session-scoped lightweight knowledge extraction. For comprehensive artifact-based extraction, use `/maestro-knowledge harvest --session {session_id}`. `--skip-knowledge` can be compensated later via harvest.

Skip if `--skip-knowledge`. Otherwise:

1. **Scan session artifacts** — read all sealed run outputs across the session. Per-run error handling: if a run's output files are missing or run.json is malformed, skip that run with W003 and continue extraction from remaining runs.
2. **Extract candidates**:
   - Decisions with `status: accepted` from `runs/*/run.json.handoff.decisions[]` → spec candidates
   - Patterns/recipes discovered during execution → knowhow candidates
   - Risks that materialized or were mitigated → learning candidates
3. **Present to user** via `[@ask] user prompt`:
   ```
   question: "以下知识候选项值得持久化吗？"
   options:
     - "全部保存" (save all candidates as specs/knowhow)
     - "逐个选择" (review each candidate)
     - "跳过" (no knowledge extraction)
   ```
4. **Persist** selected items:
   - Specs → recommend `/maestro-spec add ...`
   - Knowhow → recommend `/maestro-knowledge harvest --session {session_id}` for extraction, then `/maestro-knowhow capture` for manual recording of extracted insights
   - Use the Runtime CLI to persist promoted IDs in `session.json.lifecycle.promoted[]`（前缀区分 spec:/knowhow:）

### Step 3: Seal Session

1. Call `maestro session seal {session_id}`
2. CLI writes `session.json.lifecycle.sealed_at` and `seal_summary`
3. CLI updates `state.json.sessions[].status` to `sealed`

### Step 4: DAG Progression

1. Read `state.json.sessions[]` — find sessions that became dep-ready (all `depends_on` sealed)
2. If dep-ready sessions exist:
   ```
   question: "Session {slug} 已 sealed。推荐激活下一个 session: {next-slug}，是否确认？"
   options:
     - "激活推荐 session"
     - "选择其他 session"
     - "暂不激活"
   ```
3. If confirmed → set `active_session_id` to selected session

</execution>

<completion>
```
=== SESSION SEALED ===
Session: {session_id}
Knowledge: {N} specs, {M} knowhow items promoted
Next dep-ready: {next_slug or "none (DAG complete)"}
--- STATUS ---
Status: DONE
```

### Next-step routing

| Condition | Suggestion |
|-----------|-----------|
| Next session activated | `maestro run start "{goal}" --cmd analyze --session {next-slug} --platform pi --workflow-root .` |
| Knowledge review needed | `/maestro-knowledge audit` |
</completion>

<error_codes>
| Code | Severity | Condition | Recovery |
|------|----------|-----------|----------|
| E001 | error | Session not found | Check `state.json.sessions[]` |
| E002 | error | Session already sealed | Nothing to do |
| E003 | error | Active runs exist | Complete or seal pending runs first |
| E004 | error | Critical gates failed | Run verify/review to resolve |
| W001 | warning | No knowledge candidates found | Proceed to seal |
| W002 | warning | No verify/review run in session — gate check skipped | Consider running verify before seal |
| W003 | warning | Some run outputs unreadable/malformed, skipped during extraction | Check run integrity |
</error_codes>

<success_criteria>
- [ ] Target session resolved and verified as ready for seal
- [ ] Knowledge candidates extracted from session evidence/artifacts
- [ ] User reviewed and confirmed knowledge items (or skipped)
- [ ] Selected knowledge promoted to project-level specs/knowhow
- [ ] Session sealed via CLI (`session.json.lifecycle.sealed_at` written)
- [ ] `state.json.sessions[].status` updated to `sealed`
- [ ] Dep-ready sessions identified and activation offered to user
</success_criteria>
