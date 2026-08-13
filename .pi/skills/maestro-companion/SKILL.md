---
name: maestro-companion
description: "Quick execution for small tasks — minimal run lifecycle (start + done) with evidence recording. Full LLM capability, scoped to mechanically clear tasks. Arguments: <intent> [-y]"
allowed-tools: Read Write Edit Bash Glob Grep teammate observe maestro
disable-model-invocation: false
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

If any required file above was not expanded into context by the host, or its content is no longer in context, Read it explicitly before executing any step.

<purpose>
Minimal-run execution channel. Full LLM capability with one bounded Execution/Run and evidence appended to `{run_dir}/evidence/companion-log.md`.

Use when:
- Intent is mechanically clear (no design decisions needed; file count irrelevant)
- No typed artifact consumed by downstream steps
- No gate/verdict needed for lifecycle tracking

Lightweight self-check (all must hold):
- Intent specifies a concrete, bounded action with named target (file, function, error message)
- No typed artifact consumed by downstream steps
- No gate/verdict for lifecycle tracking
- Single concern, no multi-phase span
If self-check fails mid-execution, stop and suggest `/maestro-next` for re-routing.
</purpose>

<context>
$ARGUMENTS — intent text + optional flags.

| Flag | Effect |
|------|--------|
| `-y` | Skip confirmation, execute directly |

Mode detection: intent → execute | empty → [@ask] user prompt: request intent text; if still empty → display usage hint and exit

Knowledge utilities (note/log/promote) are available via `/maestro-knowledge`.
</context>

<invariants>
1. Execute mode follows the exact Session identity -> bounded Execution -> Run lifecycle in `run-mode.md`.
2. Evidence is append-only, non-formal (never enters gates or artifact registry)
3. No auto-orchestration — executes directly, never creates chains
</invariants>

<flow>

## Execute (default)

Linear: create identity/Execution/Run -> explore -> confirm -> do -> complete Run -> seal Execution.

### 1. Create

Follow the self-start flow in `run-mode.md`: negotiate capabilities, create or resolve the explicit Session identity, start the bounded Execution with the complete audited acquisition option set, then invoke the complete fenced `maestro run start --platform pi companion` option set with `--intent "<intent>"` and `--arg "<intent>"`. Intent is Session metadata only; `--arg` supplies the required command arguments. Do not use a Session lifecycle alias or omit the Execution locator, revision, or private lease claim.

Init `{run_dir}/evidence/companion-log.md`:
```markdown
# Companion Log: {intent}
> run_id: {run_id} | session: {session_id}

## Evidence
```

### 2. Explore

Locate targets and gather evidence before touching anything. Methods (pick what fits):

- `teammate({ agent: "explorer", tasks: [{ prompt: "FIND: ...\\nSCOPE: ..." }] })` — codebase search
- `maestro search "<keywords>" --type spec --type knowhow` — knowledge recall
- Agent (subagent) — multi-file analysis, cross-reference, pattern discovery
- Direct Read/Grep/Glob — known targets, quick lookups

Record findings under `## Evidence`:
```markdown
## Evidence
- {file:line — what was found}
- {spec/knowhow entries loaded, or "none"}
- {subagent conclusions if used}
```

### 3. Confirm

Before executing, verify evidence is sufficient:
- Target files/locations identified?
- Change scope clear (what to modify, what to leave alone)?
- No ambiguity requiring design decisions?

If insufficient → continue exploring or ask user. If `-y` → skip user confirmation interaction, but still perform evidence sufficiency self-check. If critical targets are unlocated, continue exploring (without asking user); only the 'ask user' branch is skipped.

### 4. Do

Execute the task. After each meaningful action, append under `## Work Log`:

```markdown
### {HH:MM} — {summary}
{outcome, files touched if any}
```

Rules: batch trivial reads; 1-5 lines per entry; focus on outcome not process.

### 5. Seal

Append outcome:
```markdown
## Outcome
**Status:** done | partial
**Summary:** {1-2 sentences}
**Files:** {modified/created, or "none"}
```

Before completion, put accepted decisions/locked constraints in `report.md`. If a reusable recipe or pitfall emerged, stage it now:

```bash
maestro knowledge stage knowhow "<title>" "<content>" --run <run_id>
# Then use the complete fenced `maestro run complete` and `maestro execution seal`
# commands from run-mode.md with the current locator, fence, and private claim.
```

Display: `Companion done. Run: {run_id} | Evidence: {path}`

If the completion receipt contains candidate IDs, display its `review_command`. Do not persist the same insight again through `/maestro-spec` or `/maestro-knowhow`.

If execution revealed the task requires multi-phase audit/diagnosis (e.g., root cause unknown, >3 files need coordinated changes), suggest: `/maestro-odyssey "<scope>" --mode debug|improve` for re-planning.

</flow>

<error_codes>
| Code | Severity | Condition | Recovery |
|------|----------|-----------|----------|
| E001 | error | `session start` failed (CLI unavailable, invalid args) | Check maestro CLI installation |
| E003 | error | Evidence log creation failed | Check run_dir permissions |
| W001 | warning | Explore tools unavailable (teammate({ agent: "explorer" })/search) | Degrade to direct Read/Grep |
</error_codes>
