# experts-bind — D3 birth packet & waiting rules

Short binding ref for the Experts skill. Read before the first stage dispatch of a campaign.

## D3: `session next` does NOT silent teammate

When `session next` advances the chain, the Runtime injects the **stage birth plan** into the
session context (library: `formatStageBirthPacket`). That injection is compact routing — it is
NOT a dispatch and never spawns anyone.

The Lead must explicitly call `teammate` with the stage pipeline:

- `taskType` comes from `stagePolicies` for the stage (stage pipeline beats keyword triage);
  explicit taskType still wins.
- `agent` is a role name (explorer / analyst / planner / general-executor / reviewer / …) —
  never a model id.
- No `model` field. Routing owns models.
- Stage is auto-injected from session.json (P4.1) — never set `MAESTRO_STAGE` manually.

Birth packet fields (from `formatStageBirthPacket`):

| Field | Meaning |
|---|---|
| stage | normalized stage name (execute, analyze, plan, review, …) |
| pipeline | ordered taskTypes (e.g. `explore → analysis`) |
| agents | role agents per pipeline step |
| leader instructions | compact routing guidance for the dispatch |

Example (analyze stage): `Stage birth: "analyze"` → dispatch `explorer` taskType=explore,
then `analyst` taskType=analysis with dependsOn on the explore task.

## Waiting rules

While `leaderWaiting` is true (`leaderWaitingCount > 0`, agent ids in `leaderWaitingAgentIds`):

1. **Do not claim done** — no `session done`, no final synthesis, no seal while experts run.
2. **Do not re-dispatch spam** — the stage pipeline is dispatched once; do not re-fire the same
   tasks while the previous wave is in flight.
3. **Do not start dependent synthesis** — wait for the automatic `teammate-complete`
   notification (or one bounded `observe` wait) before consuming results.
4. **Consume settle** — after results arrive, call `noteExpertsSettled` (decrements waiting,
   clears settled in-flight units) before continuing the loop.
5. **P7 harvest** — settle with expert RESULT content may stage knowhow suggestions; never
   auto-promote — harvest is suggest-only (`maestro knowledge stage`).

## P5 allowlist (Lead-only writes)

`report.md`, `outputs/**`, `.workflow/**`, `notes/**` + rules `hardGate.leaderAllowPaths`.
Everything else — business code, config, tests — goes through a teammate dispatch
(development / testing / review … per stage).
