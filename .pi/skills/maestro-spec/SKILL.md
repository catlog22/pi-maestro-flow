---
name: maestro-spec
description: "Intent-driven spec precipitation — state a constraint in natural language (加一条规范：禁止用 any / 记录架构约束：服务间走 gRPC / 质量规则：覆盖率≥80%) and the workflow infers the category and records a <spec-entry>. Spec = 项目约束规则（编码规范、架构约束、质量标准）；可复用知识文档走 /maestro-knowhow capture。Triggers on \"maestro-spec add\", \"记录规范\", \"添加约束\", \"添加规则\", \"加一条规范\", \"spec add\". Terminology：spec = project constraints/rules (<spec-entry>). Reusable knowledge documents use /maestro-knowhow capture. Learning discoveries from /maestro-learn use <learning-entry> tags in learnings.md (separate from spec entries). Arguments: [intent — e.g. '加一条规范：禁止用 any' | 'arch 约束：服务间走 gRPC' | '--scope team coding: 统一用 pnpm']"
allowed-tools: Read Write Edit Bash Glob Grep maestro
disable-model-invocation: true
---

<purpose>
Intent-driven spec precipitation path (沉淀路径) — records project constraint rules. No fixed grammar — state the constraint; the `specs-add` step infers the category and scope and formats the `<spec-entry>`. Explicit form still works as a shortcut: `[--scope <scope>] <category> <content>`.

Categories: `coding · arch · quality · debug · test · review · learning · ui`
Scopes: `project` (default) · `global` · `team` · `personal`
</purpose>

<dispatch>
Run `maestro run skill specs-add` with the full `$ARGUMENTS` passed through as the user's intent (the `add` keyword is implied). The step infers category + scope + content and appends the entry.

- Explicit positional form `<category> <content>` and `--scope`/`--uid` flags still work and override inference.
- Otherwise the step infers the category from the intent (e.g. "禁止用 any/命名规范" → coding, "服务间/依赖方向" → arch, "覆盖率/质量标准" → quality, "测试约定" → test).
- Category unclear → the step asks the user to pick.
- This command only adds specs; there are no load/remove/setup subcommands.
</dispatch>
