---
name: maestro-ralph
description: "Adaptive lifecycle orchestrator — compose a canonical chain, dispatch one ralph-executor per step, evaluate decisions, and loop"
argument-hint: "<intent>|status|continue [-y] [--amend] [--roadmap]"
allowed-tools:
  - AskUserQuestion
  - Bash
  - Edit
  - Glob
  - Grep
  - Read
  - SendMessage
  - Skill
  - Write
  - maestro
  - teammate
  - todo
session-mode: run
contract:
---

<required_reading>
~/.maestro/workflows/run-mode.md
</required_reading>

<deferred_reading>
- [ralph-amend-goal.md](~/.maestro/workflows/ralph-amend-goal.md) — read only when `--amend` is active
- [fixed workflow scripts](~/.maestro/workflows/swarm/wf-*.js) — read metadata only when an execution step explicitly selects a fixed parallel engine
- [dynamic workflow scripts](~/.maestro/workflows/dynamic/uwf-*.js) — read metadata only when an execution step explicitly selects a generated parallel engine
</deferred_reading>

<purpose>
Locate lifecycle position → build or continue a canonical coordinator chain → resolve typed inputs → dispatch one unnamed `teammate(ralph-executor)` per execution step → evaluate evidence and drift → complete the Run → adjudicate decision nodes → loop。Ralph 不再从 local projection 重建 lifecycle、artifact source 或 path args；它只消费 authoritative Topic Session resolution、`ReuseAssessment` 和 selected same-Session sealed artifact refs。
</purpose>

<cli_surface>

Human-facing orchestration should stay on one topic Session:

- Start one step with `maestro run start "<intent>" --cmd <step> --arg "<step input>" --platform pi --workflow-root .`
- Start a simple chain with `maestro run start "<intent>" --chain analyze plan execute --no-dispatch --workflow-root .`
- Complete the active Run with `maestro run done [run_id] --verdict done|done-with-concerns|needs-retry|blocked --workflow-root .`
- Add or change future simple steps with `maestro run edit <cmd...> --after latest --workflow-root .`

Ralph may still use `maestro session create ... --chain-file -` internally when the chain needs advanced JSON fields (`decision_points`, `decomposition`, typed `argument_requirements`, retry metadata, or executor hints). That path is machine/advanced, not the default human command.

</cli_surface>

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

<context_contract>

### Read-only inputs

1. **Topic Session resolution**：宿主解析的 topic Session identity、status、chain position 与 resolution evidence。
2. **ReuseAssessment**：是否使用该 Topic Session 或创建独立 Session 的只读评估；不会授予历史 Session mutation 权限。
3. **Selected artifact refs**：来自该 Topic Session 的 sealed Runs，由 canonical ArtifactRegistry/Run contract 选择；包含 artifact identity、kind、alias、content identity 与相对位置。
4. **Canonical chain/decision view**：当前 Session 的 queue head、running Run、decision point 与 retry budget。

### Prohibited projections

- 不扫描 project projection、artifact 目录或“最新文件”来推导 Session/lifecycle。
- 不按文件路径、artifact id 猜测或拼装 step source args。
- 不读取跨 Session 或未 sealed output 作为 upstream、evidence、scope verdict 或 plan input。
- 不从 completion hint 直接推进下一步；hint 是 suggest-only。
</context_contract>

<arguments_contract>

每个 execution step 都携带顶层 `argument_requirements`：

```json
{
  "command": "plan",
  "argument_requirements": [
    {
      "name": "analysis",
      "required": true,
      "missing": false,
      "type": "artifact_ref",
      "source": "selected_artifact_ref",
      "question": "Which sealed analysis artifact should this plan consume?"
    },
    {
      "name": "quality_mode",
      "required": false,
      "missing": false,
      "type": "enum:quick|standard|full",
      "source": "default",
      "default": "standard"
    }
  ]
}
```

规则：

- 每项必须含 `name`、`required`、`missing`、`type`、`source`；`default` / `question` 可省略。
- `source` 必须是真实来源：`user`、`known_args`、`default`、`llm_inference`、`topic_session`、`selected_artifact_ref`、`unresolved`。
- `missing=true` 只能用 known args、declared default、LLM 基于明确 evidence 的唯一推断或 `user prompt` 回答补齐。
- LLM 推断若不唯一、改变 scope 或选择不同 artifact，必须询问用户；不得把猜测标成 resolved。
- artifact input 始终绑定 selected authoritative ref。executor 从 brief/upstream contract 消费 ref，不由 coordinator 拼 path args。
</arguments_contract>

<context>

`$ARGUMENTS` = intent、`status` / `continue` 或 flags。

- `-y`：仅省略安全 confirmation；ambiguous Topic Session、scope-changing choice、required missing input 仍必须询问。
- `--roadmap`：允许显式多发布 roadmap path。
- `--amend`：读取 `ralph-amend-goal.md`，把变更作为 canonical decomposition amendment。
- `--engine sequential|swarm|universal`：只影响单个 execution step 的执行策略，不拥有 Session 状态决策。

`continue` 仅表示对已解析 Topic Session 的 canonical queue 重新定位，不触发历史查找。
</context>

<invariants>

1. Ralph owns the coordinator loop：step ordering、retry、fix、escalation、decision 与 completion 由本 FSM 控制。
2. One unnamed executor per execution step；decision evaluator 只读。
3. Session selection 只消费 Topic Session resolution 与 `ReuseAssessment`。
4. selected artifacts 必须属于 Topic Session 且来源 Run 已 sealed。
5. 每个 execution step 的 args 只由 `argument_requirements` 表达；required missing 未补齐时不得 dispatch。
6. `run next` birth packet 必须保持紧凑，只含 identity、step、entry blockers、selected upstream refs 与 `brief.command`。
7. brief 是完整 execution guide 的唯一来源；birth packet 不承载 workflow body、完整 goal、全文 reading 或重复 handoff 投影。
8. coordinator 不从 projection 手工生成 source/path args；authoritative upstream 与 selected artifact refs 单源覆盖。
9. Run completion 由 coordinator 调 `run complete --verdict`；executor 不自行推进 chain。
10. completion result 的 `next` 必须为 `suggest_only=true`；只能记录和展示，不能直接执行。
11. canonical Session/Run/ArtifactRegistry files 不由 prompt 直接写，所有状态改变走正式 CLI lifecycle verbs。
12. parallel engine 是 step-local accelerator，不修改 Session、chain 或 decisions。
13. `auto_confirm` 只来自用户 `-y`，不消除 missing/ambiguous 状态。
14. Invariant violation = BLOCK。
</invariants>

<state_machine>

```text
S_PARSE
  -> S_RESOLVE_TOPIC
  -> S_INFER_POSITION
  -> S_DECOMPOSE
  -> S_BUILD_CHAIN
  -> S_CREATE_OR_BIND
  -> S_LOCATE
       -> S_RESOLVE_ARGS -> S_DISPATCH -> S_EXTRACT -> S_DRIFT -> S_COMPLETE -> S_LOCATE
       -> S_DECISION_EVAL -> S_DECISION_APPLY -> S_LOCATE
       -> S_SESSION_DONE
```

`S_COMPLETE` 不跟随 returned hint。loop 只能由 FSM 重新读取 canonical queue 后进入 `S_LOCATE`。
</state_machine>

<actions>

### A_RESOLVE_TOPIC

1. 读取 Topic Session resolution 和 `ReuseAssessment`。
2. `reuse`：绑定 resolution 指定的 coordinator Session。
3. `fresh`：在确认 decomposition 后创建独立 coordinator Session，不复制历史状态。
4. `clarify` / ambiguous：展示 resolution evidence 并询问用户；无答案则停止。
5. 从 selected artifacts 中过滤出绑定 Session 的 sealed refs；其他 refs 全部拒绝。

### A_INFER_POSITION

从 canonical Topic Session view 与 selected artifact kinds 推断 position：

| Authoritative condition | Position |
|-------------------------|----------|
| 无 Topic Session 且无 selected artifact | analyze-macro |
| Topic Session 无 sealed analysis | analyze |
| selected analysis，缺 plan | plan |
| selected plan，缺 execution evidence | execute |
| selected execution evidence 有 gaps | scoped fix loop |
| selected execution evidence clean，缺 review/test | quality pipeline |
| chain execution/decision nodes 全 terminal | session completion gate |

禁止以 local phase number、目录顺序或路径存在性覆盖 canonical view。

### A_DECOMPOSE

Broad intent 必须澄清 in-scope/out-of-scope、constraints、definition of done。生成 outcome-oriented goals：

```json
{
  "id": "G1",
  "goal": "<deliverable>",
  "boundary": "<scope boundary>",
  "done_when": "<objective acceptance>",
  "evidence": "<expected artifact/test kind>",
  "status": "pending",
  "completion_confirmed": false
}
```

已由上游 coordinator 拥有的 decomposition 只校验 shape，不重复提问或覆盖。

### A_BUILD_CHAIN

1. 从 canonical position 构建最小 lifecycle chain；decision nodes 紧随 evidence-producing steps。
2. 每个 execution step 只定义 `command`、`stage`、`goal_ref`、`retry_max`、`argument_requirements`。
3. 用 `maestro ralph skills --platform pi --json --quiet` 一次性预校验 command。
4. 将 selected artifacts 绑定到匹配 type 的 `argument_requirements`，`source=selected_artifact_ref`。
5. 不把 artifact id/path 转写成重复 CLI source/path 参数；Run creation 与 brief 从 authoritative refs 解析实际输入。
6. UI delivery 必须插入 browser/e2e evidence gate；纯 backend 不插入 frontend gate。
7. decomposed goals 必须插入 final goal-audit decision。
8. 任务中途新增工作时，保持同一 Topic Session；simple future steps 用 `maestro run edit`，需要 decision/fix/goals 元数据时才用 `session chain insert|replace|skip`。

### A_CREATE_OR_BIND

- 绑定 Topic Session 时，校验 engine/coordinator ownership 与 chain compatibility。
- 创建独立 Session 时：简单 command chain 使用 `maestro run start "<intent>" --chain <cmd...> --no-dispatch` 或 `maestro session create "<topic>" --chain <cmd...>`；含 decision/decomposition/typed args 的 coordinator chain 才通过 `maestro session create ... --engine ralph --chain-file -` 写 canonical chain。
- prompt 层不写 canonical JSON 或 sidecar projection。

### A_RESOLVE_ARGS

1. 读取当前 canonical step 的 `argument_requirements`。
2. 绑定 known args、declared defaults、Topic Session fields、selected artifact refs。
3. 对 `missing=true` 项：唯一且有 evidence 时允许 LLM inference；否则按 `question` 询问用户。
4. 任一 `required=true && missing=true` 时 BLOCK。
5. resolved descriptors 由正式 Session chain update verb 持久化；不生成另一份投影。

### A_DISPATCH

1. 派发 unnamed `teammate(ralph-executor)`。
2. executor 调 `maestro run next --session <session_id>` 创建当前 Run。
3. 校验 compact birth packet：Session identity、Run identity、step identity、entry blockers、selected upstream refs、`brief.command`。
4. blocker 非空时返回 coordinator，不执行 workflow。
5. executor 立即执行 `brief.command`，完整 workflow、目标、gates、reading、outputs 与验证规则全部以 brief 为准。
6. executor 执行并回传 `STATUS`、`SUMMARY`、artifact/evidence refs、concerns、decisions、notes；不得改变 chain。

### A_EXTRACT_AND_DRIFT

从 executor result 与 same-Session sealed/registered outputs 提取信号。drift 判定：

- `ALIGNED`：交付与 goal/done_when 一致。
- `MINOR_DRIFT`：非阻断差异，记录 concern。
- `MAJOR_DRIFT`：范围或 acceptance 偏离；按 retry budget 选择 needs-retry 或 escalate。

证据缺失时不得从文件名或输出文本猜 artifact identity。

### A_COMPLETE

1. coordinator 调 `maestro run complete --session <session_id> --verdict <done|done-with-concerns|needs-retry|blocked> ...`。
2. 检查 `next.suggest_only === true`；记录 action、command、reason、preconditions。
3. 不执行 `next.command`。若 chain 仍可运行，由 FSM 重新读取 canonical queue 后进入 `S_LOCATE`。
4. completion next 缺少 suggest-only 标记时 BLOCK。

### A_DECISION_EVAL

Evaluator 只读 Topic Session 的 sealed evidence 与 goal criteria，输出：

```json
{
  "verdict": "proceed|fix|escalate",
  "confidence_score": 0,
  "evidence_refs": [],
  "gaps": [],
  "parse_failed": false
}
```

解析失败时 conservative `fix`、`confidence_score=0`、`parse_failed=true`。裁决只通过正式 decision/chain lifecycle verb 落盘。

### A_SESSION_DONE

1. 校验 all goals、all execution/decision nodes、Run gates、required outputs。
2. gates 不绿则生成 scoped fix decision。
3. 全绿时宣告 `goal done`。
4. Session sealing 仍作为 completion 的 suggest-only next 展示，不在当前 complete 动作内隐式执行。
</actions>

<engines>

`sequential`、`swarm`、`universal` 仅是单个 execution step 的执行策略：

- 输入来自该 Run brief 与 selected artifact refs。
- 输出写入当前 Run output directory 并满足对应 artifact contract。
- 不拥有 Session identity、chain ordering、decision 或 completion。
- 固定/生成脚本不得引入第二套 lifecycle/artifact projection。
</engines>

<errors>

| Code | Condition | Action |
|------|-----------|--------|
| E001 | Topic Session ambiguous/absent | user prompt；无结论则停止 |
| E002 | required argument missing | BLOCK 并显示 descriptor question |
| E003 | selected artifact 跨 Session 或未 sealed | 拒绝 ref |
| E004 | missing command or brief pointer | BLOCK，不猜路径 |
| E005 | executor failed | 依据 retry budget 处理，不改变 Session identity |
| E006 | evaluator output invalid | conservative fix + parse_failed evidence |
| E007 | completion next 非 suggest-only | BLOCK，不执行 hint |
</errors>

<done>

- [ ] Topic Session resolution 与 `ReuseAssessment` 只读消费
- [ ] selected artifacts 全部来自同 Session sealed Runs
- [ ] chain 未包含重复 lifecycle/artifact projection
- [ ] 每个 execution step 有结构化 `argument_requirements`
- [ ] required missing 已由 known args/default/LLM evidence/user 补齐
- [ ] birth packet 紧凑，完整执行指南来自 brief
- [ ] coordinator 完成当前 Run，next 仅 suggest-only
- [ ] decision 与 goals 有 evidence-backed closure
</done>
