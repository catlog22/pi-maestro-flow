---
name: maestro-session-seal
description: "Seal current session with knowledge candidate review and DAG progression Arguments: [--session <session_id>] [-y] [--skip-knowledge]"
allowed-tools: Read Write Edit Bash Glob Grep teammate maestro observe
disable-model-invocation: true
session-mode: none
---

<teammate_contract>

- `background: false` is the default. Use foreground dispatch whenever the result determines the current answer or next action.
- Use `background: true` only for independent work. If this turn must consume a background result, call `observe` exactly once with `action: "wait"` and a bounded timeout before continuing; never continue independently while the result is pending.
- Otherwise end the turn and wait for the automatic `teammate-complete` notification. Do not rely on `SendMessage`, `team_msg`, or hook callbacks as completion signals.
- Never silently ignore an unfinished dispatch.

</teammate_contract>

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
Seal a completed session: verify all Runs are sealed, review the durable knowledge candidate backlog, mark the Session as sealed, and recommend the next dep-ready Session from the DAG.

Run completion already stages accepted decisions, locked constraints, and explicit `maestro knowledge stage` entries. This command reviews those receipts; it does not re-extract the same artifacts or write project knowledge through a second path.
</purpose>

<context>
$ARGUMENTS -- optional session ID and flags.

**Flags:**
| Flag | Effect | Default |
|------|--------|---------|
| `--session <id>` | Target session (slug or full ID) | `active_session_id` |
| `-y` / `--yes` | Auto mode — skip confirmations | false |
| `--skip-knowledge` | Leave candidate backlog pending and continue sealing | false |
</context>

<execution>

### Step 1: Session Readiness Check

Note: maestro-next suggests session-seal when 'Tests green + active session'. This command additionally requires verify/review gates (or W002 if absent). Both conditions should be met for clean seal.

1. Resolve target session from `--session` flag or `active_session_id`
2. Read `session.json` — verify status is `running` or `paused`
3. Verify no active runs (all runs completed or sealed)
4. Verify critical gates passed (entry/exit gates from last verify/review run). If no verify/review run exists in this session, treat gate check as not applicable (pass) but emit W002.
5. If not ready → display blockers, suggest next action (e.g., "run the `review` step first")

### Step 2: Knowledge Reconciliation

1. Run `maestro knowledge review {session_id} --json`. Treat its Run ledgers, reconciliation policies, diversified matches, and candidate IDs as authoritative; do not rescan outputs to recreate candidates. Use `--refresh` only when the review reports missing or stale source receipts.
2. Explain signal semantics when relevant: search/injection is exposure only; explicit loads are consumed; `cited`, `validated`, and `contradicted` are explicit Run relations.
3. Report exact/semantic duplicates, related/extends candidates, potential conflicts, supersession candidates, missing receipts, and promotion eligibility separately. Exact duplicates are suppressed automatically; unresolved `review_required` candidates cannot be promoted.
4. If `--skip-knowledge`, report the pending/promoting/review-required/suppressed counts and continue. The backlog and reconciliation receipts remain durable after seal.
5. Otherwise resolve review-required candidates before promotion with `maestro knowledge review {session_id} --resolve <candidate-id> --as duplicate|related|conflict|supersede|unique [--target <knowledge-id>] --reason "<reason>"`. A target must come from that candidate's evidence-backed matches.
6. Present eligible pending candidates via `[@ask] user prompt`:
   ```
   question: "以下知识候选项值得晋升到项目知识库吗？"
   options:
     - "晋升全部合格项" (promote all eligible candidates)
     - "逐个选择" (review each candidate)
     - "暂不晋升" (leave backlog pending)
   ```
7. Promote only through the receipt-aware CLI:
   - Bulk selection → `maestro knowledge promote {session_id} --all`
   - Explicit selection → repeat `maestro knowledge promote {session_id} --candidate <candidate-id>` for each selection (comma-separated compatibility remains supported)
   - `-y` may run `--all`, which promotes all eligible candidates (observed-only emits a warning) and skips review-required and suppressed candidates. It MUST NOT auto-resolve a candidate without explicit user selection.
8. For a replacement candidate, confirm `--as supersede` and then promote it; promotion creates the successor and links the evolution chain. For coexisting valid rules, confirm `related` or `conflict` as appropriate. Never direct-write a candidate that was already promoted successfully.

### Step 3: Seal Session

1. Call `maestro session seal {session_id}` (`--json` emits the canonical machine envelope)
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
Knowledge: {promoted_count} promoted, {pending_count} pending, {review_required_count} review required, {suppressed_count} suppressed
Next dep-ready: {next_slug or "none (DAG complete)"}
--- STATUS ---
Status: DONE
```

### Next-step routing

| Condition | Suggestion |
|-----------|-----------|
| Next session activated | `maestro run start "{goal}" --cmd analyze --session {next-slug} --platform pi --workflow-root .` |
| Knowledge candidates pending | `maestro knowledge review {session_id}` |
| Knowledge health review needed | `/maestro-knowledge audit` |
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
| W003 | warning | Candidate backlog left pending | Review later with `maestro knowledge review {session_id}` |
| W004 | warning | Reconciliation review remains unresolved | Seal may continue; promotion stays blocked until `maestro knowledge review --resolve` |
</error_codes>

<success_criteria>
- [ ] Target session resolved and verified as ready for seal
- [ ] Knowledge candidate receipt/backlog and evidence loaded via `maestro knowledge review`
- [ ] Reconciliation dispositions reviewed; unresolved items were explicitly retained or resolved
- [ ] User reviewed candidates, or pending backlog was reported and deliberately retained
- [ ] Selected knowledge promoted only through `maestro knowledge promote`
- [ ] Session sealed via CLI (`session.json.lifecycle.sealed_at` written)
- [ ] `state.json.sessions[].status` updated to `sealed`
- [ ] Dep-ready sessions identified and activation offered to user
</success_criteria>
