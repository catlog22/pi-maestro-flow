---
name: maestro
description: "Intent-to-chain planner over the canonical Session/Run lifecycle Arguments: <intent> [-y] [-c] [--amend] [--dry-run]"
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
- [maestro.md](~/.maestro/workflows/maestro.md) — read before initial intent classification
- [ralph-amend-goal.md](~/.maestro/workflows/ralph-amend-goal.md) — read only for `--amend`
</deferred_reading>

<purpose>
Turn a user intent into the initial Skill chain, create one canonical topic Session through `maestro run start --platform pi --chain-file`, then execute the shared Run loop. Static versus dynamic is not a Session or command mode: each Skill contract decides whether it emits a typed chain proposal. For new intents, use this command. For policy-driven execution over existing Sessions, use `/maestro-ralph`.
</purpose>

<pi_context_contract>

- Consume the injected Topic Session resolution and ReuseAssessment as read-only routing evidence.
- Accept upstream only from same-Session sealed outputs.
- Resolve each `argument_requirements` entry through `required`, `missing`, `type`, `source`, optional `default`, and `question`.
- Treat the birth packet as compact routing; load the execution protocol from `brief.command`.
- A completion hint with `suggest_only=true` is displayed and never executed implicitly.

</pi_context_contract>

<cli_surface>

Human-facing orchestration uses the unified Run surface:

- Single step: `maestro run start "<intent>" --cmd <step> --arg "<step input>" --platform pi --workflow-root .`
- Simple command chain: `maestro run start --platform pi "<intent>" --chain analyze plan execute --no-dispatch --workflow-root .`
- Advanced chain: `maestro run start --platform pi "<intent>" --chain-file - --id <session-slug> --no-dispatch --workflow-root .`
- Completion: `maestro run done [run_id] --verdict done|done-with-concerns|needs-retry|blocked --workflow-root .`
- Mid-task changes: `maestro run edit <cmd...> --after latest --workflow-root .`

`--chain-file -` is reserved for advanced coordinator chains that need structured JSON fields such as `decision_points`, `decomposition`, `argument_requirements`, retry budgets, or executor metadata.

</cli_surface>

<interface>
Only these user flags are accepted:

- `-y` — skip all confirmation/clarification interactions, use default choices. Does NOT change data semantics (no auto-deferred decisions). Never bypasses: high-risk classification, confidence <60, ambiguity requiring user input, failed gates, or drift escalation.
- `-c` — continue the unique live compatible Session.
- `--amend` — amend that Session's goal; remaining text is the change request.
- `--dry-run` — show chain without executing.

Execution always dispatches run-executor (the default behavior); this never changes Session type or chain semantics.

All other text is intent. Unknown flags are not silently reinterpreted. Platform, roadmap, quality, template reuse, parallelism and adversarial depth are inferred.
</interface>

<invariants>
1. **One chain** — every task uses the same Session/Run protocol; no static/dynamic, Maestro/Ralph, or executor-specific Session type.
2. **Session before execution** — create via `session create --chain-file` before allocating a step Run.
3. **Creator owns decomposition** — Maestro creates `boundary_contract` and outcome-oriented goals; later orchestrators consume rather than overwrite them.
4. **Runtime owns mutation** — prompt never writes session.json/run.json and never auto-uses admin chain commands.
5. **Skill owns domain adaptation** — optional chain changes come only from the current Skill's validated `chain-proposal/1.0`.
6. **Verdict advances** — execution steps advance only through `session done --verdict`; decision steps only through `session decide`.
7. **Historical similarity remains read-only evidence** — it never selects a Session or binds outputs.
8. **Compatibility commands are out of band** — normal orchestration calls only `maestro run ...`.
9. **Auto is bounded** — `-y` never bypasses high risk, low confidence, ambiguity, failed gates or drift escalation.
10. **Router is not a step** — `/maestro-next` may route here but never appears inside the chain.
11. **Running means continue** — while canonical continuation authority is `automatic`, execute it and re-read the receipt in the same turn; `suggest_only` is Runtime passivity, not a reason to end the turn.
</invariants>

<state_machine>

<states>
S_PARSE — parse intent and flags
S_CONTINUE — locate the unique live Session
S_AMEND — audited goal amendment
S_CLASSIFY — select the smallest sufficient initial chain
S_DECOMPOSE — derive boundary, criteria and observable goals
S_CREATE — create via `session create --chain-file`
S_CONFIRM — confirm classification unless `-y`
S_RUN_LOOP — execute `orchestrator-run-loop.md`
S_FALLBACK — request missing intent or disambiguation
</states>

<transitions>
S_PARSE:
  → S_AMEND WHEN: `--amend`
  → S_CONTINUE WHEN: `-c`
  → S_CLASSIFY WHEN: intent present
  → S_FALLBACK OTHERWISE

S_CONTINUE:
  → S_RUN_LOOP WHEN: exactly one live compatible Session
  → S_FALLBACK WHEN: Session is paused (suggest /maestro-ralph -c for audited recovery)
  → S_FALLBACK WHEN: none or multiple

S_AMEND:
  → S_RUN_LOOP WHEN: shared amend protocol committed
  → END WHEN: cancelled or blocked

S_CLASSIFY:
  → S_RUN_LOOP WHEN: existing compatible Session found (do not rebuild)
  → S_DECOMPOSE WHEN: multi-step chain
  → S_CREATE WHEN: narrow/single-step chain
  → S_FALLBACK WHEN: confidence < 60

S_DECOMPOSE → S_CREATE
S_CREATE → S_RUN_LOOP WHEN: `-y` AND risk ≠ high AND confidence ≥ 60
S_CREATE → S_CONFIRM WHEN: `-y` AND (risk == high OR confidence < 60)
S_CREATE → S_CONFIRM OTHERWISE
S_CREATE → S_FALLBACK WHEN: creation fails (delete temp file, report error)
S_CONFIRM → S_RUN_LOOP WHEN: confirmed
S_CONFIRM → S_CLASSIFY WHEN: revised (maestro re-classifies the revised intent from scratch because a changed intent may reshape the chain; ralph returns to S_BUILD instead since its chain shape is already fixed)
S_CONFIRM → END WHEN: cancelled
</transitions>

<actions>

### A_CLASSIFY

Read deferred `maestro.md`. Record matched evidence, excluded alternatives and confidence before creation.

Minimum chain rules:

| Intent evidence | Initial chain |
|---|---|
| narrow fix/change | analyze → plan → execute → review/test as required |
| broad rewrite/migration | analyze-macro → scope decision → plan/roadmap path |
| brainstorm/explore | brainstorm, then only Skill-proposed continuation |
| stress/grill | grill, then only Skill-proposed continuation |
| formal specification | blueprint → plan path |
| existing compatible Session | do not rebuild; enter shared loop |

Roadmap is inferred only for multi-release evidence. Quality depth follows project specs, UI evidence needs frontend verification, and every executable command is resolved by Run Runtime.

### A_DECOMPOSE

For broad intent, ask at most 3 questions covering scope, constraints and observable done criteria; broad ambiguity is not skipped by `-y`. (broad = affects ≥3 modules OR requires cross-package interface changes OR ≥2 of 3 decomposition questions remain unanswered.) Produce:

```json
{
  "boundary_contract": { "in_scope": [], "out_of_scope": [], "constraints": [], "definition_of_done": "" },
  "decomposition": {
    "execution_criteria": [],
    "goals": [{ "id": "G1", "goal": "", "boundary": "", "done_when": "", "evidence": "", "lifecycle": [], "status": "pending" }],
    "changelog": []
  }
}
```

Goals describe outcomes, not lifecycle stages.

### A_CREATE

Assemble and create per `prepare/maestro.md` §3–§4. Maestro-specific policy:

- Maestro does not emit formal decision nodes; new chains express quality/goal/scope checks as Skill steps that own a Run and may return a proposal. (The closed-loop policy that mandates decision nodes before seal belongs to `/maestro-ralph`; route there when the work needs it.)
- For narrow/single-step chains, generate a minimal implicit boundary_contract: in_scope = [intent], out_of_scope = [], constraints = [], definition_of_done = 'step completed with passing gates'.
- Do not inline unescaped JSON.

### A_CONTINUE

Use read-only `run recall` plus `session status {session_id}`. A paused Session is out of scope here — report it and route to `/maestro-ralph -c` for audited recovery (S_FALLBACK); sealed/archived Sessions are terminal. Multiple live candidates require explicit selection.

### A_AMEND

Read `ralph-amend-goal.md`, use `session status {session_id}` for the snapshot, perform read-only impact analysis, confirm, then commit the whole decomposition with `session meta update --session {session_id} --decomposition-file -` (the decomposition object must carry all three of `execution_criteria`, `goals`, `changelog` — the schema is strict). Any pending-tail change must come from a planning Skill proposal.

</actions>

</state_machine>

<success_criteria>
- Public flags are `-y`, `-c`, `--amend`, `--dry-run`.
- Initial classification is auditable and the Session exists before step execution.
- Every step follows next → brief → execute → check → done; decision nodes use decide.
- Chain adaptation is Skill-proposed and atomically applied by the producing Run.
- Normal output and recommendations contain only `maestro run ...` lifecycle commands.
</success_criteria>
