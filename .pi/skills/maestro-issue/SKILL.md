---
name: maestro-issue
description: "Intent-driven issue lifecycle management — describe what you want in natural language (报告一个 bug / 列出开放 issue / 关掉 ISS-xxx / 关联到 task / 扫描发现问题) and the workflow routes to the right operation. Operates on .workflow/issues/. 知识管理走 /maestro-knowledge；knowhow 沉淀走 /maestro-knowhow；约束规则走 /maestro-spec。Triggers on \"issue 管理\", \"报 bug\", \"记录问题\", \"issue list\", \"关闭 issue\", \"issue discover\", \"发现问题\". Arguments: [intent — e.g. '记录一个登录失败的 bug' | 'list open' | 'close ISS-20260101-001' | 'discover']"
allowed-tools: Read Write Edit Bash Glob Grep teammate WebFetch observe maestro
disable-model-invocation: true
session-mode: none
---

<teammate_contract>

- `background: false` is the default. Use foreground dispatch whenever the result determines the current answer or next action.
- Use `background: true` only for independent work. If this turn must consume a background result, call `observe` exactly once with `action: "wait"` and a bounded timeout before continuing; never continue independently while the result is pending.
- Otherwise end the turn and wait for the automatic `teammate-complete` notification. Do not rely on `SendMessage`, `team_msg`, or hook callbacks as completion signals.
- Never silently ignore an unfinished dispatch.

</teammate_contract>

<purpose>
Intent-driven issue management (renamed from maestro-manage, narrowed to issues). No fixed subcommand grammar — state your intent; the `issue` step classifies it into one operation and extracts the needed parameters:

- **create** — report/record a new issue
- **list** — list issues (with optional filters)
- **show** — view one issue in detail
- **update** — change status/priority/add a note
- **close** — resolve/fail/defer an issue
- **link** — link an issue to a task
- **discover** — automated multi-perspective issue discovery
</purpose>

<dispatch>
Execute the `issue` step inside a v3 Session: open one with `maestro session open "<objective>" --id <slug> --chain issue --participant {p} --actor {a} --request-id {r} --reason "<reason>" --json` and dispatch with fenced `maestro run next --session {session_id} ... --expected-orchestration-revision {rev} --json` (or self-start with `maestro run create issue [args...] --session {session_id} ... --json`), passing the full `$ARGUMENTS` as the step input (repeatable `--arg` / positional passthrough per the command contract). Read context read-only with `maestro session status` / `maestro session resume-view`; `maestro run complete {run_id} ... --advance` publishes outputs and auto-stages knowledge candidates. (v2's `run skill` dispatcher is removed from the v3 surface.)

The step classifies the intent, extracts parameters, and routes to the operation.

- Free-form intent is classified into create / list / show / update / close / link / discover.
- Explicit keywords (`create|list|status|show|update|close|link`) and `--flags` still work as deterministic shortcuts and override inferred values.
- `discover` routes to the dedicated `issue-discover` step.
- Ambiguous intent → the step asks the user to disambiguate.
</dispatch>
