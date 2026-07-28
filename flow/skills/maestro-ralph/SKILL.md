---
name: maestro-ralph
description: "Closed-loop policy over the canonical Session/Run chain Arguments: <intent> [-y] [-c] [--amend]"
allowed-tools: Read Write Edit Bash Glob Grep AskUserQuestion Agent SendMessage TaskCreate TaskUpdate
disable-model-invocation: false
---

<required_reading>
@~/.maestro/workflows/run-mode.md
@~/.maestro/workflows/orchestrator-run-loop.md
@~/.maestro/prepare/ralph.md
</required_reading>

<deferred_reading>
- [ralph-amend-goal.md](~/.maestro/workflows/ralph-amend-goal.md) — read only for `--amend`
</deferred_reading>

<purpose>
Apply retry, confidence, drift, goal-audit and stopping policy over any compatible canonical Session. Ralph does not own a CLI driver, private Session type or second state store; it calls only `maestro run ...` and follows the shared Run loop. Primary path: locate and drive an existing Session. Session creation is a fallback when no compatible Session exists.
</purpose>

<interface>
Only these user flags are accepted:

- `-y` — skip all confirmation/clarification interactions, use default choices. Does NOT change data semantics (no auto-deferred decisions). Never bypasses: high-risk classification, confidence <60, ambiguity requiring user input, failed gates, or drift escalation.
- `-c` — continue the unique live compatible Session; paused state enters audited recovery.
- `--amend` — amend the live Session goal; remaining text is the change request.

All remaining text is intent. No engine, roadmap, script, depth, role, tier, platform, resume or dry-run flags are parsed. Those choices belong to Skill contracts and Runtime.
</interface>

<invariants>
1. **Ralph owns the policy loop** — locate → allocate → brief → dispatch → check → drift/proposal evaluation → done/decide → next → seal.
2. **One executor per Run** — dispatch one unnamed `run-executor`; nested execution strategy belongs to the Skill.
3. **Thin executor** — executor executes and checks one Run but never completes it.
4. **Sessions are topic grouping/indexes** — execution, handoff, anchor and immutable outputs belong to Runs.
5. **canonical upstream map** — same-Session sealed outputs enter only through birth/brief; no manual context reconstruction.
6. **Runtime mutation authority** — session.json/run.json are never written directly; normal flow uses only `maestro run ...`.
7. **Proposal governance** — Skill proposes, Ralph evaluates budget/confidence/intent, Runtime applies atomically with the producing Run.
8. **No prompt fix templates** — fix/review/goal gaps dispatch a Skill that may emit a proposal.
9. **Decision receipts are single-source** — decisions land through `session decide`, never direct append.
10. **Auto is bounded** — `-y` cannot bypass high risk, confidence <60, ambiguity, escalation, failed gates or reground halt.
11. **Compatibility commands are out of band** — no Ralph/Session CLI is called or recommended.
12. **Terminal means terminal** — sealed/archived returns `CHAIN_COMPLETE`, never resume.
13. **Decision is mandatory** — every Ralph-created chain contains at least one formal decision node before Session seal; Run completion never substitutes for `session decide`.
14. **Completion and decision both continue** — after successful `session done --json` or `session decide --json`, immediately execute any satisfiable `continuation.authority=automatic` action in the same turn.
</invariants>

<state_machine>

<states>
S_PARSE — parse intent and the three public flags
S_RESOLVE — locate or create a compatible Session
S_INFER — infer lifecycle position and roadmap need
S_DECOMPOSE — derive boundary and observable goals for a new Session
S_ASSESS — classify creation risk and evidence confidence
S_BUILD — build initial Skill chain
S_CREATE — `session create --chain-file`
S_CONFIRM — confirm unless `-y`
S_RUN_LOOP — shared Run lifecycle
S_EVALUATE — quality/goal/scope/reground decision
S_AMEND — audited goal amendment
S_RECOVER — audited paused recovery
S_FAIL — retry or pause; retry budget exhausted implies Session auto-paused. (Distinct from maestro's S_FALLBACK, which requests missing intent/disambiguation before any Session exists; S_FAIL operates on an already-created Session.)
S_DONE — seal Session
</states>

<transitions>
S_PARSE:
  → S_AMEND WHEN: `--amend`
  → S_RESOLVE WHEN: `-c` or intent present
  → S_FAIL OTHERWISE

S_RESOLVE:
  → S_RECOVER WHEN: exact compatible Session is paused and `-c`
  → S_RUN_LOOP WHEN: exact compatible Session is running with a chain
  → S_INFER WHEN: only paused Session exists and no `-c` (treat as new intent; paused Session remains untouched)
  → S_INFER WHEN: no live Session and intent present
  → S_FAIL WHEN: multiple candidates or incompatible terminal Session

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
  → S_RUN_LOOP WHEN: proceed or accepted fix proposal
  → S_RECOVER WHEN: escalate pauses Session
  → S_FAIL WHEN: escalate but Session not paused (user declined pause)
  → S_RUN_LOOP WHEN: post-goal-audit AND has_unmet (fix loop; insert repair step at `target_stage`)
  → S_DONE WHEN: post-goal-audit AND all_met AND INTENT_ALIGNED
  → END WHEN: post-goal-audit AND all_met AND NOT INTENT_ALIGNED (REGROUND_HALT)
  → S_RUN_LOOP WHEN: post-analyze-scope (apply `scope_verdict` to the chain path)
  → S_DONE WHEN: post-session AND preflight passed (decide then seal)
  → S_RUN_LOOP WHEN: post-session AND preflight failed (fix loop)
  → END WHEN: post-debug-escalate (always pauses)
  → END WHEN: post-reground AND drifted AND confidence ≥ 60 (REGROUND_HALT; `-y` does not bypass)
  → S_RUN_LOOP WHEN: post-reground AND aligned
  → S_RUN_LOOP WHEN: post-reground AND drifted AND confidence < 60 (proceed, mark LOW CONFIDENCE)

S_FAIL:
  → S_RUN_LOOP WHEN: retry budget remains
  → END WHEN: retry budget exhausted (Session auto-paused)
  → END WHEN: Session paused or user aborts

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

Read-only lookup via `run recall`. Explicit birth `session_id/run_id` wins. Multiple live candidates require user selection; historical similarity never grants authority.

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

Build the chain from `prepare/ralph.md` Stage Mapping, propagate goal references, map the current host to the Skill scanner's `target_platform` (`claude|codex|agent|agy|pi`), and prevalidate every command with `maestro skills --steps --json --platform {target_platform}`. Never default a non-Claude host to `claude`; `pi` resolves Skills from the installed `pi-maestro-flow` npm package's `package.json#pi.skills` directories. Every chain includes at least one final quality/goal/scope decision node before seal; long chains also include periodic reground decision nodes. Step execution strategy is defined by each Skill, never by Ralph flags.

### A_EXECUTE

Follow `orchestrator-run-loop.md` exactly. Display identity may use stage prefixes, but no private agent name or Ralph progress file is persisted. Task/Goal UI is projection only.

### A_EVALUATE

Follow `orchestrator-run-loop.md` §6 Decision step; the VERDICT format is defined in `prepare/ralph.md`. Ralph policy thresholds:

- Confidence mapping: low = <60, medium = 60-79, high = ≥80.
- Confidence below 60 → cannot proceed.
- Retry budget exhaustion → escalate.
- Goal audit: compare every pending goal's `done_when` against evidence; missing evidence means unmet.
- Reground: compare cumulative handoffs against intent and boundary; confident drift halts even under `-y`. drift = cumulative handoffs deviate from ≥2 boundary_contract.in_scope items or introduce ≥1 out_of_scope item; confident drift = drift detected with confidence ≥80%.

### A_FAIL

- Repairable failure → verdict `needs-retry`; re-dispatch only after Runtime returns the step to pending.
- External or exhausted blocker → verdict `blocked`; Session pauses.
- Never allocate a new Run while the previous Run is running or gate-blocked.

### A_RECOVER

Only explicit `-c` enters recovery. Follow `orchestrator-run-loop.md` §7 exactly.

### A_AMEND

Read `ralph-amend-goal.md`. High risk always asks. Pending-tail changes come from a planning Skill proposal, not direct edit.

### A_DONE

When every execution Run is sealed, every decision is terminal, every goal is done and Session gates are clean → seal.

</actions>

</state_machine>

<success_criteria>
- Public flags are exactly `-y`, `-c`, `--amend`.
- No legacy Ralph driver, private Session type, or independent Skills CLI appears in normal flow.
- Each Run follows `session next --inline-brief` → execute → `run check` → `session done --verdict`; backtracking uses `run brief`. Every decision uses `session decide`.
- Proposal acceptance is pathless from Ralph's perspective and atomic with Run completion.
- Retry, confidence, drift, goal audit, recovery and terminal semantics remain explicit.
</success_criteria>
