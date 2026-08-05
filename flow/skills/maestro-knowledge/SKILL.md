---
name: maestro-knowledge
description: "Intent-driven knowledge-store and Run knowledge lifecycle management — audit/prune, stage candidates (with signal recording), review/resolve/promote candidates, harvest artifacts, or manage wiki/domain knowledge. Arguments: [intent — e.g. '审计知识库' | 'harvest 这个 session' | 'wiki health' | '注册术语 MVP' | 'extractors']"
allowed-tools: Read Write Edit Bash Glob Grep teammate WebFetch maestro
disable-model-invocation: true
session-mode: none
---

<purpose>
Intent-driven knowledge-store management. No fixed grammar — state your intent; the command classifies it and runs the matching workflow or direct lifecycle command. Explicit keywords still work as deterministic shortcuts.

| Operation | Keywords | Step |
|-----------|----------|------|
| audit | `audit` / 审计 / 清理 / prune / 检查知识库 | `knowledge-audit` |
| review | `review` / 审查 / 证据 / 下一步 / 匹配 / 去重 / 冲突检测 / 裁决 / 候选 / backlog | `maestro knowledge review <session-id> [--refresh] [--resolve <id> --as <choice> --reason "..."]` |
| record | `record` / 归因 / 检索命中 / 引用标记 / cited / consumed / attribution | `maestro knowledge record <ids...> [--signal <signal>] [--source search\|load\|manual] [--evidence <refs>]` |
| stage | `stage` / 暂存 / candidate / 沉淀候选 / cited / validated / contradicted / 记录命中关系 | `maestro knowledge stage ... [--signal <signal> --signal-ids <ids>]` |
| promote | `promote` / 晋升 / 发布候选 | `maestro knowledge promote ... [--all]` |
| harvest | `harvest` / 提取 / 收割 / 从工件 | `harvest` |
| wiki | `wiki` / 知识图谱 / 连接 / 摘要 / 健康 | `wiki-manage` / `wiki-connect` / `wiki-digest` |
| extractors | `extractors` / 抽取器 / 生成抽取规则 | `extractors` |
| domain | `domain` / 领域术语 / 注册术语 / term | `domain-add` |
</purpose>

<dispatch>
Classify the intent in `$ARGUMENTS` into one operation, then run `maestro run skill --platform pi <step>` and follow it completely.

1. Explicit keyword present → use its step or direct CLI lifecycle command (deterministic shortcut).
2. Otherwise infer from the intent (see the table above), e.g. "审计/清理知识库" → audit, "从工件/session 提取" → harvest, "知识图谱/wiki 健康" → wiki, "注册术语 X" → domain.
3. `review` / `record` / `stage` / `promote` map directly to the corresponding `maestro knowledge` CLI. `review --refresh` includes reconciliation; `review --resolve` includes disposition resolution; `record --signal --source` records pure attribution without staging a candidate (retrieval attribution after a search hit uses `--source search`); `stage --signal --signal-ids` includes signal recording with a candidate. Preserve stable knowledge IDs, graph aliases, Run ID, Session ID, signal, source, candidate ID, disposition, target, and reason exactly; do not translate these operations into direct spec/knowhow writes.
4. For wiki, classify the sub-action: `connect`/连接 → `wiki-connect`; `digest`/摘要 → `wiki-digest`; `health`/`search`/`cleanup`/`stats`/健康/检查/_(none)_ → `wiki-manage`.
5. Ambiguous → display the operation table and ask the user to pick.

### Routing rules

- Remaining tokens after classification become the chosen step's own arguments.
- During an active Run, reusable knowhow is staged here with `maestro knowledge stage knowhow ...`; project knowhow is written only by explicit promotion. Outside a Run, direct `/maestro-knowhow` capture remains available.
- Attribute search hits before citing: `maestro knowledge record <ids...> --signal consumed|cited|validated|contradicted --source search [--evidence <refs>]` records pure ledger attribution on the active Run without staging a candidate; use `stage --signal` only when a candidate is intended. `knowledge review --json` reports per-source totals (`input_totals_by_source`) and knowledge-id detail (`inputs`).
- For long or multiline content, use `maestro knowledge stage <target> "<title>" --content-file <path|->`; do not flatten structured knowledge into a shell argument.
- Use `maestro knowledge review <session-id>` as the human review surface. It shows fresh/missing/stale receipts, diversified evidence-backed matches, and copyable promote commands. `--refresh` reconciles all candidate source Runs. `--resolve <candidate-id> --as <choice> --reason "..."` resolves a candidate inline before displaying the refreshed view.
- Reconciliation is mandatory before completion but is not a popularity vote: exact identity, diversified semantic matches, and recorded/KG associations are evaluated separately. Unresolved semantic duplicate/conflict/supersession candidates may be sealed, but promotion must fail closed until resolved via `review --resolve`.
- `promote --all` promotes all eligible pending candidates (observed-only emits a warning); `--include-observed` has been removed.
- `audit --prune --apply` may only perform backed-up soft lifecycle transitions. Never physically delete knowledge or prune solely because it has low usage.
</dispatch>
