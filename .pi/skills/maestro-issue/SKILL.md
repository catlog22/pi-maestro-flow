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
Read `~/.maestro/workflows/issue.md` and follow the execution document directly. Do not create a Session or Run just to load this document.

Pass the full `$ARGUMENTS` to the workflow. For `discover`, read `~/.maestro/workflows/issue-discover.md` instead. The workflow classifies the intent, extracts parameters, and routes to the requested issue operation.
</dispatch>
