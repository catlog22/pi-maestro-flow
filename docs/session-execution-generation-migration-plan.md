# Session / Execution / Run 状态模型迁移规划

> 状态：已批准，分阶段实施中
> 范围：`maestro2`（Maestro CLI）与 `pi-maestro-flow`（Pi Workflow 集成）
> 核心提议：Session 作为长期主题身份不持久化生命周期状态；Execution/Generation 承担有界执行、lease、chain、gate 与封存；Run 继续作为不可变执行尝试。
> 关联文档：`docs/session-run-knowledge-target-architecture.md`
> 实施约束：兼容能力与 focused gates 未满足前继续写 `session/1.3`；Session status 权威仅在最终跨仓协调阶段移除。

## 1. 背景与问题

当前模型同时把 Session 用作：

1. 长期意图或主题的身份命名空间；
2. 一次有界 Workflow 执行的状态聚合；
3. Run、artifact、knowledge promotion 和 recall 的不可变证明边界。

这三种角色的生命周期不同。只要后续 Run 仍可能按 topic/intent 命中同一 Session，就无法从“当前没有待办”推导出“Session 永远不会再接收工作”。因此 `Session.status=sealed` 只能是人为终止声明，不能是自然执行事实。

当前设计由此产生冲突：

- `run complete` 只封存当前 Run，但 Session lease 继续由原 Pi host 持有；
- `seal-session` 使整个 Session 不可变，后续命中的 Run 只能被拒绝、创建重复 Session，或重新打开一个本应不可变的实体；
- `running` 同时表示“允许派发”和“正在执行”，但 `active_run_id=null` 的开放空闲 Session 是合法状态；
- `paused`、`failed`、blocking gate、failed chain step 和 escalated decision 表达重叠；
- session-source knowledge promotion 和 recall 依赖 Session sealed，把治理快照的新鲜性错误地绑定到主题永久结束。

现有目标架构文档 §2.3 声明“Session 生命周期、状态机和 lease 语义不动”。本提案与该假设冲突；只有本提案通过评审后，才能修订该章节及其 seal-only 知识门禁。

## 2. 决策驱动因素

目标模型必须同时满足：

- 后续 Run 可以继续命中同一 Session，保留主题连续性；
- 每次有界执行都有明确的开始、暂停、恢复、完成和不可变边界；
- 完成的 Run、artifact 和 handoff 不可修改；
- lease 只保护当前执行所有权，不永久占用主题身份；
- recall、reuse 和 knowledge promotion 依赖精确 snapshot/revision/hash，而不是“Session 永久结束”；
- 迁移期兼容既有 `session.json`、CLI 命令、Pi `run-control` 和历史 sealed Session；
- 所有写路径继续具备单写者、epoch fencing、CAS/revision 和事务原子性。

## 3. 目标模型

### 3.1 Session：长期身份容器

Session 不再持久化 `running / paused / failed / sealed / archived` 枚举。

```ts
interface Session {
  schema_version: "session/2.0";
  session_id: string;
  intent: string;
  topic_identity: TopicIdentity;
  identity_revision: number;
  activity_revision: number;
  current_execution_id: string | null;
  latest_execution_id: string | null;
  latest_completed_run_id: string | null;
  archived_at: string | null;
  archived_by: string | null;
}
```

Session 只承担：

- topic/intent 身份与匹配；
- Execution 和 Run 的命名空间；
- identity/activity revision；
- 当前 Execution 指针与历史索引；
- 显式归档元数据。

`archived_at` 是管理/保留策略，不是执行状态。归档默认阻止自动命中，但不改变既有 Execution、Run 或 artifact 的不可变性。

### 3.2 Execution/Generation：有界执行单元

新增 Execution 实体，承接当前 Session 中与一次 Workflow 执行相关的状态：

```ts
interface Execution {
  schema_version: "execution/1.0";
  execution_id: string;
  session_id: string;
  generation: number;
  status: "active" | "paused" | "sealed";
  revision: number;
  active_run_id: string | null;
  chain: OrchestrationStep[];
  decision_points: DecisionPoint[];
  gates_ref: string;
  artifacts_ref: string;
  evidence_ref: string;
  lease: ExecutionLease | null;
  started_at: string;
  sealed_at: string | null;
  seal_summary: string | null;
  final_outcome: "done" | "done_with_concerns" | "failed" | null;
}
```

状态语义：

| 状态 | 语义 | 允许操作 |
|---|---|---|
| `active` | 允许派发；可以有 active Run，也可以处于 Run 间空闲 | `next/create/check/complete/decide/pause` |
| `paused` | 存在 blocker、人工 hold 或待恢复决策 | `resolve/resume/check/read` |
| `sealed` | 本代执行及其 chain/gates 已最终化 | 只读、recall、review、promotion |

Session 可以先后包含多个 sealed Execution，但 MVP 不允许同一 Session 同时存在多个非 sealed Execution。

### 3.3 Run：不可变执行尝试

Run 保持有界尝试语义。建议最终压缩持久化状态为：

```text
created -> running -> blocked
                   -> sealed
                   -> failed
```

当前 `completed` 若仅在同一完成事务中短暂出现，应改为内部过渡而非稳定持久化状态。无论 verdict 为 `done`、`needs-retry` 或 `blocked`，已形成审计结果的尝试都必须最终 sealed；重试创建新 Run，不重新打开旧 Run。

### 3.4 派生视图

Session 不保存统一 status；UI、CLI 和 resolver 从事实派生：

```text
executing = current Execution.active_run_id != null
blocked   = Execution paused，或存在 blocking gate / failed step / escalation / hold
runnable  = Execution active、无 active Run、存在 pending step、无 blocker
idle      = 无 current Execution，或 current Execution sealed 且没有新请求
archived  = session.archived_at != null
```

派生状态只能用于展示和路由，不作为写授权的唯一依据。

## 4. 状态与不变量

### 4.1 Session 不变量

1. `current_execution_id` 为空，或指向同一 Session 下唯一非 sealed Execution。
2. `latest_execution_id` 必须指向同一 Session 下最大 generation。
3. `generation` 在 Session 内严格递增，禁止复用。
4. `archived_at != null` 时自动 topic 命中关闭；显式 `--session` 是否允许新建 Execution 由独立恢复/反归档策略决定。
5. Session identity 字段更新使用 `expected_identity_revision` CAS。
6. Session 活动索引更新使用 `expected_activity_revision` CAS 或同一 StoreTransaction。

### 4.2 Execution 不变量

1. `active` Execution 最多有一个 `active_run_id`。
2. `paused` Execution 不允许创建新 Run；resume 必须携带 actor、reason、evidence、expected revision 和匹配 lease claim。
3. `sealed` Execution 必须满足：所有 Run sealed、所有 chain step terminal、无 claimed request、execution gates clean、`active_run_id=null`。
4. `sealed_at` 与 `status=sealed` 必须在同一事务写入；sealed Execution 不可修改执行状态。
5. chain、decision、gate、artifact registry 与 Execution revision 在一个事务边界内更新。

### 4.3 Run 不变量

1. sealed Run、其 output、handoff 和 Run-owned sidecar 不可修改。
2. Run 必须绑定准确的 `session_id + execution_id + generation`。
3. `needs-retry` 封存当前 Run，将 chain step 重新排队，并由后续 `next` 创建新 Run。
4. recall/reuse 必须绑定 Run hash、artifact hash 和 Execution snapshot receipt。

## 5. Lease 行为模型

### 5.1 Lease 保护什么

lease 不是 Session 的“占用状态”，而是某个 Execution 的单写者能力令牌。它只授权修改 Execution-owned 状态：

- `active_run_id`、chain、decision points 和 execution gates；
- Run 的创建、完成、重试和 handoff；
- Execution-owned artifact/evidence registry；
- Execution pause/resume/seal 转换。

以下操作不应隐式继承 Execution lease：

- Session topic/intent identity 更新；
- Session archive/unarchive；
- knowledge review/promotion；
- 只读 `status/brief/check/recall/evidence`。

Session 级写入使用独立授权和 revision CAS。读操作不要求 lease。

### 5.2 唯一权威与数据结构

当前 Pi Host mutation lease 与 Maestro `session.orchestration.lease` 不应继续作为两个可独立生效的权威。目标态以 Maestro core 持久化的 Execution lease 为唯一权威；Pi 插件只负责 acquire、heartbeat、handoff 和把 claim 注入 `run-control`，不能维护一把 CLI 看不到的平行锁。

```ts
interface ExecutionLease {
  schema_version: "execution-lease/1.0";
  session_id: string;
  execution_id: string;
  owner_id: string;
  owner_kind: "pi" | "claude" | "codex" | "agy" | "manual";
  epoch: number;
  lease_id: string;
  acquired_at: string;
  heartbeat_at: string;
  handoff_to: string | null;
}
```

公开诊断可以显示 owner、epoch 和 heartbeat，但不得暴露 `lease_id`。`lease_id` 是不可猜测 nonce，仅通过受控宿主通道传递。

推荐资源 key：

```text
(session_id, execution_id)
```

全局约束是“每个 Execution 最多一个 owner”，不是“整个 workspace 只有一个 owner”。因此不同 Pi Session 可以同时持有不同 Execution 的 lease。MVP 每个 Session 最多一个非 sealed Execution，所以同一 Session 内仍保持单写者。

### 5.3 Lease 状态

不单独持久化易漂移的状态枚举；从 claim、release marker、heartbeat 和 Execution 状态派生：

| 派生状态 | 条件 | 行为 |
|---|---|---|
| `unowned` | 无有效 claim，或最新 claim 已 released | 允许 acquire |
| `held` | claim 未释放且 heartbeat 新鲜 | 仅匹配 token 的 owner 可写 |
| `handoff` | `handoff_to` 非空，旧 owner 正在排空 | 禁止新 mutation，只允许完成交接/取消 |
| `stale` | heartbeat 超过 TTL | 允许 fenced takeover |
| `closed` | Execution sealed | 永久拒绝 Execution mutation；lease 仅供审计 |

`stale` 只表示允许竞争接管，不表示旧 owner 的异步工作已经停止；安全性必须依赖 epoch fencing 和事务内复验，不能依赖超时本身。

### 5.4 Acquire 与续租

Acquire 必须：

1. canonicalize `session_id + execution_id`，确认 Execution 存在且未 sealed；
2. 读取最新 claim/release 状态；
3. 新鲜 owner 存在时返回 `LEASE_BUSY`；
4. unowned/stale 时以 `epoch = previous + 1` 和随机 `lease_id` 创建 claim；
5. 使用私有目录、唯一 pending 文件、`wx`、原子 link/rename 和 `0600` 权限发布；
6. 发布后重新读取最新权威，只有仍是最高 epoch 且 token 匹配时才向调用方返回成功。

Heartbeat 必须在写前和写后复验 `execution_id + owner_id + epoch + lease_id`。任何 await、文件 I/O、外部 CLI 或子进程返回后，都必须在继续发布状态前重新验证 owner/generation。

TTL 只影响接管资格。正常写入仍需 Execution revision CAS，不能因为 heartbeat 新鲜就覆盖并发更新。

### 5.5 Mutation fencing

每个 Execution mutation 必须携带：

```text
execution_id
execution_owner
owner_epoch
lease_id
request_id
expected_execution_revision
```

验证顺序：

1. 命令入口 canonicalize Session/Execution/Run；
2. 验证 Execution 未 sealed；
3. 验证 lease tuple 完整匹配；
4. 准备 mutation 和输入 snapshot；
5. 进入 StoreTransaction 后再次验证 lease tuple 与 expected revision；
6. 原子写入 execution/run/registry/receipt；
7. commit 成功后才发布 UI、continuation 或 next action。

`epoch` 表示所有权代际，只在 acquire、handoff、takeover 或显式 fence 时递增；普通 mutation 不必每次旋转 epoch。每个 mutation 通过 `request_id + expected_execution_revision` 实现幂等和 CAS。

旧 owner 即使在网络或进程暂停后恢复，也会因为 epoch/token 不匹配而被拒绝。禁止 empty claim、仅 owner 名匹配或继承缺失 epoch/token。

### 5.6 Run 完成后的 lease 行为

`run complete` 不默认释放 lease，因为同一 Execution 后续仍可能需要：

- reconcile 当前 chain step；
- `run next` 分配下一 Run；
- 处理 decision node；
- 生成 retry Run；
- 最终 seal Execution。

按 verdict 处理：

| Verdict | Execution 状态 | Lease |
|---|---|---|
| `done` / `done-with-concerns`，仍有后续 step | `active` | 原 owner 保持并续租 |
| `done`，所有终结条件满足 | `active`，等待显式/自动 seal | seal commit 前保持 |
| `needs-retry` | `active` | 原 owner保持，下一 Run 沿用同一 ownership generation |
| `blocked` | `paused` | pause commit 后停止 heartbeat并 release |

如果产品需要在 Run 边界更换执行者，必须使用显式 handoff，不能把 `run complete` 的成功隐式解释为 release。

### 5.7 Pause、Seal 与释放顺序

Pause：

```text
fence current lease
-> 原子写 Execution=paused、清理/确认 active_run_id、记录 blocker/evidence
-> commit
-> 停止 heartbeat
-> 写 release marker
```

paused Execution 不持有长期执行 lease。`resolve` 使用 actor/reason/evidence + revision CAS；`resume` 在 blocker 清除后获取新 epoch lease，再把 Execution 改为 active。这样人工等待期间不会无意义阻塞其他合法接管。

Seal：

```text
fence current lease
-> 验证所有 Run sealed、chain terminal、无 claimed request、gates clean
-> 原子写 Execution=sealed + sealed_at + snapshot receipt
-> 清除 Session.current_execution_id（同一事务/CAS）
-> commit
-> 停止 heartbeat
-> 写 release marker
```

如果 release marker 写失败，sealed Execution 本身仍是最终写屏障；后续 mutation 必须先因 `Execution=sealed` 被拒绝。不得为了释放 lease 而回滚已经成功的 seal。

### 5.8 显式 Handoff

Handoff 用于把同一 Execution 从 Pi Session A 转交给 Pi Session B：

1. A 进入 `handoff`，停止接受新 mutation；
2. 等待已接受 prompt 对应的 agent turn、子进程和 StoreTransaction 完成，达到 stable idle；
3. A 写入 `handoff_to=B` 和 handoff intent，并保持当前 lease；
4. B 使用 handoff intent 申请 `epoch+1` 的新 claim；
5. core 原子发布 B 的 claim，旧 epoch 立即失效；
6. B 重新加载 canonical Execution/Run/continuation，验证 session、execution、run、revision 和 lease token；
7. B 回执 accepted 后，A 写 release/transfer receipt 并停止 heartbeat。

Handoff 超时或 B 拒绝时，A 可以在原 epoch 尚未被替换时取消 handoff并恢复；一旦更高 epoch 已发布，A 永远不能恢复写权。所有跨宿主控制消息必须携带 epoch/nonce，接收端拒绝 stale token。

### 5.9 Stale Takeover 与崩溃恢复

接管条件：

- heartbeat 超过 TTL；
- Execution 未 sealed；
- 调用方具备恢复授权；
- 调用方提供 actor、reason 和可审计 evidence；
- 最新 execution revision 与准备阶段一致。

接管流程：

```text
读取 stale claim
-> 尝试取消旧 operation（若存在 durable operation id）
-> 等待 cancel acknowledgement，或记录无法确认的 recovery reason
-> 发布 epoch+1/new lease_id claim
-> 重读权威确认 ownership
-> reload Execution + active Run + transition receipts
-> 对未决 request 做 replay-or-reject
-> 恢复 heartbeat
```

旧 owner 的迟到回调必须在每个 await 后复验 epoch/token；失败后只能丢弃结果，不得写 Session、Execution、Run、UI projection 或 continuation。

仅删除 lease 文件不是恢复协议。禁止手工移除 claim 来绕过 epoch fencing；管理命令必须通过 audited `lease recover` 产生更高 epoch 和 recovery receipt。

### 5.10 Pi Session shutdown

正常 shutdown：

1. 阻止新的 run-control mutation；
2. fence continuation 和 callback generation；
3. 取消并等待 in-flight mutation/child operation；
4. flush transition receipt；
5. 停止 heartbeat；
6. 仅在确认没有可能迟到写入时发布 release。

如果进程崩溃或无法确认 operation 已停止，不伪造 clean release；停止 heartbeat，让后继 owner 走 stale takeover，并依赖新 epoch 拒绝旧回调。

### 5.11 原始 CLI 与 Session 级操作

所有原始 `maestro run/execution` mutation 必须使用同一 core Execution lease 校验，不能因为调用来源是 bash、Pi `run-control` 或其他宿主而走不同授权路径。

Session identity/archive 操作不要求 Execution lease，但必须：

- 使用显式 actor/reason；
- 携带 expected identity/activity revision；
- archive 前确认没有 active/paused Execution，或先完成显式 pause/abandon；
- 不能修改 sealed Execution 或 Run。

建议结构化错误码：

```text
LEASE_BUSY
LEASE_FENCE_CONFLICT
LEASE_HANDOFF_IN_PROGRESS
LEASE_STALE_RECOVERY_REQUIRED
EXECUTION_PAUSED
EXECUTION_SEALED
EXECUTION_REVISION_CONFLICT
```

错误信息可返回 owner id、epoch、heartbeat 和 reclaimable time，但不得返回 lease token。

### 5.12 可观测性

`session status` / `execution status` 至少显示：

```text
session_id / execution_id / generation
execution state
owner id/kind（脱敏）
epoch
heartbeat age
lease state: held|handoff|stale|released|closed
active run / in-flight request
允许的下一操作
```

UI 的 read-only attach 必须明确区分：

- 当前窗口没有 Execution mutation lease；
- lease 由哪个 host 持有；
- 是否 stale/reclaimable；
- 当前仍可执行哪些只读或 Session 级 CAS 操作。

### 5.13 Lease 验证矩阵

最小自动化覆盖：

1. 两个 owner 同时 acquire，只有一个成功；
2. 不同 Execution 可由不同 Pi Session 并行持有；
3. stale takeover 发布新 epoch 后，旧 owner heartbeat/mutation/late callback 均失败；
4. mutation 在准备后、commit 前发生 takeover，事务内复验拒绝旧写；
5. handoff 等待 stable idle，不能越过 in-flight Run completion；
6. handoff accepted 后旧 owner 无法取消并恢复；
7. pause commit 成功但 release 文件失败，Execution 仍不可派发直至合法 resume/acquire；
8. seal commit 成功但 release 失败，Execution 仍永久拒绝 mutation；
9. crash 无 release 时 TTL 后可 audited takeover；
10. 原始 CLI 不能绕过 Pi/core lease；
11. request replay 在同 token/revision 下幂等，在新 epoch 下按 receipt 返回或拒绝；
12. 私有目录、`wx`、symlink/non-file 拒绝和失败注入符合安全约束。

## 6. 存储布局

目标布局：

```text
.workflow/sessions/<sid>/
├── session.json
├── session-events.jsonl              # 可选：身份、归档、Execution 索引事件
├── knowledge-delta.json              # session-origin candidate 版本
├── executions/<generation>-<eid>/
│   ├── execution.json
│   ├── gates.json
│   ├── artifacts.json
│   ├── evidence.json
│   ├── reconciliation.json
│   └── runs/<rid>/
│       ├── run.json
│       ├── report.md
│       ├── outputs/
│       ├── knowledge-delta.json
│       └── knowledge-reconciliation.json
└── snapshots/<revision>-<hash>.json  # Session/Execution 精确快照回执
```

MVP 可以保留当前目录布局，通过 `execution_id` 和 `generation` 字段双写，待读写路径全部切换后再物理迁移目录。

## 7. Knowledge、Recall 与 Reuse 调整

### 7.1 Run-source candidate

继续要求：

- 源 Run sealed；
- Run candidate 内容 hash 固定；
- 每个源有新鲜 corpus reconciliation receipt；
- promotion 仍为独立治理动作，不因 Execution seal 自动执行。

### 7.2 Session-source candidate

取消“整个 Session 必须 sealed”的门禁，替换为：

- candidate 在 stage 时生成不可变 candidate version/hash；
- 绑定准确 `session_id + activity_revision + evidence roots`；
- review/promotion 时重验 candidate hash 和 corpus fingerprint；
- revision 变化不自动使旧 candidate 失效，只有其绑定输入或 evidence 变化才失效；
- promotion 继续遵循人工裁决和 TOCTOU fence，不自动晋升。

### 7.3 Recall/reuse

从：

```text
sealed Session + sealed Run
```

迁移为：

```text
sealed Run
+ sealed Execution snapshot
+ Run/artifact content hash
+ fresh recall confirmation receipt
```

Session 后续产生新 Execution 不应使旧 Execution 的 recall 证据失效。

## 8. CLI 与行为合同

### 8.1 目标命令语义

```text
maestro session create        创建长期 Session 身份
maestro execution start       在 Session 下创建下一 generation
maestro run next              在当前 Execution 中分配 Run
maestro run complete          封存 Run，并推进当前 Execution
maestro execution pause       暂停当前 Execution
maestro execution resume      审计式恢复当前 Execution
maestro execution seal        封存当前 Execution并释放 lease
maestro session archive       禁止自动命中 Session
maestro session unarchive     审计式恢复自动命中资格
```

兼容期保留：

```text
maestro run seal-session <sid>
```

但将其映射为“seal current Execution”，输出 deprecation notice，不再使 Session 身份不可变。

### 8.2 Run verdict

| Verdict | Run | Chain step | Execution |
|---|---|---|---|
| `done` | sealed | sealed | active 或可 seal |
| `done-with-concerns` | sealed | sealed | active 或可 seal |
| `needs-retry` | sealed | pending，清除 run_id | active |
| `blocked` | sealed | failed | paused |

### 8.3 CLI 合同原则

现有稳定基线必须保留：

- Commander 是命令注册层；domain/runtime 函数不直接打印；
- machine mode 每次只向 stdout 输出一个经过 schema 验证的 envelope；
- machine mode stderr 必须为空；
- process exit code 必须等于 envelope `exit_code`；
- mutation 使用 `request_id`、normalized request hash、precondition fence 和 transition receipt 支持幂等重放；
- 相同 `request_id` + 不同 normalized payload 必须返回 `REQUEST_CONFLICT`；
- human mode 可以输出说明文字，但不得改变 machine contract；
- deprecation warning 在 machine mode 进入 envelope，不得写 stderr。

目标实现新增 `src/commands/execution.ts`。`session.ts` 只管理长期身份，`execution.ts` 管理有界执行和 lease，`run.ts` 管理单次 Run。禁止三个命令族复制 verdict、option builder、machine envelope 和 error mapping。

### 8.4 公共参数组

所有命令通过共享 helper 注册以下参数组，Commander 定义和 runtime option 类型只能有一个来源。

#### LocatorOptions

```text
--session <id>             精确 Session ID；mutation 必填
--execution <id>           精确 Execution ID；Execution/Run mutation 必填
--workflow-root <path>     包含 .workflow 的项目根
```

human read 命令可以在不歧义时省略 locator；machine mutation 不允许依赖“唯一 active Session/Execution”扫描。

#### MachineOptions

```text
--json                     输出一个 run-response/1.1 envelope
```

当 argv 中出现 `--json` 时，Commander 缺失必填参数、未知参数和解析失败也必须进入 envelope，错误码为 `COMMANDER_USAGE`、exit code 为 `2`。

#### SessionMutationOptions

```text
--request-id <id>                  幂等 mutation ID
--actor <name>                     授权主体
--reason <text>                    审计理由
--evidence <ref>                   证据，可重复
--expected-identity-revision <n>   Session identity CAS
--expected-activity-revision <n>   Session activity/index CAS
```

Session create 的 `request-id` 可以省略并由 core 生成；archive/unarchive 必填。Session mutation 不接收 Execution lease tuple。

#### ExecutionMutationOptions

```text
--request-id <id>                   幂等 mutation ID
--expected-execution-revision <n>   Execution CAS
--execution-owner <owner>           当前 owner ID
--owner-epoch <n>                   ownership generation
--lease-id <id>                     不可猜测 token
```

除 acquire 类命令外全部必填。需要同时更新 Session 指针的 mutation，额外要求 `expected-activity-revision`。

#### AuditedExecutionOptions

```text
--actor <name>
--reason <text>
--evidence <ref>                    可重复且至少一项
```

pause、resolve、resume、seal failed、handoff、recover 和强制管理操作必须携带。

#### LeaseAcquireOptions

```text
--execution-owner <owner>           新 owner
--owner-kind <kind>                 pi|claude|codex|agy|manual
--expected-lease-epoch <n>          已观察的最新 epoch；首次为 0
--claim-output <path>               human mode 私有 claim 输出位置
```

core 生成 `lease_id`，acquire 调用方不得自行指定。machine mode 的成功结果可以把完整 claim 返回给直接调用宿主；普通 status/show 永远只返回 redacted lease。human mode 默认把 token 写入 `0600` 私有 claim 文件，只显示文件路径和脱敏 owner/epoch。

### 8.5 `run-response/1.1`

`run-response/1.0` 是 strict schema，不能直接增加 locator 字段。目标态新增 `run-response/1.1`，reader 在兼容期接受 1.0 和 1.1，writer 在 capability 协商成功后写 1.1。

```ts
interface RunResponseV11 {
  schema_version: "run-response/1.1";
  operation: OperationV11;
  ok: boolean;
  exit_code: 0 | 1 | 2 | 3;
  disposition: "success" | "domain_error" | "control_flow" | "usage_error";
  request_id: string | null;
  locator: {
    session_id: string | null;
    execution_id: string | null;
    generation: number | null;
    run_id: string | null;
  } | null;
  fence: {
    session_identity_revision: number | null;
    session_activity_revision: number | null;
    execution_revision: number | null;
    lease_epoch: number | null;
  } | null;
  result: unknown | null;
  next: NextAction | null;
  continuation: ContinuationDirectiveV11 | null;
  replay: {
    status: "applied" | "replayed";
    transition_id: string;
  } | null;
  warnings: Array<{
    code: string;
    message: string;
    replacement_command: string | null;
  }>;
  error: {
    code: ErrorCodeV11;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
    recovery_command: string | null;
  } | null;
}
```

成功 acquisition 命令的 `result.lease_claim` 是唯一允许返回原始 `lease_id` 的响应位置。response logger、Cockpit 和 knowledge/transcript capture 必须在持久化或展示前删除该字段。

Operation V1.1 至少增加：

```text
capabilities
session-create
session-archive
session-unarchive
execution-start
execution-attach
execution-status
execution-pause
execution-resolve
execution-resume
execution-seal
execution-handoff-prepare
execution-handoff-accept
execution-handoff-cancel
execution-lease-status
execution-lease-heartbeat
execution-lease-release
execution-lease-recover
```

现有 `create/next/complete/brief/check/decide/accept-reuse/...` operation 在兼容期保留。

### 8.6 Capability negotiation

新增只读命令：

```bash
maestro capabilities --json
```

最小结果：

```json
{
  "schema_version": "maestro-capabilities/1.0",
  "cli_version": "<semver>",
  "session_schema_writes": ["session/1.3", "session/2.0"],
  "execution_schema_writes": ["execution/1.0"],
  "run_response_writes": ["run-response/1.0", "run-response/1.1"],
  "features": {
    "execution_generation": true,
    "core_execution_lease": true,
    "execution_handoff": true,
    "session_statusless": true,
    "legacy_session_aliases": true
  }
}
```

Pi 插件 attach 前必须读取 capability。新插件连接不支持 `core_execution_lease` 的旧 CLI 时，Execution mutation fail closed；只读命令仍可用。禁止静默退回仅插件外层 Host lease。

### 8.7 Session 命令合同

#### `maestro session create <topic>`

目标语义：只创建长期 Session 身份，不隐式创建 Execution 或 Run。

```text
--id <slug>
--intent <text>                       默认 topic
--request-id <id>                    可选；省略时生成并返回
--actor <name>                       默认当前 host/manual
--json
--workflow-root <path>
```

成功结果必须包含：

```text
session_id
session_dir
identity_revision
activity_revision
current_execution_id=null
next="maestro execution start --session <sid> ..."
```

事务：校验 topic identity -> 防 ID 冲突 -> 创建 `session/2.0` -> 更新 project index -> 写 transition receipt。相同 request 重放返回同一 Session。

兼容期若使用 `--chain` 或 `--chain-file`，在一个事务中创建 Session 后再创建 generation 1 Execution，并返回 `SESSION_CREATE_CHAIN_DEPRECATED` warning；新代码不得继续把 chain 存回 Session。

#### `maestro session list|show|status [session-id]`

只读，不要求 lease。`status` 返回派生视图以及 current/latest Execution locator，不返回原始 lease token。

#### `maestro session archive <session-id>`

```text
SessionMutationOptions（全部必填）
--json
```

前置条件：不存在 active/paused Execution、Session 未 archived。事务只写 `archived_at/by`、revisions 和 index。存在非 sealed Execution 返回 `SESSION_ARCHIVE_BLOCKED`。

#### `maestro session unarchive <session-id>`

同样要求完整 SessionMutationOptions。只清理归档元数据，不创建 Execution、不恢复旧 lease。

### 8.8 Execution 命令合同

#### `maestro execution start`

```text
--session <id>                       必填
--chain <commands...>                与 --chain-file 二选一
--chain-file <path|->
--platform <name>
--engine <name>
--quality <mode>
--auto
--request-id <id>                   必填
--expected-identity-revision <n>    必填
--expected-activity-revision <n>    必填
LeaseAcquireOptions                 必填 owner/kind/expected epoch
--json
--workflow-root <path>
```

前置条件：Session 未 archived，且没有非 sealed current Execution。事务必须原子执行：分配 `generation=max+1` -> 创建 Execution -> claim epoch/new token -> 更新 Session pointers/revision -> 写 receipt。不得出现 Execution 已创建但 lease 未发布，或 lease 已发布但 Session pointer 未更新的半状态。

成功结果：

```text
session_id / execution_id / generation
execution_revision / status=active
redacted lease metadata
lease_claim（仅授权 machine response/claim file）
chain summary
next="maestro run next --session ... --execution ..."
```

#### `maestro execution attach`

为 active 且 unowned 的 Execution 获取 lease，不改变 Execution lifecycle。

```text
--session <id>
--execution <id>
--request-id <id>
--expected-execution-revision <n>
LeaseAcquireOptions
--json
```

fresh owner 存在返回 `LEASE_BUSY`；stale owner 存在返回 `LEASE_STALE_RECOVERY_REQUIRED`，不能由普通 attach 自动抢占。

#### `maestro execution status|show|list`

只读。status 返回 lifecycle、chain/gates、active Run、revision 和 redacted lease。`list --session` 按 generation 排序。

#### `maestro execution pause`

```text
--session <id>
--execution <id>
ExecutionMutationOptions
AuditedExecutionOptions
--json
```

事务把 Execution 改为 paused、记录 hold/blocker、处理 active Run 的合法终态并提交；commit 后 release lease。若 active Run 尚未形成可封存/取消状态，返回 `EXECUTION_PAUSE_BLOCKED`，不能丢弃 Run。

#### `maestro execution resolve`

paused 期间无长期 lease，使用 audited CAS：

```text
--session <id>
--execution <id>
--request-id <id>
--expected-execution-revision <n>
AuditedExecutionOptions
--decision <id> | --step <id> | --hold <id>
--disposition <value>
--json
```

一次只解析一个恢复目标，成功后仍保持 paused。重复 request 幂等。

#### `maestro execution resume`

```text
--session <id>
--execution <id>
--request-id <id>
--expected-execution-revision <n>
--expected-activity-revision <n>
AuditedExecutionOptions
LeaseAcquireOptions
--json
```

前置条件：所有 blocker 已清除，Execution=paused，无有效 owner。事务原子获取新 epoch lease并改为 active；不得先 active 后 acquire。

#### `maestro execution seal`

```text
--session <id>
--execution <id>
ExecutionMutationOptions
--outcome <done|done-with-concerns|failed>
--summary <text>
--note <text>                        可重复
AuditedExecutionOptions             failed/concerns 时必填
--json
```

seal 事务验证所有 Run sealed、chain terminal、无 claimed request、gates clean，生成 immutable snapshot/receipt，清除 Session current pointer。commit 后停止 heartbeat并 release。结果包含 snapshot hash、final revisions、knowledge review next action。

#### `maestro execution handoff prepare`

```text
--session <id>
--execution <id>
ExecutionMutationOptions
AuditedExecutionOptions
--to-owner <id>
--to-kind <kind>
--expires-in <duration>
--json
```

等待 stable idle 后生成单次 handoff intent/token hash，Execution 进入派生 handoff 状态。成功结果不暴露当前 lease token。

#### `maestro execution handoff accept`

```text
--session <id>
--execution <id>
--handoff-id <id>
--handoff-token <token>
--request-id <id>
--expected-execution-revision <n>
LeaseAcquireOptions（目标 owner）
--json
```

原子发布 `epoch+1` claim并消费 handoff token。结果返回新 owner 的 `lease_claim` 和 canonical reload locator。

#### `maestro execution handoff cancel`

只有旧 epoch 仍是 current 且 handoff 未 consumed 时允许；需要旧 lease tuple、request ID、expected revision 和 reason。更高 epoch 已发布时返回 `LEASE_FENCE_CONFLICT`。

#### `maestro execution lease status`

只读，返回 redacted lease 和 reclaimable time。

#### `maestro execution lease heartbeat`

宿主集成命令，要求完整 lease tuple；只更新 heartbeat，不改变 Execution revision。machine only，不进入普通用户工作流提示。

#### `maestro execution lease release`

要求完整 lease tuple、request ID 和 expected execution revision。只有无 in-flight transition/handoff 时执行 clean release；否则返回 `LEASE_RELEASE_BLOCKED`。

#### `maestro execution lease recover`

```text
--session <id>
--execution <id>
--request-id <id>
--expected-execution-revision <n>
--expected-lease-epoch <n>
LeaseAcquireOptions（新 owner）
AuditedExecutionOptions
--cancel-operation <id>              已知旧 operation 时
--json
```

只允许 stale lease。生成 recovery receipt、发布新 epoch、重新验证 transition records并返回 reload locator。禁止 `--force` 删除 claim。

### 8.9 Run 命令合同

#### `maestro run next`

```text
--session <id>                       machine mutation 必填
--execution <id>                     machine mutation 必填
--pick <step-id>
--arg <value>                        可重复
--inline-brief
ExecutionMutationOptions
--json
--workflow-root <path>
```

事务内验证 lease/revision、无 active Run、目标 step pending、decision gate 已处理，然后创建绑定 `session_id + execution_id + generation` 的 Run。成功结果必须包含新 execution revision、Run locator、birth packet 和 continuation。

human mode 可在唯一 current Execution 时省略 `--execution`；`--json` 模式不得模糊解析。

#### `maestro run create <command> [args...]`

保留为 admin/compatibility 命令，但必须显式提供 Session 和 Execution，并通过相同 lease/CAS。它不能隐式创建 Session、隐式 start Execution 或把 paused Execution 改回 active。

#### `maestro run complete [run-id]`

保留现有业务参数：

```text
--verdict <done|done-with-concerns|needs-retry|blocked>
--summary <text>
--reason <text>
--note <text>                        可重复
--decision <text>                    可重复
--evidence <path>                    可重复
--artifact <path>                    可重复
--chain-proposal <path>
--apply-proposal
--skip-artifact-metadata-validation
```

并要求 LocatorOptions + ExecutionMutationOptions。machine mode 必须显式提供 run ID；human mode只有在唯一 active Run 时可以省略。

事务顺序：重放检查 -> lease/revision fence -> completion input snapshot -> gates/artifacts/handoff/knowledge reconciliation -> sealed Run -> chain verdict -> Execution revision -> receipt。`done` 不隐式 release lease；`blocked` 成功提交 paused 状态后 release。

#### `maestro run brief|check`

只读，不要求 lease，但返回 locator、Execution revision 和 redacted lease freshness。`check` 不封存，也不能通过读路径刷新 heartbeat。

#### `maestro run decide <point-id>`

属于 Execution mutation，要求 Session/Execution locator、完整 lease tuple、request ID 和 expected Execution revision。决策结果不能写 Session lifecycle。

### 8.10 Transition request/receipt 1.1

新增 `transition-request/1.1` 与 `transition-outcome/1.1`：

```ts
interface TransitionFenceV11 {
  session_identity_revision: number;
  session_activity_revision: number;
  execution_id: string | null;
  execution_generation: number | null;
  execution_revision: number | null;
  execution_status: "active" | "paused" | "sealed" | null;
  lease_epoch: number | null;
  active_run_id: string | null;
  run_hash: string | null;
  artifact_registry_revision: number | null;
}
```

`subject` 增加 `execution_id` 和 `generation`。持久化 request payload 只能保存 `lease_id_hash`，不得保存原始 token。apply 时使用调用上下文中的原始 token校验 current claim，再把 hash 写入 receipt。

重放规则：

1. 相同 request ID、相同 normalized hash、receipt 有效且结果仍可验证：返回 `replayed`；
2. 相同 request ID、不同 normalized hash：`REQUEST_CONFLICT`；
3. receipt hash/schema/cross-binding 损坏：`INVALID_TRANSITION_RECEIPT`；
4. receipt 声称 applied 但 postcondition 已被非法改写：`REPLAY_STATE_DIVERGED`；
5. request 已 applied 后 lease epoch 提升，不重复 mutation，仍返回原结果；
6. request 尚未 applied 且 lease epoch 已提升：`LEASE_FENCE_CONFLICT`；
7. rejected receipt 是否可重试由 error code 明确，不得仅按 exit code猜测。

### 8.11 Error code 与退出码

保持 exit code 兼容：

| Exit | 语义 | 例子 |
|---:|---|---|
| `0` | 成功或幂等 replay | applied/replayed/read success |
| `1` | domain/fence/gate 失败 | lease busy、gate blocking、revision conflict |
| `2` | usage 或无可派发 control flow | `COMMANDER_USAGE`、`CHAIN_COMPLETE`、`DECISION_REQUIRED` |
| `3` | 已有 active work 导致本次不执行 | `RUNNING_STEP` |

调用方必须同时检查 `disposition + error.code`，不能只按 exit code 解释。

V1.1 新增/细分错误码：

```text
SESSION_ARCHIVED
SESSION_ARCHIVE_BLOCKED
EXECUTION_NOT_FOUND
EXECUTION_ALREADY_ACTIVE
EXECUTION_PAUSED
EXECUTION_PAUSE_BLOCKED
EXECUTION_SEAL_BLOCKED
EXECUTION_SEALED
EXECUTION_REVISION_CONFLICT
LEASE_BUSY
LEASE_FENCE_CONFLICT
LEASE_HANDOFF_IN_PROGRESS
LEASE_HANDOFF_TOKEN_INVALID
LEASE_STALE_RECOVERY_REQUIRED
LEASE_RELEASE_BLOCKED
CAPABILITY_REQUIRED
```

旧 `LEASE_CONFLICT`、`SESSION_NOT_RUNNING`、`SESSION_SEAL_BLOCKED` 在 1.0 compatibility response 中继续映射；1.1 writer 使用细分码。

### 8.12 兼容别名矩阵

| 现有命令 | 目标映射 | 兼容行为 |
|---|---|---|
| `maestro session create --chain...` | `session create` + `execution start` | 同事务兼容，human warning |
| `maestro session start` | resolve/create Session + `execution start` + `run next` | 保留 convenience transaction |
| `maestro session next` | `run next --execution <current>` | human warning；machine result带 replacement |
| `maestro session done` | `run complete` | 保留一个大版本周期 |
| `maestro session resolve` | `execution resolve` | current Execution 必须唯一 |
| `maestro session resume` | `execution resume` | 新 lease 由 core 获取 |
| `maestro session seal` | `execution seal` | 不再封存 Session identity |
| `maestro run seal-session` | `execution seal` | deprecated admin alias |
| `maestro run recover` | `execution resolve/resume` | 继续拆分两阶段 |
| `maestro run start` | Session resolve/create + Execution start +可选 next | 不允许命中 archived Session |
| `maestro run create` | admin Run create in explicit Execution | 禁止隐式 Session/Execution 创建 |

machine mode 不把 warning 写 stderr；在 `warnings[]` 返回：

```json
{
  "code": "DEPRECATED_ALIAS",
  "message": "maestro session done maps to maestro run complete",
  "replacement_command": "maestro run complete ..."
}
```

### 8.13 版本组合策略

| Pi 插件 | Maestro CLI | 行为 |
|---|---|---|
| 旧 | 旧 | 当前 Session lease/status 模型 |
| 旧 | 新 | CLI 开启 compatibility projection、接受 1.0 请求并写 legacy locator；不得生成旧插件无法理解的 active Execution 并发 |
| 新 | 旧 | capability 检测失败；Workflow mutation read-only/fail closed，不得退回外层平行 lease |
| 新 | 新 | Execution generation、core lease、run-response/1.1 全功能 |

升级顺序：先发布兼容的新 CLI，再发布新插件；等受支持插件全部具备 capability negotiation 后，才能默认写 `session/2.0`。CLI 必须支持通过 feature flag/项目 schema 保持 1.3 writer，直到迁移显式执行。

### 8.14 发布门与测试目标

CLI 变更至少更新：

- `src/run/protocol-schemas.ts`：1.1 response、transition、locator、error code；
- `src/run/response.ts`：typed code mapping 与 machine stderr invariant；
- `scripts/check-session-run-contract-parity.mjs`：schema、operation 和 docs token；
- `scripts/check-session-run-release-machine.mjs`：fresh-process envelope、exit parity、applied/replayed、usage、fence、redaction；
- `guide/session-run-architecture.md`、结构指南、CLI 中英文指南；
- Pi `RunCliAdapter` contract tests 和 capability negotiation tests。

聚焦测试文件建议：

```text
src/run/execution-lifecycle.test.ts
src/run/execution-lease.test.ts
src/run/execution-handoff.test.ts
src/run/transition-receipts.test.ts
src/run/complete-verdict.test.ts
src/commands/execution.test.ts
src/run/protocol-schemas.test.ts
```

fresh-process 验收必须证明：

1. 每个 `--json` 调用只有一行 stdout、stderr 为空、exit parity 一致；
2. Commander usage error 也输出合法 envelope；
3. acquisition token 只出现在授权 result，status/log/continuation 均已脱敏；
4. applied/replayed 使用同一 transition ID；
5. stale epoch、不同 request hash 和非法 alias 组合稳定返回对应 error code；
6. 旧插件可消费 compatibility response，新插件遇旧 CLI fail closed。

## 9. 迁移阶段

### Phase 0：锁定不变量与回归基线

- 为当前 Session/Run/chain/lease 状态转换建立行为测试矩阵；
- 增加当前已知非法组合测试：sealed Session + pending step、paused Session 被 createRun 隐式恢复、Host lease 被原始 CLI 绕过；
- 记录历史 schema fixture 和当前 CLI JSON envelope。

完成条件：迁移前行为和已知缺陷均有可重复测试，且不运行无关仓库级套件。

### Phase 1：增量引入 Execution identity

- 新增 `execution_id`、`generation` 和 `current_execution_id`；
- 旧 Session 读取时投影一个 legacy generation；
- 新 Run 双写 `execution_id + generation`；
- 不改变现有目录和命令行为。

完成条件：旧 fixture 可读，新建 Session/Run 拥有稳定 Execution identity。

### Phase 2：迁移 chain、gate、artifact 与 active Run 权威

- 把 `active_run_id`、chain、decision points、gates、artifacts、evidence 的写权威迁移到 Execution；
- Session 暂时保留兼容投影，只读消费者逐步切换；
- `run next/complete/decide/check` 使用 Execution revision fencing。

完成条件：所有 Run mutation 都以 Execution 为边界；兼容投影与权威状态一致。

### Phase 3：迁移 lease、CLI contract 与 Pi attach

- 新增 `maestro capabilities --json`，Pi attach 先协商 `core_execution_lease` 与 response/schema 能力；
- 新增 `run-response/1.1`、`transition-request/outcome/1.1` 和 Execution locator/fence；
- 新增 `src/commands/execution.ts` 及 start/attach/pause/resolve/resume/seal/handoff/lease 子命令；
- Pi `WorkflowLeaseStore` key 从 Session 改为 Execution，并退化为 core lease 的宿主 adapter；
- run-control attach 区分 Session identity attach 与 Execution mutation ownership；
- Execution seal、Session/Execution 切换和 Pi shutdown 正确释放/fence lease；
- 原始 CLI mutation 接入核心 lease/CAS；
- machine mode 保持单 envelope、stderr 为空、exit parity、token redaction 和 applied/replayed 合同；
- 新插件遇到缺少 core capability 的旧 CLI 时 mutation fail closed。

完成条件：不同 generation 不争用同一长期 Session lease；同一 Execution 保持单写者；CLI 与 run-control 共享唯一 core lease 权威；新旧组合符合 §8.13 版本矩阵。

### Phase 4：迁移 seal、knowledge、recall 与 reuse

- `seal-session` 兼容映射到 `execution seal`；
- session-source candidate 改用 candidate version + revision/hash receipt；
- recall/reuse 改绑 sealed Execution snapshot；
- synthetic knowledge Session 不再需要人为永久 seal。

完成条件：Session 后续新增 Execution 不影响旧 Run/Execution 的 promotion 和 recall 资格。

### Phase 5：删除 Session status 权威

- 所有消费者改用派生视图或 Execution 状态；
- schema 升级到 `session/2.0`；
- 删除 `running/paused/failed/sealed/archived` 写路径；
- `archived_at` 接替 Session 管理终止语义；
- 修订 `docs/session-run-knowledge-target-architecture.md`、CLI help、Pi 注入提示和 docs-site。

完成条件：Session 没有生命周期 enum；历史 Session 可迁移读取；新 Run 可在旧 Execution sealed 后继续命中同一 Session。

### Phase 6：可选物理布局迁移与并发扩展

- 将 execution-owned 文件移动到 `executions/<generation>-<eid>/`；
- 评估同一 Session 多 Execution 并行；
- 引入 Session 事件日志或 snapshot compaction；
- 删除过渡期双写和 legacy 投影。

此阶段不是 MVP 前置条件。

## 10. 代码影响面

### `D:/maestro2`

- `src/run/schemas.ts`：Session/Execution/Run schema；
- `src/run/store.ts`：事务、不可变边界、目录与兼容投影；
- `src/run/runtime.ts`：create/complete/seal、knowledge receipt、active pointers；
- `src/run/next.ts`：Session 解析、派发准入、chain reconciliation；
- `src/run/session-transition.ts`：pause/resolve/resume 迁移到 Execution；
- `src/run/lease.ts`：lease claim 改绑 Execution，并成为 core 唯一权威；
- `src/run/transition-receipts.ts`：Execution fence、token hash 和重放规则；
- `src/run/protocol-schemas.ts`：Execution schema、run-response/1.1、transition 1.1、错误码；
- `src/run/response.ts`：V1.0/V1.1 writer、typed error、machine stderr/exit parity；
- `src/run/knowledge.ts`：session-source promotion 门禁；
- `src/run/recall*.ts`：sealed Session 条件改为 Execution snapshot；
- `src/commands/execution.ts`：新增 Execution 与 lease 命令面；
- `src/commands/run.ts`、`src/commands/session.ts`：共享 option/envelope helper、兼容别名和弃用提示；
- CLI program entry：新增 `maestro capabilities --json`；
- `scripts/check-session-run-contract-parity.mjs`：operation/schema/docs parity；
- `scripts/check-session-run-release-machine.mjs`：fresh-process response、重放、fence、redaction和版本兼容。

### `D:/pi-maestro-flow`

- `packages/pi-maestro-flow/src/session/types.ts`：Workflow snapshot 增加 Execution；
- `packages/pi-maestro-flow/src/session/bridge.ts`：canonical projection；
- `packages/pi-maestro-flow/src/session/coordinator.ts`：Execution lease、attach 和 fence；
- `packages/pi-maestro-flow/src/session/cli-adapter.ts`：新 CLI 合同；
- `packages/pi-maestro-flow/src/extension/index.ts`：attach/release、seal 通知和知识积压；
- Cockpit/UI projection：Session 派生状态与 Execution 明细。

## 11. 兼容与回滚

- 采用 additive schema + dual-read/dual-write，禁止原地破坏旧 Session；
- 历史 sealed Session 默认导入为：Session 可继续命中，但 legacy Execution sealed；
- 历史 archived Session 映射为 `archived_at` 非空；
- 历史 paused/failed Session 映射为 paused legacy Execution，并保留 blocker/decision evidence；
- 每个 Phase 使用 feature flag 或 schema capability gate，可在不回写旧格式的情况下回滚读取路径；
- 物理目录迁移延后，避免逻辑迁移与文件搬迁同时发生；
- sealed Run 和 artifact hash 永不重写。

## 12. 验收标准

1. 同一 Session 的 Execution 1 sealed 后，可以创建 Execution 2 和新 Run，且 Execution 1 保持不可变。
2. Session 不持久化生命周期 enum；UI 能准确派生 executing/runnable/blocked/idle/archived。
3. 一个 Session 在 MVP 中最多一个非 sealed Execution。
4. 不同 generation 的 lease 不冲突；同一 Execution 的不同 owner 被 epoch/token fence 拒绝。
5. `run complete --verdict needs-retry` 封存旧 Run，并创建新的执行尝试而非 reopen。
6. Execution seal 拒绝 pending/running/failed chain step、未封存 Run、claimed request 和 blocking gate。
7. 原始 CLI 与 run-control 对 mutation 使用同一核心 lease/CAS 权威，不能旁路。
8. Session 后续 activity_revision 变化不使旧 sealed Execution 的 recall/reuse 无条件失效。
9. session-source candidate 不依赖 Session 永久 seal，但必须通过 candidate hash、evidence、revision 和 corpus receipt 校验。
10. 历史 running/paused/sealed/archived/failed Session fixture 均可确定性迁移。
11. 所有迁移验证采用受影响的最小测试目标；已通过且未被相关改动失效的证据必须复用。
12. 文档、CLI help、JSON schema、Pi birth/brief/check 提示在最终切换时保持一致。
13. `maestro capabilities --json` 能稳定区分新旧 CLI，插件不依赖 help 文本猜测能力。
14. 所有新 mutation 支持 request applied/replayed，重复 request 使用同一 transition ID。
15. 所有 `--json` 路径只输出一行合法 envelope、stderr 为空，Commander usage 也满足 exit parity。
16. lease token 只在授权 acquisition result/私有 claim file 中出现，不进入 status、日志、continuation、Cockpit 或 transcript。
17. §8.12 兼容别名均返回 replacement，§8.13 四种 CLI/插件组合无静默授权降级。
18. `run-response/1.0` reader 在兼容期继续工作，1.1 locator/fence 不通过向 1.0 strict envelope 注入额外字段实现。
19. transition receipt 持久化 token hash 而非原始 `lease_id`，损坏或跨 Execution 重放 fail closed。
20. fresh-process release-machine 覆盖 acquisition、handoff、stale takeover、seal/release 失败注入和旧插件兼容响应。

## 13. 风险与待决策项

### 主要风险

- Session 与 Execution 双写期出现 authority 漂移；
- 旧插件与新 CLI 对 sealed 含义理解不同；
- artifact alias 当前可能隐含 Session 全局唯一，需要明确 generation 合并规则；
- session-source candidate 从 seal 门禁迁移到 snapshot receipt 后，TOCTOU 校验必须完整；
- topic 命中过宽可能使不相关的新 Run 进入旧 Session；
- 历史 sealed Session 重新可命中可能改变用户预期。

### 需要架构评审确认

1. Session 是否允许同一时间多个 active Execution。建议 MVP：不允许。
2. 历史 sealed Session 是否默认允许自动命中。建议：只允许显式命中，首次使用后再启用新策略。
3. `execution seal` 是否自动创建 Session snapshot。建议：创建，作为 recall/knowledge receipt 的统一证据。
4. artifact alias 是 Session 全局、Execution 局部，还是显式 publish 到 Session。建议：Execution 局部，发布使用 CAS transaction。
5. archived Session 是否允许显式 unarchive。建议：允许，但要求 actor/reason/evidence/revision。
6. Execution 命令是否作为公开一级命令，或先以内嵌 generation 实现。建议：数据模型先独立，CLI 可分阶段公开。

## 14. 推荐决策

建议批准以下方向进入 Phase 0/1：

- Session 是长期 topic/intent identity，不设生命周期状态，不 seal；
- Execution/Generation 是有界 Workflow 与 lease 的权威边界；
- Run 与 artifact 保持不可变封存；
- knowledge、recall 和 reuse 改用精确 revision/hash/snapshot receipt；
- MVP 保持每个 Session 单 active Execution，暂不开放同 Session 并行执行；
- 先增量引入 Execution identity 和测试，再迁移 authority，最后删除 Session status。

在 Phase 0 的不变量和兼容矩阵完成前，不应直接删除 `Session.status` 或改变现有 `seal-session` 行为。
