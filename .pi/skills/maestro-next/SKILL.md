---
name: maestro-next
description: "Default interactive entry for development intents — resolve one atomic step from read-only Session/Run context, confirm, execute, then stop"
argument-hint: "<intent>|--list|--suggest [-y] [--dry-run]"
allowed-tools:
  - AskUserQuestion
  - Bash
  - Edit
  - Glob
  - Grep
  - Read
  - Skill
  - Write
session-mode: run
contract:
---

<required_reading>
~/.maestro/workflows/run-mode.md
</required_reading>

<host_mirror>

**镜像协议**（状态对账由插件自动完成，LLM 只保留两个语义动作）：

| 动作 | 工具调用 | 说明 |
|------|----------|------|
| 步进 | `todo({ action: "next" })` | 激活下一步 + 注入上游摘要 + 绑定 skill |
| 完成宣告 | `goal done` | 触发前置校验（chain 全 completed + gates 无 failed）+ verifier |

- 禁止手工 `todo({ action: "create" })` / `todo({ action: "update" })` 镜像任务——bridge 从 canonical Session 自动物化。
- goal 由 bridge 从 Session intent + definition_of_done 自动派生。
- 上下文压缩后，只按当前 Run 的 `brief.command` 重新加载完整执行指南。

</host_mirror>

<purpose>
为开发意图推荐并执行一个 atomic step。Pi 不自行搜索、复制或改变历史 Session；它只消费宿主注入的 read-only Topic Session resolution、`ReuseAssessment`，以及该 Topic Session 中 sealed Run 的 authoritative output refs。多步工作可逐步调用本 Skill、创建 user-confirmed simple chain，或显式交给 `/maestro`；本 Skill 不无人值守遍历 chain。
</purpose>

<context_contract>

正常流程只接受以下 read model：

1. **Topic Session resolution（read-only）**：当前 topic 对应的 Session 结论、`session_id`、状态与证据；无结论或多候选时必须询问用户。
2. **ReuseAssessment（read-only）**：宿主给出的复用判定及原因。它只影响“使用已解析 Session 还是创建独立 Session”的建议，不授予任何历史 Session mutation 权限。
3. **Same-Session sealed outputs（read-only）**：只消费 `session_id` 等于 Topic Session 且 Run 已 sealed 的 artifact refs。跨 Session、未 sealed、路径猜测或按“最新文件”扫描得到的产物均不得作为 upstream。

禁止从 local project projection、目录时间戳或相似意图重新推导 Topic Session，也禁止把历史相似结果转换成 mutation 建议。
</context_contract>

<arguments_contract>

每个候选 step 必须携带顶层 `argument_requirements` 数组。每项结构为：

```json
{
  "name": "target",
  "required": true,
  "missing": true,
  "type": "string",
  "source": "unresolved",
  "default": null,
  "question": "Which target should this step operate on?"
}
```

- 必填字段：`name`、`required`、`missing`、`type`、`source`；`default`、`question` 可省略。
- `source` 只能说明真实来源，例如 `user`、`known_args`、`default`、`llm_inference`、`topic_session`、`upstream_ref`、`unresolved`。
- `missing=true` 时，只能依次使用已知 args、声明的 default、LLM 基于明确证据的推断，或 `user prompt` 的用户回答补齐；不得伪造 resolved value。
- LLM 推断不唯一、风险较高或会改变范围时，必须询问用户。补齐后更新 `missing=false` 与实际 `source`。
- artifact 类输入必须来自 authoritative same-Session sealed output ref，不得手工拼 source/path 参数或文件路径。
</arguments_contract>

<context>

`$ARGUMENTS` = intent text + optional flags。

| Flag | Effect |
|------|--------|
| `-y` / `--yes` | 仅跳过当前 atomic step 的确认，不自动执行后续建议 |
| `--dry-run` | 展示 recommendation 与 argument requirements 后停止 |
| `--suggest` | suggest-only；展示 recommendation 后停止 |
| `--top N` | 展示前 N 个候选，默认 3 |
| `--list` | 按 cluster 展示可用 steps |
| `--lite` | 只加载知识并回答，不创建 Run |
| `--run` | 强制 standard single-Run channel |
| `--chain` | 用户明确要求多步时，创建 simple manual chain 后停止，不自动派发 |

Candidate pool 仅包含 first-tier registered steps；`maestro`、`maestro-ralph` 不进入候选池。
</context>

<invariants>

1. 一次只执行一个 atomic step；`-y` 也必须在当前 step 完成后停止。
2. Session 选择只消费 Topic Session resolution 与 `ReuseAssessment`，不运行历史 mutation 流程。
3. upstream 只接受当前 Topic Session 的 sealed Run output refs。
4. `run next` birth packet 是紧凑路由包，不是执行手册。只读取 `session_id`、`run_id`、`run_dir`、step identity、entry blockers、authoritative upstream refs 与 `brief.command`。
5. 完整 workflow、required reading、gates、目标和执行规则只从 `maestro run brief --platform pi <run_id>` 加载。
6. `run complete` 返回的 `next` 必须满足 `suggest_only=true`；只展示，不在同一动作中执行其 command。
7. 所有 missing arguments 按 `<arguments_contract>` 由已知输入、default、LLM 明确推断或用户补齐。
8. Session/Run canonical files 只读；状态变化只能由正式 CLI lifecycle verb 完成。
9. simple chain 只通过 `maestro run start --chain ... --no-dispatch` 或 `maestro session create --chain ...` 创建；不得为同一任务的每个 skill 新建独立 Session。
10. 中途新增下一步用 `maestro run edit <cmd...>` 修改未来 chain，不调用新的 `run start` 制造第二个 Topic Session。
</invariants>

<workflow>

### 1. Parse and resolve

1. 解析 intent 与 flags。
2. 读取宿主注入的 Topic Session resolution、`ReuseAssessment` 与 same-Session sealed output refs。
3. resolution 为空或 ambiguous 时，用 `user prompt` 让用户选择 topic/session boundary；不要自行选择历史候选。
4. 从 intent、resolved topic 与 first-tier registry 推导 lifecycle position 和候选 step。

### 2. Rank and present

按以下优先级评分：明确 intent match → 宿主给出的 Topic Session position → authoritative upstream availability → precondition。展示：

```text
Recommended: <step>
Reason: <why>
Topic Session: <session_id|none>
ReuseAssessment: <decision + evidence>
Arguments: <argument_requirements>
Alternatives: <up to N-1>
```

`--dry-run` / `--suggest` 到此结束。

### 3. Resolve arguments

1. 为选中 step 生成 `argument_requirements`。
2. 绑定 known args、declared defaults、Topic Session 与 authoritative upstream refs。
3. 对 remaining `missing=true` 项，先做可证实且唯一的 LLM inference；否则询问用户。
4. 任一 required argument 仍 missing 时 BLOCK，不创建或推进 Run。

### 4. Execute one step

Standalone step：

1. 使用已解析的 `argument_requirements` 创建当前 step 的 Run：
   `maestro run start "<intent>" --cmd <step> --arg "<resolved step input>" --platform pi --workflow-root .`。
2. 不得用路径扫描补 upstream；artifact 输入必须来自 authoritative same-Session sealed refs。
3. **Entry blocker 降级（execute 专属）**：若 step == execute 且 start result 的 `entry_blockers` 非空（缺少 current-plan）：
   - 检查 upstream 中是否有替代 artifact（latest-review、latest-debug、latest-fix-directions）。
   - 按 prepare/execute.md 的降级路由表处置：
     - 小范围（≤3 findings，每个 ≤2 文件）→ seal run 为 needs-retry，展示 /maestro-companion
     - 较大范围 → seal run 为 needs-retry，展示 /odyssey-planex
     - 无替代 upstream → seal run 为 blocked，展示 E001 + 建议 /plan
   - 不得带着 blocked 的 execute run 继续加载 brief。
4. 按 start result 的 `brief.command` 加载完整执行指南。
5. 执行 workflow，写正式 deliverables，运行 gates。
6. `maestro run done <run_id> --verdict done --workflow-root .`。

Existing chain step：

1. `maestro run next --session <session_id> --workflow-root .`。
2. birth packet 只作 identity/ref routing；不得把 packet 摘要当成 workflow body。
3. 立即执行 packet 的 `brief.command`，以 brief 为唯一完整执行指南。
4. 完成当前 step 后调用 `maestro run done <run_id> --verdict done --workflow-root .`。

Multi-step simple chain：

1. 仅当用户明确选择 `--chain` 或在确认界面选择 simple chain 时进入。
2. 将 2-5 个 first-tier step 排成命令名列表，展示 topic、chain、argument gaps。
3. 用户确认后调用：
   `maestro run start "<intent>" --chain <cmd...> --no-dispatch --platform pi --workflow-root .`。
4. 展示返回的 `session_id` 与 `maestro run next --session <session_id>`，然后停止；后续每次推进都必须重新由用户确认。
5. 如果用户在同一任务中追加 step，使用 `maestro run edit <cmd...> --after latest --workflow-root .`，不要创建第二个 Session。

### 5. Stop at suggest-only next

读取 completion result 的 `next`：

- `suggest_only=true`：展示 command、reason、preconditions，并停止。
- 缺少 `suggest_only=true`：视为 contract violation，BLOCK。

用户要继续时重新调用 `/maestro-next`，由新一轮 Topic Session resolution 决定下一步。
</workflow>

<errors>

| Code | Condition | Action |
|------|-----------|--------|
| E001 | intent 缺失且无法推导 | user prompt 一轮；仍缺失则停止 |
| E002 | Topic Session resolution ambiguous | 展示候选证据并让用户选择 |
| E003 | required argument 仍 missing | BLOCK 并询问对应 `question` |
| E004 | upstream 非同 Session 或 Run 未 sealed | 拒绝该 ref，要求 authoritative replacement |
| E005 | birth packet 无 `brief.command` | BLOCK，不猜 workflow path |
| E006 | completion `next` 非 suggest-only | BLOCK，不自动执行 |
</errors>

<done>

- [ ] 只消费 Topic Session resolution、`ReuseAssessment`、same-Session sealed outputs
- [ ] 每项参数都有 `argument_requirements` descriptor，required 参数均 `missing=false`
- [ ] birth packet 保持紧凑，完整指南来自 brief
- [ ] 当前 atomic step 已验证并 complete
- [ ] completion next 仅作为 suggest-only 展示
</done>
