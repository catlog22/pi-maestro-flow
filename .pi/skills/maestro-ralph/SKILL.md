---
name: maestro-ralph
description: "Closed-loop policy over the canonical Session/Run chain Arguments: <intent> [-y] [-c] [--amend]"
allowed-tools: Read Write Edit Bash Glob Grep teammate observe maestro run-control
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
~/.maestro/prepare/ralph.md
</required_reading>

<host_mirror>

Pi mirrors canonical Session/Run state automatically:

- Advance only with `todo({ action: "next" })`; do not create or update mirror tasks manually.
- Goal completion is derived from terminal chain state and clean gates.
- After compaction, reattach through the current Run's `brief.command`.

</host_mirror>

If any required file above was not expanded into context by the host, or its content is no longer in context, Read it explicitly before executing the state machine.

<deferred_reading>
- [ralph-amend-goal.md](~/.maestro/workflows/ralph-amend-goal.md) — read only for `--amend`
</deferred_reading>

<purpose>
Apply retry, confidence, drift, goal-audit and stopping policy over the exact current Execution of a durable topic Session. Ralph does not own a CLI driver, private Session type, host-only lease, or second state store; it follows the shared Execution-aware Run loop. Primary path: locate and drive an existing Execution. Creating Session identity plus a bounded Execution is a fallback when no compatible identity exists.
</purpose>

<pi_context_contract>

- Consume the injected Topic Session resolution and ReuseAssessment as read-only routing evidence.
- Accept upstream only from same-Session sealed outputs.
- Resolve each `argument_requirements` entry through `required`, `missing`, `type`, `source`, optional `default`, and `question`.
- Treat the birth packet as compact routing; load the execution protocol from `brief.command`.
- A completion hint with `suggest_only=true` is displayed and never executed implicitly.

</pi_context_contract>

<cli_surface>

Human-facing orchestration should stay on one topic Session. The command surface is dual-mode:

**session/3.0 branch (canonical new runtime; no Execution, no lease)**

- Open a Session and bootstrap its chain: `session open "<intent>" --id <slug> --participant <hostSessionId> --actor <hostSessionId> --request-id <uuid> --reason "..." [--chain <cmds...>]`; chain edits use `session chain insert|skip|replace|list|fail`.
- Allocate the next Run: `run next --run <run-id> ...`; the executor executes and checks but never completes.
- Complete with advance: `run complete <run-id> --advance --verdict done --summary "..." ...`.
- Decide at a decision point: `run decide <point-id> --verdict proceed|fix|escalate ...`.
- Finish the bounded generation: `session complete ...` (v3 has no Execution seal).
- Every v3 mutation requires `--participant/--actor/--request-id/--expected-*-revision` (injected automatically by run-control/coordinator). Read-only status: `session status` / `session resume-view`; re-attach: `run recall` / `run brief`.

**execution-v2 branch (legacy; current default workspace protocol)**

- Start one step with `maestro run start "<intent>" --cmd <step> --arg "<step input>" --platform pi --workflow-root .`
- Start a simple chain with `maestro run start --platform pi "<intent>" --chain analyze plan execute --no-dispatch --workflow-root .`
- Complete the active Run with `maestro run done [run_id] --verdict done|done-with-concerns|needs-retry|blocked --workflow-root .`
- Add or change future simple steps with `maestro run edit <cmd...> --after latest --workflow-root .`

Advanced v2 coordinator chains use `maestro run start --platform pi "<intent>" --chain-file - --id <session-slug> --no-dispatch`. Ralph has no separate CLI driver or Session type.

</cli_surface>

<interface>
Only these user flags are accepted:

- `-y` — skip all confirmation/clarification interactions, use default choices. Does NOT change data semantics (no auto-deferred decisions). Never bypasses: high-risk classification, confidence <60, ambiguity requiring user input, failed gates, or drift escalation.
- `-c` — continue the unique compatible Session's exact current Execution; paused Execution enters audited recovery.
- `--amend` — amend the exact current Execution goal; remaining text is the change request.

All remaining text is intent. No engine, roadmap, script, depth, role, tier, platform, resume or dry-run flags are parsed. Those choices belong to Skill contracts and Runtime.
</interface>

<invariants>
1. **Ralph owns policy, not authority** — locate Session identity -> bind exact authority (v3: Session/chain/orchestration revision; v2: Execution/generation/claim) -> dispatch -> check -> drift/proposal evaluation -> complete/decide -> next -> complete the generation (v3: `session complete`; v2: seal Execution).
2. **One executor per Run** — dispatch one unnamed `run-executor`; nested execution strategy belongs to the Skill.
3. **Thin executor** — executor executes and checks one Run but never receives the private claim or completes it.
4. **Session is identity; Execution is lifecycle** — Session is a durable topic grouping/index; Execution owns chain, gates, decisions, revision, pause/resume/seal, and core lease; Runs own immutable attempts and outputs.
5. **Canonical upstream map** — same-Session sealed outputs enter only through birth/brief; no manual context reconstruction.
6. **Runtime mutation authority** — protocol JSON is never written directly; canonical mutation uses the negotiated branch only and `run-response/1.1`: v3 uses exact `session ...` / `run ...` commands through run-control (`session open` / `session chain ...` / `run next` / `run complete` / `run decide` / `session complete`); v2 keeps exact Execution-aware `maestro execution ...` / `maestro run ...` commands.
7. **Proposal governance** — Skill proposes, Ralph evaluates budget/confidence/intent, Runtime applies atomically inside the current Execution.
8. **No prompt fix templates** — fix/review/goal gaps dispatch a Skill that may emit a proposal.
9. **Decision receipts are single-source** — decisions land through fenced `run decide` only (v3: `run decide`; v2: `maestro run decide`), never direct append.
10. **Auto is bounded** — `-y` cannot bypass high risk, confidence <60, ambiguity, escalation, failed gates or reground halt.
11. **Legacy compatibility is out of band** — Session lifecycle aliases are allowed only by the labeled `session/1.x` branch in the shared loop.
12. **Generation terminality** — a sealed Execution never resumes; the Session identity may host a later higher generation.
13. **Decision is mandatory** — every Ralph-created chain contains at least one formal decision node before the terminal transition (v3: `session complete`; v2: `maestro execution seal`); Run completion never substitutes for `run decide`.
14. **Completion and decision both continue** — after successful fenced `run complete --json` / `run decide --json` (v3) or `maestro run complete --json` / `maestro run decide --json` (v2), consume the fresh fence and immediately execute any satisfiable automatic continuation in the same turn.
15. **Capability negotiation is mandatory (three-state)** — before mutation, call `maestro capabilities --json` and select exactly one mode:
    - **session-run-v3**: `session_run_minimal_v3`, `entity_revision_cas`, `participant_identity`, and `request_receipts_v2` all true AND `execution_lease=false`; the v3 vocabulary (Session/chain/Run, no execution/lease) governs.
    - **execution-v2** (legacy, current default workspace protocol): `session/2.0`, `execution/1.0`, `core_execution_lease`, and `run-response/1.1` as today.
    - otherwise **fail closed** — never downgrade to a host-only lease or Session lifecycle alias.
</invariants>

<state_machine>

<states>
S_PARSE — parse intent and the three public flags
S_RESOLVE — locate or create a compatible Session
S_INFER — infer lifecycle position and roadmap need
S_DECOMPOSE — derive boundary and observable goals for a new Session
S_ASSESS — classify creation risk and evidence confidence
S_BUILD — build initial Skill chain
S_CREATE — create/resolve Session identity, start Execution, bootstrap its chain
S_CONFIRM — confirm unless `-y`
S_RUN_LOOP — shared Run lifecycle (v3: session/3.0 loop; v2: Execution-aware loop)
S_EVALUATE — quality/goal/scope/reground decision
S_AMEND — audited goal amendment
S_RECOVER — audited paused-Execution recovery
S_FAIL — retry or pause; retry exhaustion pauses the current Execution
S_DONE — complete current generation (v3: `session complete`; v2: `maestro execution seal`)
</states>

<transitions>
S_PARSE:
  → S_AMEND WHEN: `--amend`
  → S_RESOLVE WHEN: `-c` or intent present
  → S_FAIL OTHERWISE

S_RESOLVE:
  -> S_RECOVER WHEN: exact current Execution is paused and `-c`
  -> S_RUN_LOOP WHEN: exact current Execution is active with a chain and valid/acquirable core authority
  -> S_INFER WHEN: only a paused Execution exists and no `-c` (treat as new intent; do not mutate it)
  -> S_INFER WHEN: no current Execution and intent present
  -> S_FAIL WHEN: multiple identities/Executions or archived identity

S_INFER → S_DECOMPOSE → S_ASSESS → S_BUILD → S_CREATE
S_CREATE → S_RUN_LOOP WHEN: `-y` AND risk ≠ high AND confidence_score ≥ 60
S_CREATE → S_CONFIRM WHEN: `-y` AND (risk == high OR confidence_score < 60)
S_CREATE → S_CONFIRM OTHERWISE
S_CREATE → S_FAIL WHEN: creation fails (delete temp file, report error)
S_CONFIRM → S_RUN_LOOP WHEN: confirmed
S_CONFIRM → S_BUILD WHEN: revised
S_CONFIRM → END WHEN: cancelled

S_RUN_LOOP:
  → S_EVALUATE WHEN: next node is a decision
  → S_FAIL WHEN: executor/check/drift reports retry or blocker
  → S_DONE WHEN: `CHAIN_COMPLETE`
  → S_DONE WHEN: no pending steps and no `CHAIN_COMPLETE` (implicit completion)
  → S_RUN_LOOP WHEN: Run sealed and another pending step exists

S_EVALUATE:
  -> S_RUN_LOOP WHEN: proceed or accepted fix proposal
  -> S_RECOVER WHEN: escalate pauses Execution
  -> S_FAIL WHEN: escalation cannot be committed
  -> S_RUN_LOOP WHEN: post-goal-audit AND has_unmet (fix loop; insert repair step at `target_stage`)
  -> S_DONE WHEN: post-goal-audit AND all_met AND INTENT_ALIGNED
  -> END WHEN: post-goal-audit AND all_met AND NOT INTENT_ALIGNED (REGROUND_HALT)
  -> S_RUN_LOOP WHEN: post-analyze-scope (apply `scope_verdict` to the Execution chain path)
  -> S_DONE WHEN: post-execution AND preflight passed (decide then complete: v3 `session complete` / v2 `maestro execution seal`)
  -> S_RUN_LOOP WHEN: post-execution AND preflight failed (fix loop)
  -> END WHEN: post-debug-escalate (always pauses Execution)
  -> END WHEN: post-reground AND drifted AND confidence >= 60 (REGROUND_HALT; `-y` does not bypass)
  -> S_RUN_LOOP WHEN: post-reground AND aligned
  -> S_RUN_LOOP WHEN: post-reground AND drifted AND confidence < 60 (proceed, mark LOW CONFIDENCE)

S_FAIL:
  -> S_RUN_LOOP WHEN: retry budget remains
  -> END WHEN: retry budget exhausted (Execution paused)
  -> END WHEN: Execution paused or user aborts

S_AMEND → S_RUN_LOOP WHEN: shared amend protocol committed
S_RECOVER → S_RUN_LOOP WHEN: blockers resolved and resume committed
S_RECOVER → S_FAIL WHEN: blockers unresolvable
S_RECOVER → END WHEN: user aborts recovery
S_DONE → S_RUN_LOOP WHEN: seal fails due to unmet gates
S_DONE → END
</transitions>

<actions>

All command syntax and lifecycle mechanics follow `orchestrator-run-loop.md` and `run-mode.md`. The actions below define only Ralph-specific policy decisions.

### A_RESOLVE

Read-only lookup via `run recall` (v3; the v3 `run recall` variant is implemented) or the Execution-aware `maestro run recall` (v2). Explicit birth wins: v3 resolves by `session_id + run_id` (no Execution/generation fields exist); v2 by `session_id + execution_id + generation + run_id`. Multiple candidates require user selection; historical similarity never grants authority.

### A_INFER

Classify `lifecycle_position` from evidence in this order:

1. An explicit request for grill, brainstorm or blueprint selects that entry.
2. Outside those three pre-project entries, a missing Maestro project structure selects init.
3. Reusable sealed outputs from the same Session may skip only the stages they satisfy: verified analysis without a plan selects plan; a verified plan without implementation selects execute; verified implementation selects the first applicable review/test stage.
4. Without reusable same-Session evidence, bounded work starts at analyze. Work whose scope is itself unresolved starts at analyze-macro.

Code presence, historical similarity from another Session, or a stage name mentioned only as an example never proves lifecycle completion. Set `wants_roadmap=true` only for an explicit roadmap request or evidence of at least 2 independently releasable milestones; file count alone is insufficient.

Record `lifecycle_position`, `wants_roadmap`, supporting evidence and every skipped stage with its reason. Ambiguous evidence is carried into A_ASSESS rather than silently choosing a later stage.

### A_DECOMPOSE

Derive one boundary contract and outcome-oriented goal set before building the chain:

```json
{
  "boundary_contract": {
    "in_scope": [],
    "out_of_scope": [],
    "constraints": [],
    "definition_of_done": ""
  },
  "decomposition": {
    "execution_criteria": [],
    "goals": [
      {
        "id": "G1",
        "goal": "",
        "boundary": "",
        "done_when": "",
        "evidence": "",
        "lifecycle": [],
        "status": "pending"
      }
    ],
    "changelog": []
  }
}
```

Work is broad when it affects at least 3 modules, changes a cross-package interface, or leaves at least 2 of scope/constraints/done criteria unresolved. Ask at most 3 boundary questions; `-y` cannot invent answers for broad ambiguity. Narrow work may use the intent as its single `in_scope` item, but still requires an observable `definition_of_done`.

Every goal must describe a user-visible or verifiable outcome, map to at least one `in_scope` item, name concrete evidence in `done_when`/`evidence`, and list only lifecycle stages that can produce that evidence. Reject empty goals, stage-named goals, duplicate IDs and goals with no evidence path.

### A_ASSESS

Produce a creation assessment with `risk`, `risk_reasons`, `confidence_score`, `confidence_reasons` and `unresolved_questions`.

- `high` risk: destructive or irreversible operations; production/release mutation; authentication, authorization or sensitive-data changes; data/schema migration without a proven rollback; or backward-incompatible public contract changes.
- `medium` risk: multi-module behavior, compatible API/schema changes, new dependencies, concurrency/state-machine changes, or migrations with a verified rollback.
- `low` risk: isolated reversible work with existing patterns and a known verification path.

Compute confidence from 100 and clamp to 0–100. Apply each applicable penalty once: −30 unresolved scope/constraint/done criterion; −20 ambiguous lifecycle position; −20 missing or stale required upstream evidence; −15 unverified cross-module integration assumption; −15 unknown test or verification path. Cite evidence for every deduction.

Confidence maps to low `<60`, medium `60–79`, high `≥80`. High risk always requires confirmation. Confidence below 60 cannot enter S_RUN_LOOP until the missing evidence or ambiguity is resolved; `-y` never bypasses either gate.

### A_BUILD

Consume the outputs of A_INFER, A_DECOMPOSE and A_ASSESS; do not re-infer them while assembling the chain. Quality is quick/standard/full based on specs and observable risk, not a user flag. Quality criteria: quick = single-file + existing tests; standard = multi-file + new logic; full = cross-module + no existing coverage.

Build the chain from `prepare/ralph.md` Stage Mapping. If the Stage Mapping or Build Rules are not in context, fetch them first via read-only `read ~/.maestro/prepare/ralph.md` (no Session required; `prepare.content` carries the full protocol). Propagate goal references, map the current host to the Skill scanner's `target_platform` (`claude|codex|agent|agy|pi`), and prevalidate every command with `maestro skills --steps --json --platform pi`. Never default a non-Claude host to `claude`; `pi` resolves Skills from the installed `pi-maestro-flow` npm package's `package.json#pi.skills` directories. Every chain includes at least one final quality/goal/scope decision node before the terminal transition (v3: `session complete`; v2: Execution seal); long chains also include periodic reground decision nodes. Step execution strategy is defined by each Skill, never by Ralph flags.

### A_EXECUTE

Follow `orchestrator-run-loop.md` exactly. Display identity may use stage prefixes, but no private agent name or Ralph progress file is persisted. Task/Goal UI is projection only.

### A_EVALUATE

Follow `orchestrator-run-loop.md` "4. Decision Step"; the VERDICT format is defined in `prepare/ralph.md`. Ralph policy thresholds:

- Confidence mapping: low = <60, medium = 60-79, high = ≥80.
- Confidence below 60 → cannot proceed.
- Retry budget exhaustion → escalate.
- Goal audit: compare every pending goal's `done_when` against evidence; missing evidence means unmet.
- Reground: compare cumulative handoffs against intent and boundary; confident drift halts even under `-y`. drift = cumulative handoffs deviate from ≥2 boundary_contract.in_scope items or introduce ≥1 out_of_scope item; confident drift = drift detected with confidence ≥80%.

### A_FAIL

- Repairable failure → verdict `needs-retry`; re-dispatch only after Runtime returns the step to pending.
- External or exhausted blocker -> verdict `blocked`; current Execution pauses and releases its claim.
- Never allocate a new Run while the previous Run is running or gate-blocked.

### A_RECOVER

Only explicit `-c` enters recovery. Follow `orchestrator-run-loop.md` "5. Recovery and Amend" exactly.

### A_AMEND

Read `ralph-amend-goal.md`. High risk always asks. Pending-tail changes come from a planning Skill proposal, not direct edit.

### A_DONE

When every Run is sealed, every decision is terminal, every goal is done, no request is claimed, and gates are clean -> complete the bounded generation through the negotiated branch: **v3** `session complete` with the exact locator/`--expected-*-revision` (run-control injects participant/actor/request-id; there is no Execution seal in v3); **v2** `maestro execution seal` with the exact locator/revision/core claim. Session identity remains reusable.

</actions>

</state_machine>

<success_criteria>
- Public flags are exactly `-y`, `-c`, `--amend`.
- No legacy Ralph driver, private Session type, or independent Skills CLI appears in normal flow.
- Each Run follows `run next` -> execute -> `run check` -> fenced `run complete --verdict` (v3) or Execution-aware `maestro run next` -> execute -> `maestro run check` -> fenced `maestro run complete --verdict` (v2); backtracking uses `run brief` / `maestro run brief`. Every decision uses fenced `run decide`.
- Final completion is dual-mode: v3 `session complete` (no Execution seal), v2 `maestro execution seal`; Session identity is never permanently sealed in either canonical branch.
- Proposal acceptance is pathless from Ralph's perspective and atomic with Run completion.
- Retry, confidence, drift, goal audit, recovery and terminal semantics remain explicit.
</success_criteria>
