---
name: maestro-session-seal
description: Seal current session with knowledge extraction and DAG progression
argument-hint: "[--session <session_id>] [-y] [--skip-knowledge]"
allowed-tools:
  - AskUserQuestion
  - Bash
  - Edit
  - Glob
  - Grep
  - goal
  - Read
  - Write
  - teammate
  - todo
session-mode: run
contract: 
---

<required_reading>
@~/.maestro/workflows/run-mode.md
</required_reading>

<purpose>
Seal a completed session: verify all runs are done, extract knowledge (specs/knowhow promotion), mark session as sealed, and recommend the next dep-ready session from the DAG.

Replaces the deprecated `maestro-milestone-complete` with session-level semantics and integrated knowledge capture.
</purpose>

<host_mirror>

**镜像协议**（状态对账由插件自动完成，LLM 只保留两个语义动作）：

- 步进仅调用 `todo({ action: "next" })`；完成时让 agent loop 自然结束，由 Goal verifier 自动裁决。
- 禁止手工创建或更新 Goal/Todo 镜像，禁止直接写 `state.json`、`session.json`、`run.json`、`artifacts.json`。
- Session seal 与 DAG 推进必须调用 Maestro CLI；宿主镜像由 bridge 在 CLI 成功后对账。
- 压缩恢复后先执行 `maestro run brief <run-id>`，再继续 active Run。

</host_mirror>

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

1. Resolve target session from `--session` flag or `active_session_id`
2. Read `session.json` — verify status is `running` or `paused`
3. Verify no active runs (all runs completed or sealed)
4. Verify critical gates passed (entry/exit gates from last verify/review run)
5. If not ready → display blockers, suggest next action (e.g., "run the `review` step first")

### Step 2: Knowledge Extraction

Skip if `--skip-knowledge`. Otherwise:

1. **Scan session artifacts** — read all sealed run outputs across the session
2. **Extract candidates**:
   - Decisions with `status: accepted` from `runs/*/run.json.handoff.decisions[]` → spec candidates
   - Patterns/recipes discovered during execution → knowhow candidates
   - Risks that materialized or were mitigated → learning candidates
3. **Present to user** via `AskUserQuestion`:
   ```
   question: "以下知识候选项值得持久化吗？"
   options:
     - "全部保存" (save all candidates as specs/knowhow)
     - "逐个选择" (review each candidate)
     - "跳过" (no knowledge extraction)
   ```
4. **Persist** selected items:
   - Specs → `Skill("spec", "add ...")`
   - Knowhow → `Skill("manage", "knowledge capture ...")`
   - Keep promoted IDs in the seal summary input; do not edit `session.json` directly. The canonical CLI records them when supported.

### Step 3: Seal Session

1. Call `maestro run seal-session {session_id}`
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
| Next session activated | step `analyze` (`maestro run prepare analyze` + `maestro run create analyze -- --session {next-slug}`) |
| DAG complete (all sealed) | `/manage status` |
| Knowledge review needed | `/manage knowledge audit` |
</completion>

<error_codes>
| Code | Severity | Condition | Recovery |
|------|----------|-----------|----------|
| E001 | error | Session not found | Check `state.json.sessions[]` |
| E002 | error | Session already sealed | Nothing to do |
| E003 | error | Active runs exist | Complete or seal pending runs first |
| E004 | error | Critical gates failed | Run verify/review to resolve |
| W001 | warning | No knowledge candidates found | Proceed to seal |
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
