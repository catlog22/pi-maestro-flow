---
name: maestro
description: Auto-route intent to a confirmed multi-step chain and coordinate one Run at a time from authoritative Session/Run context
argument-hint: "<intent> [-y] [--dry-run] [--super]"
allowed-tools:
  - AskUserQuestion
  - Bash
  - Edit
  - Glob
  - Grep
  - Read
  - SendMessage
  - Write
  - teammate
  - todo
session-mode: run
contract:
---

<required_reading>
~/.maestro/workflows/run-mode.md
</required_reading>

<deferred_reading>
- [maestro.md](~/.maestro/workflows/maestro.md) — read at classification and chain selection
- [maestro-super.md](~/.maestro/workflows/maestro-super.md) — read only when `--super` is active
- [node-catalog](~/.maestro/templates/workflows/specs/node-catalog.md) — read when composing a reusable template
- [template-schema](~/.maestro/templates/workflows/specs/template-schema.md) — read when validating a reusable template
</deferred_reading>

<host_mirror>

**镜像协议**（状态对账由插件自动完成，LLM 只保留两个语义动作）：

| 动作 | 工具调用 | 说明 |
|------|----------|------|
| 步进 | `todo({ action: "next" })` | 激活下一步 + 注入上游摘要 + 绑定 skill |
| 完成宣告 | `goal done` | 触发前置校验（chain 全 completed + gates 无 failed）+ verifier |

- 禁止手工 `todo({ action: "create" })` / `todo({ action: "update" })` 镜像任务——bridge 从 canonical Session 自动物化。
- goal 由 bridge 从 Session intent + definition_of_done 自动派生。
- 上下文压缩后，仅通过当前 Run 的 `brief.command` 重挂完整执行协议。

</host_mirror>

<purpose>
Classify intent → confirm a chain → create or use the resolved Topic Session → dispatch one executor per step → evaluate evidence and decisions → complete the Run。Pi 的 reuse 决策是 read-only：只消费 Topic Session resolution、`ReuseAssessment` 和该 Session 中 sealed Run 的 authoritative outputs，不实施历史 Session mutation。
</purpose>

<cli_surface>

Human-facing entry points prefer the concise Run/Session wrappers:

- Single step: `maestro run start "<intent>" --cmd <step> --arg "<step input>" --platform pi --workflow-root .`
- Simple command chain: `maestro run start "<intent>" --chain analyze plan execute --no-dispatch --workflow-root .`
- Simple Session creation: `maestro session create "<topic>" --chain analyze execute --engine manual --workflow-root .`
- Completion: `maestro run done [run_id] --verdict done|done-with-concerns|needs-retry|blocked --workflow-root .`
- Mid-task changes: `maestro run edit <cmd...> --after latest --workflow-root .`

`maestro session create ... --chain-file -` is reserved for advanced coordinator chains that need structured JSON fields such as `decision_points`, `decomposition`, `argument_requirements`, retry budgets, or executor metadata. Do not present `--chain-file` as the default hand-written path.

</cli_surface>

<input_contract>

宿主为本 Skill 注入三个 read-only 输入：

1. **Topic Session resolution**：topic 对应的 Session 结论、`session_id`、status、resolution evidence。
2. **ReuseAssessment**：`reuse`、`fresh` 或 `clarify` 类判定及理由；这是建议输入，不是 mutation authority。
3. **Same-Session sealed outputs**：只包含 Topic Session 内 sealed Run 的 artifact refs、aliases、kind 与 content identity。

约束：

- 不从 local project projection、目录枚举、时间戳或相似 intent 推导 Session。
- 不建议或执行历史 Session mutation 命令。
- 跨 Session 或未 sealed output 不能进入 upstream、decision evidence 或 step args。
- resolution 为 ambiguous/absent 且创建边界不明确时，必须询问用户。
</input_contract>

<arguments_contract>

每个 execution step 使用顶层 `argument_requirements` 数组：

```json
{
  "command": "execute",
  "argument_requirements": [
    {
      "name": "plan",
      "required": true,
      "missing": false,
      "type": "artifact_ref",
      "source": "upstream_ref",
      "question": "Which sealed plan artifact should be executed?"
    }
  ]
}
```

每项必须包含 `name`、`required`、`missing`、`type`、`source`；`default` 与 `question` 可省略。`missing=true` 只能由 known args、declared default、基于明确证据的 LLM inference 或 `user prompt` 的回答补齐。不得把猜测标为 resolved。artifact 输入必须绑定 authoritative same-Session sealed output ref，禁止手工拼路径或来源参数。
</arguments_contract>

<context>

`$ARGUMENTS` = intent + flags。

- `-y` / `--yes`：跳过 clarification/confirmation 中可安全省略的交互；不得跳过 ambiguous Topic Session 或 required missing input。
- `--dry-run`：展示 chain、Topic Session decision、`argument_requirements` 后停止。
- `--super`：加载 `maestro-super.md` 的附加质量规则。
- `--compose` / `--play`：仅处理模板定义或读取；模板不能绕过本 Skill 的 Session/Run contract。

`continue` / `next` / `go` 只表示“对宿主给出的当前 Topic Session 重新定位 queue head”，不触发历史 Session 查找。
</context>

<invariants>

1. Session before execution：每个 step 属于一个 canonical Session 和一个 standard Run。
2. One executor per step：执行 step 通过 unnamed `teammate(ralph-executor)` 派发；decision node 由 coordinator 评估。
3. Canonical files 不由 prompt 直接写；只通过正式 lifecycle CLI verbs 更新。
4. Session selection 只读消费 Topic Session resolution 与 `ReuseAssessment`。
5. upstream 与 evidence 只来自 resolved Topic Session 的 sealed Run outputs。
6. 每个 step 的参数都由 `argument_requirements` 描述；required missing 未补齐时不得 dispatch。
7. `run next` birth packet 只提供紧凑 identity/ref routing：`session_id`、`run_id`、`run_dir`、step identity、entry blockers、authoritative upstream refs、`brief.command`。
8. 完整 workflow、目标、gates、required/deferred reading 与执行规范只从 brief 加载。
9. `run complete` 的 `next` 只按 `suggest_only=true` 读取和展示；不得直接执行 completion 返回的 command。
10. FSM 独占 coordinator Session 的 step ordering、retry、fix 与 decision；`maestro-next` 不作为 chain step。
11. `-y` 只来自用户输入，且不会把 missing/ambiguous 输入变成 resolved。
12. Invariant violation = BLOCK。
</invariants>

<state_machine>

```text
S_PARSE
  -> S_RESOLVE_TOPIC
  -> S_CLASSIFY
  -> S_DECOMPOSE
  -> S_BUILD_CHAIN
  -> S_CONFIRM
  -> S_CREATE_OR_BIND_SESSION
  -> S_LOCATE_STEP
       -> S_DISPATCH_STEP -> S_EVALUATE -> S_COMPLETE -> S_LOCATE_STEP
       -> S_EVALUATE_DECISION -> S_APPLY_DECISION -> S_LOCATE_STEP
       -> S_DONE
```

`S_COMPLETE` 只消费 suggest-only next；循环权威来自重新读取 canonical Session queue，而不是自动执行 completion hint。
</state_machine>

<actions>

### A_RESOLVE_TOPIC

1. 读取 Topic Session resolution 与 `ReuseAssessment`。
2. `reuse`：绑定已解析的 running Topic Session。
3. `fresh`：准备创建一个新的 coordinator Session，不复制历史 Session state。
4. `clarify` / ambiguous：展示证据并询问用户；未解决则停止。
5. 过滤 outputs：仅保留绑定 Session 的 sealed Run artifact refs。

### A_CLASSIFY

1. 读取 deferred `maestro.md`。
2. 基于 intent 与 available authoritative upstream refs 选择最小闭环 chain。
3. 记录 matched pattern、excluded alternatives、confidence。
4. 广泛重构/迁移/重写意图必须澄清 scope、constraints、definition of done，即使 `-y` 存在。

### A_DECOMPOSE

生成 outcome-oriented goals：

```json
{
  "id": "G1",
  "goal": "<observable deliverable>",
  "boundary": "<in/out scope>",
  "done_when": "<objective check>",
  "evidence": "<artifact kind or test path>",
  "status": "pending"
}
```

不得把 lifecycle stage 列表冒充 goal decomposition。

### A_BUILD_CHAIN

1. 以 intent、goals 与已解析 Topic Session position 生成 execution/decision steps。
2. 每个 execution step 写 `command`、`stage`、`goal_ref`、`retry_max`、`argument_requirements`。
3. 使用 `maestro ralph skills --platform pi --json --quiet` 预校验 command；missing command 阻断建链。
4. artifact 参数只绑定 authoritative `upstream_ref` 或保持 `missing=true`；不扫描路径，不从状态投影手工生成来源参数。
5. required missing 依次尝试 known args、default、LLM 明确推断、user prompt；仍 missing 则 BLOCK。
6. 中途新增或替换未来步骤时，优先用 `maestro run edit` 表达 simple chain mutation；只有 decision/fix/goals 等高级字段需要时才使用 `session chain insert|replace|skip`。

### A_CREATE_OR_BIND_SESSION

- `ReuseAssessment=reuse`：使用 Topic Session resolution 指定的 Session。
- `ReuseAssessment=fresh`：简单命令链使用 `maestro run start "<intent>" --chain <cmd...> --no-dispatch` 或 `maestro session create "<topic>" --chain <cmd...>`；高级 coordinator chain 才通过 `maestro session create ... --engine ralph --chain-file -` 创建。
- 禁止复制、导入、分叉或重新绑定历史 Session。

### A_DISPATCH_STEP

1. 调 `maestro run next --session <session_id>`。
2. 校验 birth packet 指向绑定的 Topic Session；只读取 identity、refs、entry blockers 与 `brief.command`。
3. entry blocker 存在时停止派发并报告。
4. executor 首个动作执行 `brief.command`；brief 是完整执行指南唯一来源。
5. executor 按 brief 执行、验证并返回 structured result；不得从 birth packet 摘要重建 workflow。

### A_COMPLETE

1. 根据 executor evidence 选择 `done`、`done-with-concerns`、`needs-retry` 或 `blocked` verdict。
2. coordinator 调 `maestro run complete --session <session_id> --verdict <verdict> ...`。
3. 只读取 result.next，且必须为 `suggest_only=true`；记录 command/reason/preconditions 供展示。
4. 不执行 result.next.command。若继续循环，重新读取 canonical Session queue 并进入 `S_LOCATE_STEP`。

### A_EVALUATE_DECISION

Decision evaluator 只读同 Session sealed evidence，输出 verdict、confidence、evidence refs、gaps。解析失败时使用 conservative fix，并记录 `parse_failed=true`。裁决仅通过正式 `run decide` / chain lifecycle verb 落盘。

### A_DONE

所有 execution/decision steps terminal 后运行 completion gates。只有 gates 全绿才能宣告 goal done；seal suggestion 仍作为 suggest-only next 展示，由显式后续动作处理。
</actions>

<errors>

| Code | Condition | Action |
|------|-----------|--------|
| E001 | Topic Session ambiguous | user prompt；无结论则停止 |
| E002 | required argument missing | BLOCK，展示对应 question |
| E003 | cross-Session or unsealed upstream | 拒绝 ref |
| E004 | birth packet 缺 `brief.command` | BLOCK，不猜指南路径 |
| E005 | executor failure | 按 retry policy 评估，不改变 Session identity |
| E006 | completion next 非 suggest-only | BLOCK，不自动执行 |
</errors>

<done>

- [ ] Topic Session resolution 与 `ReuseAssessment` 已作为 read-only 输入消费
- [ ] upstream/evidence 全部来自同 Session sealed Runs
- [ ] 所有 execution steps 的 `argument_requirements` 已 resolved
- [ ] birth packet 仅作紧凑 routing，brief 提供完整指南
- [ ] completion next 只做 suggest-only 展示
- [ ] 未直接写 canonical Session/Run files
</done>
