---
name: maestro-knowledge
description: "Intent-driven knowledge-store management — describe what you want (审计一下知识库 / 从工件提取知识 / 检查 wiki 健康 / 连知识图谱 / 注册领域术语) and the command routes to the right step. Knowhow 的 capture 走 /maestro-knowhow；项目约束规则走 /maestro-spec add。Triggers on \"knowledge audit\", \"知识审计\", \"knowledge harvest\", \"提取知识\", \"wiki 管理\", \"wiki health\", \"domain term\", \"领域术语\", \"extractors\". Arguments: [intent — e.g. '审计知识库' | 'harvest 这个 session' | 'wiki health' | '注册术语 MVP' | 'extractors']"
allowed-tools: Read Write Edit Bash Glob Grep teammate WebFetch maestro
disable-model-invocation: true
session-mode: none
---

<purpose>
Intent-driven knowledge-store management (the knowledge group extracted from maestro-manage; knowhow capture lives in /maestro-knowhow). No fixed grammar — state your intent; the command classifies it and runs the matching step. Explicit keywords still work as deterministic shortcuts.

| Operation | Keywords | Step |
|-----------|----------|------|
| audit | `audit` / 审计 / 清理 / prune / 检查知识库 | `knowledge-audit` |
| harvest | `harvest` / 提取 / 收割 / 从工件 | `harvest` |
| wiki | `wiki` / 知识图谱 / 连接 / 摘要 / 健康 | `wiki-manage` / `wiki-connect` / `wiki-digest` |
| extractors | `extractors` / 抽取器 / 生成抽取规则 | `extractors` |
| domain | `domain` / 领域术语 / 注册术语 / term | `domain-add` |
</purpose>

<dispatch>
Classify the intent in `$ARGUMENTS` into one operation, then run `maestro run skill <step>` and follow it completely.

1. Explicit keyword present → use its step (deterministic shortcut).
2. Otherwise infer from the intent (see the table above), e.g. "审计/清理知识库" → audit, "从工件/session 提取" → harvest, "知识图谱/wiki 健康" → wiki, "注册术语 X" → domain.
3. For wiki, classify the sub-action: `connect`/连接 → `wiki-connect`; `digest`/摘要 → `wiki-digest`; `health`/`search`/`cleanup`/`stats`/健康/检查/_(none)_ → `wiki-manage`.
4. Ambiguous → display the operation table and ask the user to pick.

### Routing rules

- Remaining tokens after classification become the chosen step's own arguments.
- Knowhow capture/management is NOT here — route to /maestro-knowhow (capture) or note that knowhow store audit is covered by `audit`.
</dispatch>
