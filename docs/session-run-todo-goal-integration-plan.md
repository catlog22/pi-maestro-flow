# 已实施：todo/goal × Session-Run 长时执行增强 + TUI 方案

> 状态：实施完成（P0–P6，AC1–AC12 全部通过）
> 日期：2026-07-15
> 完成日期：2026-07-15
> 参考：`D:\maestro2\guide\session-run-structure-guide.md`（Session → Run → Artifact 三级模型，schema v1.1）
> 范围：`packages/pi-maestro-flow` 插件（todo/goal/statusline/TUI）+ `.pi/skills/` 协议层

---

## 实施结果

P0–P6 已全部落地。主要提交为：

- `af8fec5e`：加固 Session gate 与 Skill 漂移；
- `7e3303e5`：接通 Workflow Session 运行闭环；
- `45c2fcc0`：规范化打包后的 Pi skills；
- `541dde99`：完成本地依赖 packed consumer 闭环；
- `7c40ca21`：补齐 Session/Run 验收闭环；
- `7cce3533`：将冲突的 `/session` 改为 `/maestro-session`；
- `177ffc98`：收口 GENERALIZE 阶段发现的恢复、gate、投影和 continuation 缺陷；
- `668a4c24`：隔离 packed consumer 的本地 `npm link` global prefix。

最终实现保持 `Plan → Goal → Todo → Execute`，canonical 状态只由 Maestro CLI 写入；Goal/Todo 为可重建投影，Coordinator 是唯一 continuation owner。打包验收使用 `pi-maestro-flow` tarball 的真实隔离安装，同时直接 `npm link D:\maestro2` 与本地 `pi-maestro-teammate`，确保验证本地最新依赖且不把本地路径写入发布 manifest/lock。

---

## 零、最终架构裁决

本规划采用以下不可回退的边界，避免 Session、Run、Goal、Todo、Skill 各自形成一套状态机：

| 对象 | 定位 | 是否权威 | 唯一写入者 |
|---|---|---:|---|
| Workflow Session | 长期意图、边界、预算、编排链 | 是 | `maestro run` / SessionStore CLI |
| Skill Run | 一次 step 调用或重试 attempt 的执行实例 | 是 | `maestro run` / RunStore CLI |
| Artifact Registry | Run 产物、hash、alias、替代链 | 是 | Artifact Runtime CLI |
| Goal | 当前 Workflow Session objective 的宿主投影；提供预算、pause/resume、最终 verifier | 否 | Pi 插件 bridge（执行 Coordinator 决策） |
| Todo | Session chain / Run 状态的步骤 DAG 投影；提供 next、依赖和 skill 激活 | 否 | Pi 插件 bridge |
| TUI | Goal/Todo/Run/Artifact 的统一只读视图与控制入口 | 否 | `WorkflowViewModel` |

四条总裁决：

1. **CLI 是 canonical writer。** Pi 插件不得直接编辑 `state.json`、`session.json`、`run.json`、`artifacts.json`；插件控制动作必须通过 CLI adapter 调用同一个 Store。
2. **Goal/Todo 是可重建投影。** CLI 从不读取 Goal/Todo 作为恢复真相源；删除宿主投影后必须能从 canonical files 重建。
3. **一个续跑所有者。** 有 active Workflow Session 时，Goal 不再独立决定 continuation，由 `WorkflowCoordinator` 综合 Run、gate、Todo、用户暂停和 pending message 后统一推进。
4. **Skill Definition、Skill Activation、Skill Run 分离。** Skill 文件是定义；`activationId + stackRevision` 是不可变加载快照；Run 是带 attempt、gate、checkpoint、artifact 和 handoff 的执行实例。

推荐的整体关系：

```text
Workflow Session（长期目标）
├── Run 001 analyze
├── Run 002 plan
├── Run 003 execute
│   ├── Todo：当前根步骤投影
│   ├── Skill stack：primary / guard / support
│   ├── Teammate child runs
│   ├── Gates / Checkpoint
│   └── Artifacts / Handoff
└── Run 004 verify

canonical files ──bridge──> Goal / Todo ──view model──> TUI
       ▲                         │
       └──── CLI control adapter ┘
```

## 一、现状结论（关键事实）

### 已有资产

| 层 | 现状 | 证据 |
|---|---|---|
| CLI | `maestro run prepare/create/check/complete/brief/skill/seal-session` 全生命周期已实现 | `maestro run --help` 实测 |
| goal 工具 | 单例 goal：auto-continuation 循环、token 预算、compaction 续接、独立 verifier、pause/resume、stale tool 拦截 | `src/tools/goal.ts:286-331`（onAgentEnd 续接）、`goal.ts:341`（verifier） |
| todo 工具 | 任务 DAG（blockedBy + 环检测 + 自动解锁）、skill 绑定与激活注入、`next` 自动注入 prev summaries + goal context + skill prompt、compaction 快照、单 active 约束 | `src/tools/todo.ts:453-515`（handleNext）、`todo.ts:517`（PREV_CONTEXT_WINDOW=5） |
| TUI | statusline 双行聚合、todo widget（Alt+T）、renderCall/renderResult、registerMessageRenderer、`ctx.ui.custom()` 全屏 overlay（SmartSearch 已有完整范例） | `extension/index.ts:549-591`、`tui/smart-search-config.ts:254-266` |
| Skills | ralph/maestro/odyssey 已有 `<goal_tracking>` 协议块；maestro-next 已按三段式调 `maestro run prepare/create/complete` | `.pi/skills/maestro-next/SKILL.md:220-233` |

### 核心断裂点（本规划要解决的）

1. **镜像靠 LLM 自觉**：skills 用散文指示 LLM 手工调 `todo create/update`，参数形态写错（把 description 当标题、subject 当完成判据，与 `todo.ts:33-45` schema 相反），且 goal/todo 混用。长链路中 LLM 漏调一次，镜像即失真。
2. **goal 的 verifier 与 done 判定不读 canonical 状态**：`collectVerifierEvidence`（`goal.ts:484`）只翻会话内 toolResult，而权威真相在 `session.json` / `run.json.gates[]` / `handoff.verdict` 里——放弃了确定性证据。
3. **compaction 续接提示不带 run 锚点**：`buildContinuePrompt`（`goal.ts:889`）只重复 objective，不指示 `maestro run brief` 重挂协议，压缩后 LLM 容易脱离 run 纪律。
4. **statusline 第二行仍渲染旧模型**（Epic/Phase，读 `state.json.milestones`），guide 已废除该模型。
5. **todo 的 skill 绑定能力被浪费**：`todo next` 本身就能完成"激活 step 对应 skill + 注入上游摘要"——这正是 ralph 手工做的 S_STEP_DISPATCH，但没有机制把 `orchestration.chain` 变成带 skill 绑定的 todo 任务。
6. **`session-mode: run` frontmatter 零消费**：skills 已标注该字段，插件代码（`packages/pi-maestro-flow/src`）中无任何读取。
7. **续跑可能出现双 owner**：Goal 当前在 `agent_end` 后直接发 continuation；Run/Session 流程接入后，如果 bridge 或 skill 也推进下一步，就可能重复发送 follow-up、越过 gate，或在用户 pause 后继续运行。
8. **Skill 文档与当前 Todo contract 漂移**：当前工具用 `id` 更新任务，状态不含 `failed`；`maestro`、`maestro-ralph`、`odyssey` 等仍存在 `taskId`、`status: "failed"`、`activeForm` 等旧形态，必须先做 contract audit。

---

## 二、架构总原则：权威 / 镜像 / 驱动 三层

guide §7.1a 已裁定方向：**host_tools（todo/goal）是投影镜像，CLI 从不读取宿主工具状态**。据此确立单向数据流：

```
┌─ 权威层（磁盘，CLI 独占写）──────────────────────────────┐
│ state.json → sessions/{id}/session.json + runs/*/run.json  │
└─────────────┬───────────────────────────────────────┘
              │ 只读（plugin session-bridge 读盘对账）
┌─ 镜像层（pi 插件内存 + session entries）─────────────────┐
│ goal  ← session（intent + definition_of_done + budget）     │
│ todo  ← orchestration.chain steps（含 skill 绑定 + DAG）     │
└─────────────┬───────────────────────────────────────┘
              │ 驱动（注入 prompt / 续接 / 拦截）
┌─ 驱动层（对 LLM 的持续力）──────────────────────────────┐
│ goal continuation 跨 turn 拉动 · todo next 步进注入          │
│ tool_call 守卫 · compaction 后 brief 重挂                   │
└──────────────────────────────────────────────────────┘
```

关键转变与 guide 的"注册从 push 变 pull"同构：**镜像从"LLM 手工声明"变"插件读盘派生"**。LLM 只保留两个宿主级语义动作：

- `todo({action:"next"})` —— 步进（激活下一步 + 注入上下文）
- `goal done` —— 宣告完成（触发前置校验 + verifier）

Run 的 `prepare/create/check/complete/brief/seal-session` 转移统一由 CLI 完成。Pi 插件可以提供 `run-control` tool 或 `/maestro-session` TUI 动作，但它们只是 CLI adapter，不得形成第二套写入逻辑。状态对账全部由插件确定性完成，不给 LLM 留第二条声明路径（同 guide §7.5 原则）。

---

## 三、映射设计

### 3.1 goal ↔ session（会话级持续力）

| goal 字段 | 派生来源 | 说明 |
|---|---|---|
| objective | `session.json.intent` + `boundary_contract.definition_of_done` | bridge 检测到 active session 且无 goal 时自动 set（或提示用户确认） |
| tokenBudget | `orchestration.quality_mode` 经项目配置映射，不在插件内硬编码档位数值 | 预算暂停即现成的成本闸门 |
| done 前置校验 | `orchestration.chain` 全 completed 且 session 级 gates 无 failed | **零成本确定性拒绝**：链未走完直接驳回 `goal done`，不必花 90s 跑 verifier |
| verifier 证据 | 现有会话证据 **+** canonical 摘要（各 run 的 `handoff.verdict/summary`、gates 通过情况、artifacts 清单） | verifier 从"翻聊天记录"升级为"对照权威账本" |

goal 的 auto-continuation（`onAgentEnd` → `sendContinuation`）是现有长时执行心跳，但接入 Workflow Session 后必须降级为 `WorkflowCoordinator` 的投递器，而不能继续拥有独立决策权。Coordinator 只有在以下条件全部成立时才允许发送 continuation：active Run 仍为 `running`、无 failed/blocking gate、Goal 未暂停、无 pending user message、当前 lease 有效（lease 定义见 §4.5）、没有同 Run 的 continuation marker。

`buildContinuePrompt` / `onCompact` 续接内容必须附带 active Run 锚点与一行指令 `maestro run brief <run-id>`。压缩后第一件事是重挂协议与 gate 状态——与 guide 的 Resume Packet 设计（§7.1a 步骤 4）对齐，是"压缩免疫"的关键。

### 3.2 todo ↔ run chain（步骤级步进器）

bridge 读到 `session.json.orchestration.chain` 后**自动物化** todo 任务（LLM 零负担）：

| todo 字段 | 派生来源 |
|---|---|
| subject | `Step {i}: {step.command}`（+ intent 片段） |
| blockedBy | chain 顺序 / DAG 依赖 → 前序任务 id |
| skills | `step.command` → skill 绑定（`{name: step.skill, role: "primary"}`）；guard 类 skill 按 quality_mode 附加 `role: "guard"` |
| context | refs 语法糖：`step:{session}/{seq}`、上游 alias（`f:runs/.../outputs/plan.json#current-plan`）——与已裁定的 refs 设计（只做资源引用，goal 不进 refs）一致 |
| status | 对账派生：`run.json.status` completed/sealed→`completed`，failed/blocked→`blocked`，running→`in_progress` |
| summary | run complete 后取 `run.json.handoff.summary` 回填 |

复利效应：**`todo next` 一次调用 = ralph 的整个 S_STEP_DISPATCH**——激活 step 的 skill prompt、注入 `<prev_steps>`（来自前序 run 的 handoff.summary）、注入 `<goal_context>`，全部是 `todo.ts:453-515` 的既有能力。`buildPrevContext` 的 5 条摘要窗口，恰好实现了 guide 中"下游读 handoff 不解析散文"的人类可读版投影。

**schema 变更**：Todo 的公共 tool contract 保持现有精简形态，不增加 Run/Gate/Artifact 参数。持久化 runtime model 可新增内部字段 `origin?: { sessionId: string; runId?: string; runSeq?: string }`，用于区分 bridge 物化与用户手建任务；该字段不暴露给 LLM。按既有 spec《持久化 todo contract 的版本化迁移模式》执行：state version 3→4，read boundary 归一化，focused tests 覆盖 preserve/replace/clear/legacy migration。

### 3.3 Skill Run 身份与状态机

Todo task 和 Skill Run 不是同一个对象：Todo 表示“要做什么”，Run 表示“某次如何执行”。重试必须创建新 Run，并通过 `parent_run_id` / `replaces` 保留 lineage；不得覆盖失败 Run。

```ts
interface SkillRunProjection {
  runId: string;
  sessionId: string;
  todoId: string;
  parentRunId?: string;
  attempt: number;    // 派生规则：parent_run_id 链长 + 1（canonical run.json 无此字段，投影侧计算）
  status: "created" | "running" | "blocked" | "failed" | "completed" | "sealed" | "cancelled";
                      // cancelled 依赖 P0 对 pause/cancel 契约的裁决（风险 9），未冻结
  skillSnapshot: {
    activationId: string;
    stackRevision: string;
    bindings: Array<{
      name: string;
      role: "primary" | "guard" | "support";
      compiledKey: string;
      contentHash: string;
    }>;
  };
  block?: {
    kind: "gate" | "user" | "dependency" | "permission" | "external";
    message: string;
    resumeHint?: string;
  };
  gateSummary: { passed: number; total: number; failed: number };
  artifactRefs: string[];
  nextAction?: string;
}
```

状态转换：

```text
created ──entry gates pass──> running
created ──entry gates fail──> blocked
running ──work finished─────> completed ──exit gates pass──> sealed
running ──recoverable issue─> blocked ──resume─────────────> running
running ──error─────────────> failed ──retry───────────────> new Run
created/running/blocked ──cancel──> cancelled
```

> **待裁决标注**：`cancelled` 状态与 `block.kind` 依赖 P0 对 pause/cancel canonical contract 的裁决（风险 9）。若裁决为复用 `blocked`/`failed` + 结构化 reason，则本状态机相应收敛，去掉独立 `cancelled` 态；在裁决冻结前不得按本图实现 cancel 路径。

不变量：

- entry gate 或 Skill 加载失败发生在 Todo 进入 `in_progress` 之前；
- exit gate 未通过时，Todo 不得 `completed`，Run 不得 `sealed`；
- sealed Artifact 和 sealed Run 禁止原地修改；
- Skill `contentHash` 变化后旧 activation 标记 stale，必须显式重新激活或创建新 Run；
- 一个根 Pi session 同时最多一个 active root Todo/Run；并行 teammate 作为该 Run 的 child progress，不放宽根 Todo 单活跃约束。

---

## 四、插件方法增强

### 4.1 新模块 `src/session/bridge.ts`（核心，只读）

```
职责：
  loadCanonicalSnapshot(cwd)   读 state.json → active session → session.json + runs/*/run.json
                               （run.json 恒定短小是 guide 的设计承诺，全量读取廉价）
  reconcile(snapshot)          物化/对账 todo 镜像；派生/校验 goal；产出 diff 事件
  getSnapshot()                供 statusline / widget / verifier 消费的缓存快照

触发点（复用现有 hook，不加轮询线程）：
  session_start                初始快照 + 断点恢复判定
  agent_end                    对账（与 statusline 15s 节流合并）
  tool_execution_end           Bash 命令含 "maestro run|ralph" 时立即刷新（防抖）

容错：
  sessions/ 不存在 → 回退读 legacy（.workflow/.maestro/*/status.json），过渡期双轨
```

### 4.2 goal.ts 改动点

1. `handleDone` 入口前插 bridge 前置校验（chain 未完 / gate failed → 直接 REJECTED，附未完 step 清单）。
2. `runVerifier` 的 evidence 组装追加 `buildCanonicalEvidence(snapshot)`（gates 表 + 各 run verdict + artifacts 数）。
3. `buildContinuePrompt` / `onCompact` 续接文案附 `active_run` 锚点与 `maestro run brief` 指令。
4. 新增 pauseReason `"gate"`：bridge 检测到 run 进入 blocked（exit gate failed）时**只产出 diff 事件**，由 Coordinator 裁决并执行 goal pause + notify——把"门禁失败"从 LLM 自觉上报变成确定性流程中断（bridge 只报告不决策，见 §零裁决 3）。

### 4.3 todo.ts 改动点

1. schema v4：`origin` 字段 + 版本化迁移。
2. 新增内部 API `reconcileMirrorTasks(entries)`（仅 bridge 调用，**不暴露给 LLM action**，避免第二条声明路径）。
3. `handleNext` 对 mirror 任务在返回体中附 run 操作指引（"本步骤需 `maestro run create {command} --prep ...`"），把 run 纪律织进步进流。LLM 侧的 Run 转移入口就是 Bash CLI，与 run-control 的分工见 §4.5"双入口分工"。

### 4.4 skill 层协议修订

- 把 ralph/maestro/odyssey 中各自为政的 `<goal_tracking>` 块收敛为统一 `<host_mirror>` 协议段（单源文件，各 skill 引用不复述——同 run-mode.md 的协议单源原则），内容只剩：**步进用 `todo({action:"next"})`；完成宣告用 `goal done`；状态对账由插件自动完成，禁止手工 update 镜像**。
- 修正现存参数错误（subject/description 语义颠倒）。
- `session-mode: run` frontmatter 从零消费变为 bridge 的识别信号：todo 激活带此标记的 skill 时，插件预期 run 生命周期，可开启 run 级守卫。

### 4.5 `WorkflowCoordinator` 与 `run-control` adapter

新增 `src/session/coordinator.ts`，作为唯一流程决策者；bridge 只读取和生成投影，Coordinator 决定是否允许推进，adapter 负责调用 CLI。

```ts
interface WorkflowCoordinator {
  attach(sessionId?: string): Promise<WorkflowSnapshot>;
  advance(): Promise<AdvanceResult>;
  pause(reason: "user" | "budget" | "gate" | "error"): Promise<void>;
  resume(): Promise<AdvanceResult>;
  retry(runId: string): Promise<AdvanceResult>;
  cancel(runId: string): Promise<void>;
  complete(runId: string): Promise<AdvanceResult>;
  brief(runId: string): Promise<RunBrief>;
}
```

`run-control` tool 或 `/maestro-session` 命令暴露以下稳定动作：

| 动作 | 是否写入 | 实现 |
|---|---:|---|
| `status` / `brief` | 否 | bridge snapshot / `maestro run brief` |
| `advance` | 是 | 校验 Goal/Todo/Run 后调用 `maestro run create` 或恢复 active Run |
| `complete` | 是 | 调用 `maestro run complete`，成功后对账 Todo |
| `pause` / `resume` | 是 | 更新 Goal 投影并调用 canonical Session control |
| `retry` | 是 | 保留失败 Run，创建带 lineage 的新 Run |
| `cancel` | 是 | abort 当前执行者并提交 cancelled/failed-with-cancel-reason 记录 |

所有写动作必须复用 permission controller：Plan Mode 下 `status`、`brief`、`prepare` 可用，`advance`、`complete`、`pause`、`resume`、`retry`、`cancel` 按写操作拦截。

**双入口分工（唯一裁决）**：Run 转移有两个发起者，但同一写入者（CLI）——

- **LLM 路径**：skill 纪律下直接 Bash 调 `maestro run create/complete`（现状即如此，maestro-next 为范本）；
- **用户/TUI 路径**：`run-control` / `/maestro-session` 经 Coordinator 调 CLI adapter。

`advance()` 执行前必须检查 `active_run_id`：已有 running Run 时幂等短路为"恢复该 Run"，不重复 create；反向地，LLM 在 TUI 已触发 advance 后再 create，由 CLI 的单 active run 约束拒绝。P3 迁移时 skills 只教 LLM 路径，不提 run-control。

**Lease（续跑租约）定义**：lease 是"谁有权投递 continuation"的互斥凭证，持有者 = 当前 attach 到该 Workflow Session 的 pi 进程。

- 存储：`tmp/hook/{host_session_id}.json`（guide 预留的可删临时区，非 canonical 权威文件，插件可写）——具体位置待 P0 与 pause/cancel 契约一并裁决后冻结；
- 内容：`{ sessionId, hostSessionId, epoch, heartbeatAt }`；attach 时抢占（旧 heartbeat 超时才可接管），shutdown 时释放；
- fencing：continuation marker 携带 `runId + iteration + epoch`，epoch 落后于当前 lease 的迟到 marker 一律拒绝（AC7 的判据来源）。

Hook 接线：

| Hook | 行为 |
|---|---|
| `session_start` | attach active Workflow Session；重建 Goal/Todo；恢复 Run brief；校验 lease |
| `before_agent_start` | 只注入一次 `runId + stackRevision` 对应 Skill stack 与 Run brief |
| `context` | 注入丢失时补入 identity-only recovery packet |
| `tool_execution_end` | 命中 `maestro run` / `maestro ralph` 后防抖刷新 snapshot |
| `agent_end` | 写入 checkpoint 投影；仅由 Coordinator 决定 continuation |
| `session_before_compact` | 保存 sessionId、runId、todoId、stackRevision、gates、artifactRefs、nextAction |
| `session_compact` | 调 `maestro run brief` 重挂协议；Skill hash 漂移则 block |
| `session_shutdown` | 持久化 checkpoint、释放 lease；不清除 canonical Run |

---

## 五、TUI 规划：统一状态所有权 + 三层信息密度

Goal status、Todo widget、旧 Workflow line 和 teammate progress 不再分别读取状态。新增 `WorkflowViewModel` 作为唯一 TUI 输入，由 bridge snapshot 派生；所有控制键调用 Coordinator，不直接修改组件本地状态或协议 JSON。（时序说明：P1 的 statusline 改版直连 bridge snapshot 属过渡实现，P5 统一收敛到 `WorkflowViewModel`。）

### 5.1 L1 — statusline 第二行改版（瞥一眼）

替换旧 Epic/Phase 渲染（`statusline.ts:314-327`），数据源换成 bridge 快照：

```
⚑ 20260715-auth-m1 · ▶ 003/plan · ✓2 ▶1 ○3 · gate 2/3 · 🎯 45k/300k
   session id        当前 run    chain 进度   门禁    goal 预算
```

goal/todo 的 `setStatus` key 保留（现有聚合机制不动），新增 `session` key。

注意 `statusline.ts` 当前的 `activeRuns` 表示 Maestro tool RPC 数量，不是 Workflow Run；改版时必须重命名为 `activeToolCalls`，Workflow Run 单独来自 `WorkflowViewModel`，避免 UI 语义混淆。

### 5.2 L2 — widget 面板升级为 "Maestro Panel"（常驻，Alt+T 三态循环：收起→todo→全景）

在现有 todo widget（`index.ts:702-813`）上扩展三段式，宽度自适应沿用 `truncateToWidth` 模式：

```
┌ Goal ────────────────────────────────────┐
│ ● JWT 认证模块 M1        45k/300k ▓▓▓░░░░ │
├ Session 20260715-auth-m1 ────────────────┤
│ ✓ 001 analyze   ready      #a1f3 plan.json│
│ ✓ 002 grill     ready_wc                  │
│ ▶ 003 plan      GATE-003-02 pending       │
│ ○ 004 execute   blocked by 003            │
├ Todo（非镜像任务）────────────────────────┤
│ [ ] #9k2 更新 README                       │
└──────────────────────────────────────────┘
```

### 5.3 L2.5 — run 事件卡片（时间线内）

bridge 检测到 run 状态跃迁时 `pi.sendMessage({customType:"run-event", display:true})` + `registerMessageRenderer("run-event", …)`，渲染紧凑卡片：run id、verdict 颜色、artifacts 数、next 建议。复用 teammate 的 `dynamicComponent` 渲染模式（`pi-maestro-teammate/src/tui/render.ts`）。

### 5.4 L3 — Session 控制中心 overlay（按需深查）

`/maestro-session` 命令唤起 `ctx.ui.custom()` 全屏 overlay，照抄 SmartSearchConfigOverlay 骨架（列表/详情双态、BracketedPasteDecoder、宽度矩阵）：

- 左列 run 列表（状态/gate/verdict）；右侧 `Markdown` 组件预览 `report.md`、gates 表、handoff decisions
- 动作键：`p` 暂停 goal、`r` 恢复（自动发 brief 指令）、`d` 处理 decision point、`Enter` 看详情

控制键补充：`x` cancel、`R` retry、`b` brief；cancel/retry 必须进入居中确认 overlay。嵌套详情中的 `Esc` 只返回上一层，顶层 `Esc` 才关闭；执行失败必须保留当前选择和滚动位置。

### 5.5 状态与窄宽规则

状态必须同时显示稳定 glyph 和文本，颜色只增强语义：

| 状态 | 展示 |
|---|---|
| running | `▶ running` |
| paused | `⏸ paused` |
| blocked | `! blocked` |
| waiting user | `? waiting user` |
| retrying | `↻ retry 2/3` |
| sealed | `✓ sealed` |
| failed | `× failed` |
| cancelled | `⊘ cancelled` |

宽度降级：

- `<20`：只显示下一动作或阻塞原因；
- `20–47`：状态、Run 序号、Todo 进度；
- `48–79`：增加 Session/Run 名称与关键控制提示；
- `>=80`：增加 gate、耗时、预算、artifact 数；
- 使用 `visibleWidth` 做 `1..120` runtime matrix，禁止通过字符串 `length` 判断可见宽度；
- Footer 按 `Esc`、`Enter`、pause/resume 等恢复操作优先级折叠，不能整行盲截断。

---

## 六、流程控制设计

| 场景 | 机制 | 层 |
|---|---|---|
| 跨 turn 持续 | WorkflowCoordinator 校验 Run/gate/Goal/lease 后复用 goal continuation 投递 | 自动 |
| 压缩恢复 | identity-only checkpoint + continuation 附 `run brief` 锚点（§4.2-3） | 自动 |
| 冷启动恢复 | session_start：bridge 发现 running session 而 goal 缺失 → notify + `/maestro-session resume` 一键重建镜像并发 resume prompt | 半自动 |
| 门禁失败 | bridge 产出 blocked diff 事件 → Coordinator 执行 goal pause(reason:gate) + statusline ⚠ + notify | 自动中断 |
| 决策点 | `orchestration.decision_points` pending → widget 高亮 + statusline ◆；交互裁决仍走 skill 的 AskUserQuestion（**不做双控制路径**），overlay 提供手动兜底 | 混合 |
| 预算闸门 | goal tokenBudget 由配置策略映射；触顶暂停 → `ui.confirm` 追加预算 | 半自动 |
| 用户中断 | goal pause + staleToolCallsBlocked（现有）；扩展：mirror 任务 in_progress 但 run 已 sealed → tool_call 警告 | 守卫 |
| 单活跃约束 | todo 单 active 任务（现有）↔ session `active_run_id` 单 run，语义天然对齐 | 不变量 |
| 可恢复失败 | failed Run 保留；retry 创建新 Run 并记录 parent/attempt；Todo 回 pending 或 blocked | 自动/半自动 |
| 取消 | abort 当前执行者、fence 旧 lease、提交取消记录；不得只清 UI | 半自动 |

---

## 七、实施路线图（已完成）

| 期 | 状态 | 内容 | 依赖 | 交付判定 |
|---|---|---|---|---|
| **P0 契约收敛** | ✅ | 冻结 Session/Run/Artifact/Projection contract；裁决 pause/cancel 契约（风险 9）与 lease 存储位置（§4.5）；审计 `.pi/skills` 的 `taskId`、`failed`、`activeForm`、直接写 JSON；增加 contract linter | 无 | core 与 non-core Skill contract findings 均为 0；写入所有权与 lease contract 已冻结 |
| **P1 Bridge 基础** | ✅ | `src/session/bridge.ts` 只读快照、legacy fallback、缓存与 revision；statusline 第二行接真实 Session/Run | P0 | 新旧目录双轨可读；不修改 canonical files；statusline 不再读 milestone/phase |
| **P2 Projection + Coordinator** | ✅ | Todo schema v4 内部 `origin`、Goal/Todo 自动物化/对账、`WorkflowCoordinator`、单 continuation owner、`run-control` adapter | P1 | Run 与 Todo/Goal 全程收敛；无重复 follow-up；Plan Mode 权限正确 |
| **P3 核心 Skill 迁移** | ✅ | 统一 `<host_mirror>`；迁移 `maestro-next`、`maestro-ralph`、`maestro`、`maestro-session-seal` | P2 | analyze→plan→execute→verify 核心链完成，零手工镜像 update |
| **P4 恢复与失败控制** | ✅ | compaction identity checkpoint、fresh Pi attach、stale skill、retry lineage、lease fencing | P2/P3 | 压缩、重启、失败重试后恢复到同一安全动作；不伪造 CLI 不支持的 cancel 状态 |
| **P5 TUI** | ✅ | `WorkflowViewModel`、Maestro Panel、run-event、`/maestro-session` overlay、非颜色状态与窄宽降级 | P2/P4 | Alt+T 三态、控制中心、宽度 1..120 和 fresh Pi 命令加载通过 |
| **P6 全量迁移与发布验收** | ✅ | 扫描全部 `.pi/skills`；focused/full tests；`npm pack` + isolated consumer + fresh Pi 验证 | P3/P5 | packed consumer 完成真实 Session/Run 闭环；本地依赖由临时 prefix 下的 `npm link` 提供 |

每期配 focused tests：bridge 对账（新建/失败/重试 run 的镜像收敛）、todo v4 迁移（按既有 contract-test spec）、goal done 前置校验矩阵、`fmtStatusLine` 快照。

---

## 八、风险与已裁决项

1. **过渡期双真相**：核心链已停止向 legacy `.workflow/.maestro/*/status.json` 写入；bridge 暂时保留只读 fallback 以兼容存量会话，且不得把 legacy 状态回写 canonical files。待存量迁移窗口结束后可单独移除 fallback。
2. **对账时机**：不引入 file watcher（Windows 语义麻烦），只挂 hook + 防抖；代价是 run 状态显示最多滞后一个 tool 调用，可接受。
3. **并行 session（worktree fork）**：goal 是单例，一个 pi 会话只镜像一个 active session——与 guide 的 worktree 隔离模型一致，无需多 goal。
4. **物化任务的删除语义**：session sealed 后 mirror 任务自动 completed；用户手动 delete mirror 任务时 bridge 不再重建（尊重人的裁决，在 origin 上打 tombstone）。
5. **CLI 与插件版本漂移**：同 version 但 command/schema 不一致时不得按 semver 猜测兼容；必须锁定可复现源码或 tarball，并在 packed consumer 中实际执行代表性 `maestro run` 命令。
6. **Continuation 重复投递**：Goal、Coordinator、compaction callback、Skill 都可能发送 follow-up。实现时必须用 `runId + iteration + epoch`（lease 定义见 §4.5）去重，并在 pause/cancel/session switch 时 fence 旧 marker。
7. **Skill 热更新**：恢复时只能保存 identity/hash，不能把旧 prompt 当真相；hash 变化应 block 并要求重新激活，不能静默续跑。
8. **大量现有工作树改动**：实施必须按模块小步提交，避免把当前 `.pi/skills`、Goal、TUI、teammate 的其他未完成改动混入同一提交。
9. **Pause/Cancel contract**：保持 canonical schema 真实；Goal pause 只暂停宿主投影与 continuation，CLI 不支持的 Run cancel 由 adapter 明确拒绝，不在 Goal/TUI 中伪造 `cancelled`。
10. **Windows 文件锁波动**：全量 `test:plan` 曾出现一次 `.transaction-lock` rename `EPERM`（43/44），同一 heartbeat 用例隔离复跑 1/1 通过；该波动记录为 Windows baseline，不降低功能断言。
11. **本地最新版决策**：packed consumer 对 `D:\maestro2` 和本地 `pi-maestro-teammate` 使用直接 `npm link`。测试把 `npm_config_prefix` 隔离到临时目录，避免争用用户级 `maestro.ps1` / `maestro-mcp`；发布 manifest 与 lockfile 仍保持可发布依赖。

---

## 九、验收矩阵

| ID | 状态 | 验收条件 | 客观证据 |
|---|---|---|---|
| AC1 | ✅ | Skill/config/required-reading/budget/entry gate 失败时 Todo 保持 `pending` | `todo next keeps task pending when skill loading fails`；`entry gate failures keep the canonical Todo mirror pending` |
| AC2 | ✅ | exit gate 失败时 Todo 不完成、Run 不 sealed、Goal 自动暂停 | `exit gate failures keep completed work uncompleted`；`failed exit gate leaves Run and Todo unsealed and pauses the canonical Goal` |
| AC3 | ✅ | 删除 Goal/Todo session entries 后可从 canonical Session/Run 重建相同投影 | `canonical Workflow state rebuilds Goal projection`；Todo v4 projection/reconcile tests |
| AC4 | ✅ | compaction 后首个执行动作重新获取 active Run brief，且不重复注入 Skill prompt | `compaction recovery fetches the Run brief before continuation`，含 retry 与 pending-message 分支 |
| AC5 | ✅ | fresh Pi process 能 attach running Session，恢复 runId/todoId/nextAction | packed consumer child-process attach；本地 fresh Pi 启动加载 user extension |
| AC6 | ✅ | Skill 文件变化后旧 activation 进入 stale，旧 Run 不继续 | `active skill metadata resumes and marks changed skill content stale` |
| AC7 | ✅ | Goal 与 Coordinator 不产生重复 continuation；pause/cancel/session switch 后迟到 marker 被拒绝 | coordinator nonce/epoch tests、generic Goal marker 单次消费、compaction generation fencing |
| AC8 | ✅ | retry 保留失败 Run，并创建 attempt+1 的新 Run；Artifact lineage 可追踪 | `retry validates parent-derived attempt while canonical artifacts retain lineage` |
| AC9 | ✅ | Plan Mode 允许 status/brief/prepare，阻止 advance/complete/retry/cancel | Plan/permission matrix；`test:permissions` 22/22 |
| AC10 | ✅ | TUI 状态同时有 glyph+文本，宽度 1..120 不溢出，关键恢复操作不被截断 | Maestro Panel、run-event、Session overlay 和 statusline width matrix |
| AC11 | ✅ | statusline 不再读取 milestone/phase，tool RPC count 与 Workflow Run count 不混淆 | `statusline renders canonical Session/Run separately from active tool calls` |
| AC12 | ✅ | analyze→plan→execute→verify→seal 在真实 CLI 与 packed consumer 中闭环 | `test:packed` 1/1；tarball 隔离安装 + 本地 link + fresh Pi process |

完成定义已满足：AC1–AC12 全部有客观证据，核心链无 legacy `status.json` 新写入，core/non-core Skill contract linter findings 均为 0，且 fresh Pi 验证通过。

最终验证摘要：Session 25/25、Goal 7/7、Todo 21/21、Compaction 16/16、Hooks 10/10、Permissions 22/22、Package 4/4、Install 6/6、Providers 1/1、Intelligence 51/51、packed consumer 1/1、`check:types` 通过。Plan 聚合运行 43/44，唯一失败为 Windows `EPERM rename` baseline；对应 heartbeat 用例隔离复跑 1/1 通过。

---

## 十、建议实施文件边界

```text
packages/pi-maestro-flow/src/session/
├── types.ts                 # WorkflowSnapshot / projections
├── bridge.ts                # canonical read + legacy migration read
├── coordinator.ts           # sole continuation and transition policy
├── cli-adapter.ts           # invoke maestro run; no duplicate writer
├── view-model.ts            # single TUI projection
└── run-event.ts             # transition events and renderer details

packages/pi-maestro-flow/src/tui/
├── maestro-panel.ts         # collapsed / todo / panorama modes
└── session-overlay.ts       # list / inspector / controls

packages/pi-maestro-flow/test/
├── session-bridge.test.ts
├── workflow-coordinator.test.ts
├── run-recovery.test.ts
├── session-tui.test.ts
└── skill-contract-lint.test.ts
```

首个实现切片建议只做 P0 + P1：建立只读 bridge、契约 linter 和真实 statusline，不在同一切片引入控制写入。第二切片再接 Todo/Goal/Coordinator，可显著降低双真相和续跑回归风险。
