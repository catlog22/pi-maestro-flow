---
name: swarm
description: Objective-driven ACO swarm with a private system Ant, dynamic judge/analyst bindings, task-specific Prompts, and an authoritative dashboard.
allowed-tools:
  - swarm_runtime
session-mode: none
---

<purpose>
Execute the user objective with the runtime-private system Ant plus judge and analyst roles selected from the current live teammate catalog. This Skill owns task-space, Ant task contract, judge/analyst bindings, evidence, scoring, and synthesis contract compilation; `swarm_runtime` owns the private Ant identity, validation, teammate lifecycle, ACO math, artifacts, events, and the live dashboard.
</purpose>

<process>

## 1. Initialize from the user objective

Treat the text immediately following this Skill block as the exact objective. Preserve its requested scope, artifact, constraints, language, and acceptance criteria. Do not answer the objective directly and do not invoke `teammate`; all swarm workers must flow through `swarm_runtime` so the dashboard receives authoritative events.

Before treating the text as a new objective, handle persisted-run controls:

- `resume [RUN_ID]`: call `swarm_runtime` once with `{ "action": "resume", "runId": "<optional RUN_ID>" }`. Do not read the catalog or compile a new plan.
- `continue [K] [RUN_ID]`: call `swarm_runtime` once with `{ "action": "continue", "additionalIterations": <K, default 2>, "runId": "<optional RUN_ID>" }`. Preserve the compiled plan, feedback, graph, history, and best candidate.

For either control, remain on the turn until the runtime returns, then follow step 5. Do not reinterpret the control text as an analysis objective.

## 2. Read the live teammate catalog

Call `swarm_runtime` once with `{ "action": "catalog" }`. Treat the returned role names and descriptions as the only selectable authority for judge and analyst. The private `swarm-ant` is deliberately absent from this catalog and MUST NOT be supplied as a selectable role.

## 3. Compile a task-specific execution contract

Infer the objective's dominant capability mix, then produce a plan for the `execute` call.

Plan rules:

- Define 4–8 dimensions whose ids, labels, and descriptions refer to this objective. Do not reuse a generic fixed list when task-specific dimensions are possible.
- Define exactly two selectable role bindings with stages `judge` and `analyst`. For each binding, select an exact live-catalog agent, choose the taskType, and compile an objective-specific mission and non-empty Prompt.
- Define one Ant task contract containing `taskType`, an objective-specific mission and Prompt, evidence requirements, constraints, and output expectation. Do not add an Ant role binding or `agent` field: the runtime always binds the private system `swarm-ant`.
- Define 3–8 scoring dimensions with non-negative weights summing to 1. The rubric must reflect the objective's acceptance conditions. When every analysis dimension needs an independent score, use one rubric item per dimension instead of merging dimensions to satisfy an artificial limit.
- Define final synthesis requirements that preserve evidence, dissent, actions, and risks.
- Keep Ant work read-only. The swarm produces an optimized, evidence-backed result artifact; it does not mutate the workspace during exploration.
- Explain the selection in `rationale` so the Prepare view can show why this topology was chosen.

Unknown judge/analyst roles, missing stages, blank Prompts, or unsupported taskTypes are terminal contract errors. The private Ant must fail closed if its bundled definition is unavailable; it must never fall back to a public role.

## 4. Execute through the native runtime

Call `swarm_runtime` with `action: "execute"`, the exact objective, and one complete `plan`. Before the call, verify that `plan` has all six top-level fields: `rationale`, `dimensions`, `roles`, `ant`, `scoring`, and `synthesis`. `scoring` and `synthesis` are siblings of `ant` inside `plan`; never nest them under `ant` or inside each other.

Use this canonical hierarchy:

```json
{
  "action": "execute",
  "objective": "<exact user objective>",
  "plan": {
    "rationale": "<selection rationale>",
    "dimensions": [
      { "id": "dimension_1", "label": "<label>", "description": "<objective-specific description>" },
      { "id": "dimension_2", "label": "<label>", "description": "<objective-specific description>" },
      { "id": "dimension_3", "label": "<label>", "description": "<objective-specific description>" },
      { "id": "dimension_4", "label": "<label>", "description": "<objective-specific description>" }
    ],
    "roles": [
      {
        "id": "judge",
        "stage": "judge",
        "agent": "<exact live-catalog judge agent>",
        "taskType": "analysis",
        "mission": "<objective-specific judge mission>",
        "prompt": "<objective-specific judge Prompt>"
      },
      {
        "id": "analyst",
        "stage": "analyst",
        "agent": "<exact live-catalog analyst agent>",
        "taskType": "analysis",
        "mission": "<objective-specific analyst mission>",
        "prompt": "<objective-specific analyst Prompt>"
      }
    ],
    "ant": {
      "taskType": "analysis",
      "mission": "<objective-specific mission>",
      "prompt": "<objective-specific Prompt>",
      "evidenceRequirements": ["<one or more requirements>"],
      "constraints": ["<zero or more constraints>"],
      "outputExpectation": "<expected Ant output>"
    },
    "scoring": {
      "rubric": [
        { "id": "dimension_1", "label": "<label>", "weight": 0.34, "description": "<scoring rule>" },
        { "id": "dimension_2", "label": "<label>", "weight": 0.33, "description": "<scoring rule>" },
        { "id": "dimension_3", "label": "<label>", "weight": 0.33, "description": "<scoring rule>" }
      ],
      "instructions": ["<scoring instruction>"]
    },
    "synthesis": {
      "requirements": ["<one or more synthesis requirements>"]
    }
  }
}
```

The angle-bracket strings describe the required shape; replace them with the concrete objects and values compiled in step 3. Copy the objective text exactly; do not summarize, expand, translate, or prefix it. Remain on the turn until the tool returns.

If provider-side tool validation rejects the plan before execution starts, correct only the reported contract field and resubmit once with the identical objective. Do not re-read the catalog, merge unrelated dimensions, or manually substitute for the runtime.

During execution, the native runtime emits authoritative events for Skill phases, role binding, Prompt hashes, teammate assistant/tool deltas, ACO metrics, convergence decisions, and artifact production. Do not fabricate status messages or infer completion from elapsed time.

The runtime assigns complementary evidence-first, adversarial, integration, and alternative exploration lenses across Ants. From iteration 2 onward it also injects a capped set of prior verified candidates as untrusted evidence so fresh-context Ants can refine or challenge earlier findings without inheriting another Agent's instructions. The coordinator must not duplicate or override this runtime guidance.

If execution returns `failed` or `cancelled`, report the persisted partial artifact directory and the runtime reason. Do not claim convergence.

Failure is terminal for this Skill turn. After reporting a runtime failure or cancellation, stop immediately: do not analyze the objective directly, do not invoke other read/search tools as a substitute, and do not present a manually produced result as Swarm output.

## 5. Return the artifact-backed result

Use only the returned synthesis, convergence reason, metrics, and artifact paths. Lead with the recommendation, then list material risks and the `result.json` path. Keep the final response compact because iteration/convergence monitoring remains in the footer and full topology, Prompt, live stream, and metric history remain available through `/swarm inspect`.

</process>

<success_criteria>
- [ ] The live teammate catalog was read in this turn and the selected judge and analyst came from it; `swarm-ant` was not exposed or selected.
- [ ] Exactly one judge and analyst binding includes taskType, mission, and non-empty Prompt; the Ant task contract includes taskType, mission, and Prompt without an agent selector.
- [ ] Dimensions, Ant contract, scoring rubric, and synthesis requirements were derived from the current objective.
- [ ] `swarm_runtime execute` received one complete dynamic plan, with at most one corrected resubmission after provider-side validation.
- [ ] Dashboard state came from runtime events rather than coordinator guesses.
- [ ] Final claims cite returned convergence and artifact data.
</success_criteria>
