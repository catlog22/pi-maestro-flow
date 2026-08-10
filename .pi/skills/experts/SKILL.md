---
name: experts
description: "Experts-bound Maestro campaign — force mode=experts and drive the canonical Session/Run loop. Arguments: <intent|on|off|status|roster|waiting|harvest> [-y] [-c] [--amend] [--dry-run]"
allowed-tools: Read Write Edit Bash Glob Grep teammate maestro observe
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
~/.maestro/workflows/orchestrator-run-loop.md
~/.maestro/prepare/maestro.md
</required_reading>

<host_mirror>

Pi mirrors canonical Session/Run state automatically:

- Advance only with `todo({ action: "next" })`; do not create or update mirror tasks manually.
- Goal completion is derived from terminal chain state and clean gates.
- After compaction, reattach through the current Run's `brief.command`.

</host_mirror>

<deferred_reading>
- [experts-bind.md](refs/experts-bind.md) — read for the D3 birth packet / waiting rules before the first stage dispatch
</deferred_reading>

<purpose>
Experts-bound Maestro campaign: force `setMode("experts")` for the working directory and then run the same Session/Run loop as `/maestro`. Every stage dispatch goes through a teammate carrying a `taskType` resolved from stagePolicies before keyword triage; the Lead never implements business code itself (P5 hard gate). This skill is the single entry point for any work that should run in experts mode.
</purpose>

<pi_context_contract>

- Consume the injected Topic Session resolution and ReuseAssessment as read-only routing evidence.
- Accept upstream only from same-Session sealed outputs.
- Resolve each `argument_requirements` entry through `required`, `missing`, `type`, `source`, optional `default`, and `question`.
- Treat the birth packet as compact routing; load the execution protocol from `brief.command`.
- Under experts mode the stage is auto-injected from session.json (P4.1) — never set MAESTRO_STAGE manually.

</pi_context_contract>

<cli_surface>

The Maestro campaign itself uses only the unified Session/Run surface (identical to `/maestro`):

- Single step: `maestro run start "<intent>" --cmd <step> --arg "<step input>" --platform pi --workflow-root .`
- Simple command chain: `maestro run start --platform pi "<intent>" --chain analyze plan execute --no-dispatch --workflow-root .`
- Completion: `maestro run done [run_id] --verdict done|done-with-concerns|needs-retry|blocked --workflow-root .`

Mode control is in-process (no CLI subprocess): call `setMode("experts"|"normal", cwd)` and render `formatExpertsStatusPanel(cwd)` from `packages/pi-maestro-teammate/src/experts-mode/`. The `/experts` command wraps these calls plus the panel views — subcommands `on|off|status|roster|waiting|harvest` (default `status`) — and shows a read-only TUI overlay (Esc/q/Enter close) when the interactive UI is available, falling back to a notify.

</cli_surface>

<interface>
Only these user flags are accepted (same semantics as `/maestro`):

- `-y` — skip all confirmation/clarification interactions, use default choices. Never bypasses high-risk classification, confidence <60, ambiguity requiring user input, failed gates, or drift escalation.
- `-c` — continue the unique live compatible Session.
- `--amend` — amend that Session's goal; remaining text is the change request.
- `--dry-run` — show chain without executing.

Subcommands (mode panel surface):

- `on` — force `setMode("experts", cwd)` then print the status panel.
- `off` — `setMode("normal", cwd)` then print the status panel.
- `status` — print `formatExpertsStatusPanel(cwd)` (default when no subcommand).
- `roster` — list project roster roles (role ≠ model; each role has agent + default taskType).
- `waiting` — leaderWaiting state + in-flight expert units.
- `harvest` — pending P7 knowhow suggestions (never auto-promote).

All other text is intent. Unknown flags are not silently reinterpreted.
</interface>

<invariants>
1. **Session is the source of truth** — session.json.orchestration owns links, goals, decisions; a Run is a single execution attempt.
2. **One chain** — every task uses the same Session/Run protocol as `/maestro`; no experts-private Session type.
3. **Runtime owns mutation** — the prompt never writes session.json/run.json and never auto-uses admin chain commands.
4. **Verdict advances** — execution steps advance only through `session done --verdict`; decision steps only through `session decide`.
5. **Waiting forbids claiming done** — while `leaderWaiting` is true (activeCount > 0) the Lead must not report done, must not start dependent synthesis, and must not spam re-dispatches; consume `teammate-complete`/settle first.
6. **Lead P5 allowlist only** — the Lead writes only report.md, outputs/**, .workflow/**, notes/** (plus rules allowlist); business write/edit/bash is delegated via teammate.
7. **Role ≠ model** — agents are role names (explorer, general-executor, …); routing owns models and the panel/records never render model ids.
8. **D3 session next does NOT silent teammate** — advancing to a new stage injects the stage birth plan only; the Lead must explicitly call teammate with the stage pipeline (taskType from stagePolicies).
9. **Stage pipeline beats triage** — stagePolicies fill taskType before keyword triage; explicit taskType still wins.
</invariants>

<state_machine>

<states>
S_PARSE — parse intent, flags and subcommand
S_STATUS — render `formatExpertsStatusPanel` (status / default)
S_MODE — switch mode (`on` / `off` via setMode)
S_ROSTER — show roster roles (role ≠ model)
S_WAITING — show leaderWaiting + in-flight experts
S_HARVEST — show pending P7 knowledge suggestions
S_CONTINUE — locate the unique live Session
S_AMEND — audited goal amendment
S_CLASSIFY — select the smallest sufficient initial chain
S_CREATE — create via `session create --chain-file`
S_CONFIRM — confirm classification unless `-y`
S_RUN_LOOP — execute `orchestrator-run-loop.md`
S_FALLBACK — request missing intent or disambiguation
</states>

<transitions>
S_PARSE:
  → S_STATUS WHEN: subcommand is status (or none) / `--dry-run` of mode
  → S_MODE WHEN: subcommand is on|off
  → S_ROSTER WHEN: subcommand is roster
  → S_WAITING WHEN: subcommand is waiting
  → S_HARVEST WHEN: subcommand is harvest
  → S_AMEND WHEN: `--amend`
  → S_CONTINUE WHEN: `-c`
  → S_CLASSIFY WHEN: intent present
  → S_FALLBACK OTHERWISE

S_CONTINUE:
  → S_RUN_LOOP WHEN: exactly one live compatible Session
  → S_FALLBACK WHEN: paused (suggest /maestro-ralph -c for audited recovery), none or multiple

S_AMEND:
  → S_RUN_LOOP WHEN: shared amend protocol committed
  → END WHEN: cancelled or blocked

S_CLASSIFY:
  → S_RUN_LOOP WHEN: existing compatible Session found (do not rebuild)
  → S_CREATE WHEN: narrow/single-step chain
  → S_FALLBACK WHEN: confidence < 60

S_CREATE → S_RUN_LOOP WHEN: `-y` AND risk ≠ high AND confidence ≥ 60
S_CREATE → S_CONFIRM WHEN: `-y` AND (risk == high OR confidence < 60)
S_CREATE → S_CONFIRM OTHERWISE
S_CREATE → S_FALLBACK WHEN: creation fails (delete temp file, report error)
S_CONFIRM → S_RUN_LOOP WHEN: confirmed
S_CONFIRM → S_FALLBACK WHEN: cancelled

S_STATUS → END
S_MODE → S_STATUS (print panel after switching)
S_ROSTER → END
S_WAITING → END
S_HARVEST → END
</transitions>

<actions>

### A_MODE

Call `setMode("experts" | "normal", cwd)` (in-process library, no subprocess). Then print `formatExpertsStatusPanel(cwd)` so the switch is observable. Mode persists in `.experts-mode.json` under cwd; the panel's Mode line confirms it.

### A_CLASSIFY

Read deferred `maestro.md`. Record matched evidence, excluded alternatives and confidence before creation. Minimum chain rules are identical to `/maestro`:

| Intent evidence | Initial chain |
|---|---|
| narrow fix/change | analyze → plan → execute → review/test as required |
| broad rewrite/migration | analyze-macro → scope decision → plan/roadmap path |
| brainstorm/explore | brainstorm, then only Skill-proposed continuation |
| formal specification | blueprint → plan path |
| existing compatible Session | do not rebuild; enter shared loop |

Roadmap is inferred only for multi-release evidence. Quality depth follows project specs, UI evidence needs frontend verification, and every executable command is resolved by Run Runtime.

### A_CREATE

Assemble and create per `prepare/maestro.md` §3–§4. Same policy as `/maestro`: no formal decision nodes from this skill; quality/goal/scope checks are Skill steps that own a Run and may return a proposal. For narrow/single-step chains generate a minimal implicit boundary_contract. Do not inline unescaped JSON.

### A_BIRTH (D3)

When `session next` advances the chain, the Runtime injects the stage birth plan (see `formatStageBirthPacket` — stage, pipeline taskTypes, agents, leader instructions). That injection is NOT a dispatch: the Lead must explicitly call `teammate` with the stage pipeline, passing `taskType` (from stagePolicies) and the agent role, never a model id. Read `refs/experts-bind.md` for the full birth packet / waiting rules before the first stage dispatch.

### A_WAIT

While `leaderWaiting` is true: do not claim done, do not start dependent synthesis, do not re-dispatch spam. Consume the automatic `teammate-complete` notification (or `observe` wait), synthesize the RESULT into report/outputs, then `noteExpertsSettled` clears waiting.

</actions>

</state_machine>

<success_criteria>
- Mode is forced to `experts` via `setMode` and confirmed by the status panel before any stage dispatch.
- Campaign CLI stays within `maestro session/run ...` lifecycle commands; mode commands stay in-process (`setMode` + `formatExpertsStatusPanel`).
- Every stage dispatch carries a role agent + a taskType resolved from stagePolicies; no model id is ever passed or rendered.
- Leader waiting is never claimed done; settle consumes results and advances verdicts.
- Lead mutations are within the P5 allowlist (report.md, outputs/**, .workflow/**, notes/**); business code is delegated.
- Session remains the source of truth; Runtime owns all session.json/run.json mutation.
</success_criteria>

<note>
This is NOT the Qoder Canvas pipeline: it is the Pi-native experts pipeline with an enforced hard gate (host adapter turns a deny into a blocking pre-tool result carrying a teammate rewrite). The hard-gate enforcement is stronger than Qoder's soft reminder — treat a deny as a hard stop, rewrite the call, and dispatch.
</note>

## Expert profiles config (model / channel / skills)

Project file: `<cwd>/.experts-rules.json` (merged over package defaults).

### Schema (roster entry)

| Field | Meaning |
|-------|---------|
| `agent` | Teammate role name (not a model id) |
| `defaultTaskType` | Routing phase when stage/triage omit taskType |
| `channel` | Provider prefix or alias key under `channels` |
| `model` | Preferred model: `provider/model` **or** bare id (joined with channel) |
| `fallbackModels` | Ordered fallbacks |
| `thinking` | Preferred thinking level |
| `skills` | Skill names injected as `skill://` guidance on dispatch |

### Channels

```json
{ "channels": { "cpa": "cpa-responses", "sub2": "sub2-responses" } }
```

### Precedence (model)

`explicit task.model` > **expert roster profile** > `applyModelRouting` (taskType / roleMappings / inherit)

### Example

See package `src/experts-mode/config/experts-rules.example.json`. Copy fields into project `.experts-rules.json`.

### CLI

- `/experts roster` or `/experts config` — show profiles (model/channel/skills when set)

