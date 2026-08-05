---
name: maestro-merge
description: "Merge session worktree branch back to main Arguments: --session <session_id> [--force] [--dry-run] [--no-cleanup] [--continue]"
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

<purpose>
Merge a session worktree branch back into main, sync Run artifacts, and reconcile the artifact registry.
Two-step: git merge first, artifact sync second (only after git succeeds).
</purpose>

<context>
$ARGUMENTS -- session ID (or slug) and optional flags.

Terminology: this command uses 'session' throughout. The underlying workflow file (merge.md) may use 'milestone' as a legacy alias for 'session'. Treat them as equivalent: `--session` maps to workflow's `-m`, `state.json.sessions[]` maps to `state.json.milestones[]`.

Flags (`--session`, `--force`, `--dry-run`, `--no-cleanup`, `--continue`), merge sequence, artifact sync detail, and conflict handling are defined in workflow `merge.md`.
</context>

<execution>
Follow '~/.maestro/workflows/merge.md' completely.

--dry-run short-circuit: execute GATE 1 health check only, display merge preview (files that would change, artifact sync plan), then EXIT before rebase/merge. GATE 2 and GATE 3 are not reached.

### Gates (MANDATORY, BLOCKING)

**GATE 1: Pre-merge → Git Merge**
- REQUIRED: Registry health check completed (stale entries cleaned or flagged).
- REQUIRED: Pre-merge rebase successful (worktree has latest main).
- REQUIRED: worktree state.json schema version matches main state.json version. If mismatch → W004 (suggest running maestro-update in worktree first).
- BLOCKED if rebase has conflicts: resolve in worktree first (W003).

Note on --force: skips user confirmation for incomplete phase artifacts (W002). Does NOT skip conflict resolution or rebase. Specifically: GATE 1 and GATE 2 are unaffected by --force; GATE 3's artifact completeness check uses --force to bypass the W002 confirmation.

**GATE 2: Git Merge → Artifact Sync**
- REQUIRED: Git merge completed without conflicts (or conflicts resolved via --continue).
- BLOCKED if: merge has unresolved conflicts — do NOT sync artifacts until git merge succeeds (prevents partial state corruption).

**GATE 3: Artifact Sync → Completion**
- REQUIRED: All Run artifacts synced to main `sessions/{session_id}/runs/`.
- REQUIRED: Artifact registry reconciled (worktree entries merged into main).
- REQUIRED: Worktree cleaned up OR `--no-cleanup` flag present.
- BLOCKED if missing: artifacts not synced or registry not reconciled — main worktree would have incomplete state.

</execution>

<completion>
### Knowledge inquiry

After successful merge, use `[@ask] user prompt` to confirm knowledge persistence:

```
question: "Merge 完成。是否记录本次工作经验教训？"
options:
  - label: "记录经验"
    description: "通过 maestro-spec add 持久化此次工作的关键洞察"
  - label: "跳过"
    description: "不记录，直接完成"
```

User selects "记录经验" → prompt for title/insight, then recommend `/maestro-spec add learning "<title>" "<insight>" --keywords <kw1>,<kw2> --description "<summary>"`. User selects "跳过" → proceed to next-step routing.

### Next-step routing

| Condition | Suggestion |
|-----------|-----------|
| Next dep-ready session | `maestro run start "{goal}" --cmd analyze --session {next-dep-ready-slug} --platform pi --workflow-root .` |
</completion>

<error_codes>
| Code | Severity | Condition | Recovery |
|------|----------|-----------|----------|
| E001 | error | Running inside a worktree | Run from main worktree |
| E002 | error | No worktree registry found | Nothing to merge |
| E003 | error | --continue but no merge state | Start fresh merge |
| E004 | error | No session ID provided | Provide `--session <session_id>` |
| W001 | warning | Stale registry entries found | Auto-cleaned |
| W002 | warning | Incomplete artifacts (without --force) | Confirm or use --force |
| W003 | warning | Conflict pulling main into worktree | Resolve in worktree first |
| W004 | warning | Schema version mismatch between worktree and main | Run maestro-update in worktree before merge |
</error_codes>

<success_criteria>
- [ ] Registry health check passed (stale entries cleaned)
- [ ] Pre-merge rebase successful (worktree has latest main)
- [ ] Git merge completed without conflicts (or conflicts resolved via --continue)
- [ ] All Run artifacts synced to main `sessions/{session_id}/runs/`
- [ ] Artifact registry reconciled (worktree entries merged into main)
- [ ] Session lifecycle updated (forked_from cleared)
- [ ] Worktree removed and branch deleted (unless --no-cleanup)
- [ ] `worktrees.json` registry updated (entry removed)
- [ ] `worktree-scope.json` removed from worktree (even with --no-cleanup, to prevent stale scope detection)
</success_criteria>
