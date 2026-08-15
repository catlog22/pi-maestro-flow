---
name: maestro-knowhow
description: "Intent-driven knowhow precipitation — describe what you want to capture (记一个关于X的决策 / 保存这段代码模板 / 写个部署配方 / 存个调试技巧) and the workflow infers the type and records it into .workflow/knowhow/. Pure capture surface; knowhow 的管理/审计走 /maestro-knowledge；项目约束规则走 /maestro-spec add。Triggers on \"knowhow capture\", \"知识沉淀\", \"沉淀经验\", \"记录模板\", \"记录决策\", \"adr\", \"存个技巧\". Arguments: [intent — e.g. '记录一个 JWT 刷新的决策' | 'template 这段重试代码' | 'tip: redis 管道陷阱']"
allowed-tools: Read Write Edit Bash Glob Grep maestro
disable-model-invocation: true
session-mode: none
---

<purpose>
Intent-driven knowhow precipitation path (沉淀路径) — captures reusable knowledge into `.workflow/knowhow/`. No fixed grammar — state your intent; the `knowhow` step infers the content type and extracts the content. Type keywords still work as deterministic shortcuts:

| Type | Keywords | Prefix |
|------|----------|--------|
| session | `session` / `compact` / 压缩 | KNW- |
| template | `template` / `tpl` / 模板 | TPL- |
| recipe | `recipe` / `rcp` / 配方 / 步骤 | RCP- |
| reference | `reference` / `ref` / 参考 | REF- |
| decision | `decision` / `dcs` / `adr` / 决策 | DCS- |
| tip | `tip` / `note` / 技巧 / 记录 | TIP- |
</purpose>

<dispatch>
Execute the `knowhow` step inside a v3 Session: open one with `maestro session open "<objective>" --id <slug> --chain knowhow --participant {p} --actor {a} --request-id {r} --reason "<reason>" --json` and dispatch with fenced `maestro run next --session {session_id} ... --expected-orchestration-revision {rev} --json` (or self-start with `maestro run create knowhow [args...] --session {session_id} ... --json`), passing the full `$ARGUMENTS` as the step input (repeatable `--arg` / positional passthrough per the command contract; first arg `capture` is implied). Read context read-only with `maestro session status` / `maestro session resume-view`; `maestro run complete {run_id} ... --advance` publishes outputs and auto-stages knowledge candidates. (v2's `run skill` dispatcher is removed from the v3 surface.)

The step infers the content type from the intent, extracts the content, and writes the entry.

- A recognized type keyword anywhere in the intent pins the type deterministically.
- Otherwise the step infers the type from the intent (e.g. "决策/决定用X" → decision, "模板/这段代码" → template, "步骤/怎么部署" → recipe).
- No clear type signal → the step asks the user to pick (6-option picker).
- This command only captures; for knowhow store management use /maestro-knowledge.
</dispatch>
