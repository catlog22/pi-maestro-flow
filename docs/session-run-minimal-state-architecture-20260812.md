# Session + Run 最小状态目标架构（方案 B）

> 状态：目标架构决策（2026-08-12，含并发语义修订）
> 决策：删除 Execution 持久化实体、长期独占 lease、handoff 和 distributed operation drain；采用 Session + Run、participant ID、request ID、细粒度 revision/CAS 和 core 短事务锁。
> 取代范围：本文 supersede `docs/session-execution-generation-migration-plan.md` 整篇执行路线（Execution/Generation、ExecutionLease、heartbeat、handoff），该文档降级为历史审计参考；supersede `docs/session-run-knowledge-target-architecture.md` 中“执行平面”的 Session/Execution/lease 设计，以及其“身份平面”写授权分级中的 fenced lease 直接授权条目（由 participant identity + revision CAS 替代）；知识治理、证据、artifact、gates 和 knowledge deposition 机制继续有效，但须改为引用 Session/Run ID。
> 上游问题：`docs/infra-audit-multi-perspective-20260812.md`、`docs/infra-audit-remediation-plan-20260812.md`。

## 1. 决策摘要

Session 是多个 Pi 窗口、agent 和 CLI participant 共享的版本化工作状态，不是一把只能由单一窗口长期持有的锁。

每次写操作使用：

```text
participantId + actorId + requestId
+ target ID + expected target revision
+ domain preconditions
+ core atomic transaction
```

因此删除：

- Execution 实体和 generation。
- Execution 长期 lease、owner、heartbeat、epoch 和 handoff。
- operation registry、root/child claim、drain root 和 operation token。
- Pi WorkflowLeaseStore 和 mutation lease owner 提示。
- 为跨窗口 ownership 转移设计的 operation drain hooks。

保留：

- Session ID 和 Run ID。
- participant/actor identity。
- request-id 幂等。
- 细粒度 entity revision 和 CAS。
- core 内部持续数毫秒的短事务锁。
- append-only transition receipt/audit log。
- 每个 Pi 窗口自己的本地任务取消与 shutdown 管理；它不属于 Session authority。

## 2. 目标关系

```text
Workspace
└── Session S1
    ├── participants
    │   ├── Pi window A
    │   ├── Pi window B
    │   ├── agent reviewer-1
    │   └── manual CLI
    ├── chain
    ├── decisions
    ├── gates
    ├── artifacts / evidence
    └── Runs
        ├── Run R1 (step=implement, attempt=1)
        ├── Run R2 (step=review, attempt=1)
        └── Run R3 (step=implement, attempt=2, retryOf=R1)
```

不存在 `Session -> Execution -> Run` 中间层。执行轮次和重试关系由 Run 的 `attempt/retryOfRunId/parentRunId` 表达。

## 3. Session 最小状态

```ts
type SessionStatus = "open" | "paused" | "completed" | "archived" | "failed";

interface SessionV3 {
  schemaVersion: "session/3.0";
  sessionId: string;

  objective: string;
  definitionOfDone: string;
  status: SessionStatus;

  identityRevision: number;
  orchestrationRevision: number;
  activityRevision: number;

  chain: ChainStepRef[];
  decisions: DecisionRef[];
  gatesRef: string;
  artifactsRef: string;
  evidenceRef: string;

  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}
```

### Revision 分工

| Revision | 修改范围 |
|---|---|
| `identityRevision` | objective、definitionOfDone、归档身份与稳定元数据 |
| `orchestrationRevision` | chain、decision、session status、全局 gates |
| `activityRevision` | 单调递增的全局事件序号，只用于观察、增量同步和 resume fingerprint |

Run、artifact registry、evidence registry 各自拥有独立 revision。不能让所有 mutation 竞争一个 session revision。

`activityRevision` 是盲递增计数器：不参与任何 CAS 比较，不构成写冲突来源，递增与锁序规则见 §6。

## 4. Run 最小状态

```ts
type RunStatus =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "sealed";

interface RunV3 {
  schemaVersion: "run/3.0";
  runId: string;
  sessionId: string;
  stepId: string;

  parentRunId: string | null;
  retryOfRunId: string | null;
  attempt: number;

  command: string;
  args: string[];
  goal: string | null;
  status: RunStatus;
  revision: number;

  actorId: string;
  participantId: string;

  gateRefs: string[];
  inputRefs: string[];
  outputRefs: string[];
  primaryArtifactId: string | null;

  verdict: "done" | "done_with_concerns" | "needs_retry" | "blocked" | null;
  summary: string | null;

  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  sealedAt: string | null;
}
```

Run 是独立并发和 CAS 边界。两个 participant 修改不同 Run 时不产生冲突。

## 5. Participant 与 Actor

```ts
interface ParticipantIdentity {
  participantId: string; // Pi window / CLI client / managed agent instance
  kind: "pi-window" | "cli" | "agent" | "monitor" | "manual";
  sessionId: string;
  registeredAt: string;
  lastSeenAt?: string;
}
```

- `participantId`：请求来自哪个客户端/窗口，负责路由和审计。
- `actorId`：代表谁做决定或执行动作，可为 user ID、agent ID 或 system service。
- 两者都不表示独占所有权。
- participant 可注册/注销，但失联不阻塞其他 participant。
- 同一 OS 用户和工作区内的 participant 默认属于同一信任域；未来跨机器再增加签名/capability。

## 6. Mutation 合同

```ts
interface MutationContext {
  sessionId: string;
  participantId: string;
  actorId: string;
  requestId: string;

  targetType: "session-identity" | "orchestration" | "run" | "artifact" | "evidence";
  targetId: string;
  expectedRevision: number;

  reason?: string;
  evidence?: string[];
}
```

core 执行顺序：

```text
1. 规范化并验证 ID
2. 取得目标数据的短事务锁
3. 检查 requestId receipt（幂等/冲突）
4. 读取 target 当前 revision
5. 比较 expectedRevision
6. 验证业务状态转换与引用完整性
7. collect -> validate -> commit
8. target revision + 1；Session.activityRevision + 1
9. 写 immutable transition receipt
10. 原子提交并释放锁
```

### activityRevision 递增与锁序

第 8 步中的 `Session.activityRevision + 1` 遵循以下规范性规则：

- **盲递增（blind increment）**：`activityRevision` 永远不参与 `expectedRevision` 的 CAS 比较，不产生 revision 冲突，也不得作为 `MutationContext.targetType` 的目标。它只是事件序号。
- **锁粒度与获取顺序固定**：所有 mutation 先取 target entity 锁（如 Run），后取 Session 记录锁（仅为递增 `activityRevision` 与写 receipt）。全部 mutation 遵循同一顺序，禁止反序，避免死锁。
- **同一原子提交内释放**：两把锁在同一原子提交内释放；实现可选择将 `activityRevision` 递增与 receipt 写入合并为单个 append 操作。
- **推论**：不同 Run 的并发 mutation 只在 Session 计数器递增这一步短暂串行化（毫秒级），各自的 CAS 校验互不干扰——这保持 §8 “不同 Run 并行”的成立。

### Request ID 规则

- 同一 `requestId + 相同 canonical payload`：返回原 transition receipt，不重复写。
- 同一 `requestId + 不同 payload`：`REQUEST_CONFLICT`。
- requestId 不得跨 participant 自动复用。receipt 必须记录 `participantId`；同一 requestId 来自不同 participant 时返回 `REQUEST_CONFLICT`，使该规则可执行。
- payload 比较使用 canonical payload hash。receipt 只存 hash 与对应 transition receipt 的引用，不存完整 payload，保证存储有界。
- 保留策略：request receipt 随 Session 生命周期保留；活跃 Session 内不得清除（幂等窗口 = Session 生命期）。Session 进入 `archived` 后，receipt 可随 Session 整体归档或清除。

### Revision 冲突

```json
{
  "code": "RUN_REVISION_CONFLICT",
  "target_type": "run",
  "target_id": "run-123",
  "expected_revision": 3,
  "current_revision": 4,
  "changed_by": "pi-window-a",
  "next_actions": ["reload-run", "re-evaluate-intent", "resubmit-with-new-request-id"]
}
```

冲突后不能只替换成新 revision 盲目重放旧意图；必须重新读取并重新评估。

## 7. 状态机

### Session

```text
open <-> paused
open | paused -> completed
open | paused -> failed
completed | failed -> archived
```

规则：

- `completed` 要求所有 blocking gate 通过、所有 required chain step 完成/跳过并有依据、没有 running Run。
- `paused` 不阻止 participant 读取或添加 evidence，只阻止创建新 Run 和推进 chain step。
- `paused` 期间，已处于 `running`/`blocked` 的 Run 允许继续走完自身状态机（complete/fail/block/cancel/seal）；`session complete` 的前置校验“没有 running Run”不因 paused 而放宽。
- `archived` 完全只读。

### Run

```text
pending -> running | cancelled
running -> completed | failed | blocked | cancelled
blocked -> running | failed | cancelled
failed -> sealed
completed -> sealed
cancelled -> sealed
```

规则：

- `pending -> cancelled`：创建后尚未启动的 Run 可以直接取消，无需先进入 running。
- `blocked -> failed`：仅当阻塞原因被判定为不可恢复时允许，且 mutation 必须附带判定依据（`reason`/`evidence`）；可恢复的阻塞必须经 `blocked -> running` 恢复后再决定终态，不得用 fail 绕过恢复路径。

重试通过新建 Run 表达：

```text
R2.retryOfRunId = R1.runId
R2.attempt = R1.attempt + 1
```

不得把一个 failed/sealed Run 重新改回 running。

## 8. 并发示例

### 不同 Run 并行

```text
A: complete R1, expected R1.rev=3
B: add evidence to R2, expected R2.rev=7
```

两个 mutation 修改不同 target，均可成功。

### 同一 Run 冲突

```text
A、B 都读取 R1.rev=3
A complete R1 -> rev=4
B block R1 with expected=3 -> RUN_REVISION_CONFLICT
```

B 重新读取 R1 后决定是否还需要 block；core 不自动改为 expected=4 重试。

### Chain 与 Run 联动

“完成 Run 并推进 chain”是不可拆的业务动作时，必须提供 core 复合事务：

```text
maestro run complete <run-id> --advance
```

一个 transaction 同时：

- 校验 Run revision。
- 完成 Run。
- 校验 orchestration revision。
- 推进对应 chain step。
- 更新 session activity revision。
- 写单一 receipt。

不能依赖客户端连续执行两条命令来保持一致性。

## 9. 删除的状态与命令

### 删除的持久化状态

```text
Execution
executionId / generation / executionRevision
currentExecutionId / latestExecutionId
Execution.status / finalOutcome
Execution.lease
ownerId / ownerKind / leaseId / leaseEpoch
heartbeatAt / handoffTo
operation registry
operation admission / drain_root
operation claim / parent_operation_id / operation token
```

`finalOutcome` 移到 Session completion receipt；execution generation 历史由 Run attempt/lineage 和 Session transition log替代。

### 删除的命令

```text
execution start / attach / pause / resolve / resume / seal
execution lease status / heartbeat / release / recover
execution handoff prepare / accept / cancel
execution operation claim / release / status
```

### 替代命令

```text
session open / pause / resume / complete / archive
session status / resume-view
session chain insert / skip / replace / audit
run next / create / brief / check / complete / cancel / seal
participant register / status / unregister       # 可选管理面
```

所有 mutation 支持：

```text
--participant <id>
--actor <id>
--request-id <id>
--expected-<target>-revision <n>
--json
```

Pi coordinator 自动注入 participant/actor/request/revision；模型通常不手写这些字段。

## 10. 本地异步任务

Session 架构不再追踪 teammate/bash_bg/compaction 的 distributed operation claim。

每个 Pi 窗口只维护本地：

```ts
interface LocalTaskRegistry {
  start(kind: "teammate" | "bash_bg" | "compaction" | "publication"): TaskHandle;
  cancelAll(): Promise<void>;
  waitForIdle(timeoutMs: number): Promise<boolean>;
}
```

用途仅是当前进程 shutdown/reload 的资源清理：

- 它不授予 Session 写权限。
- 它不阻塞其他 participant。
- 它不写入 Maestro operation registry。
- 本地任务提交 Session mutation 时仍走普通 requestId + revision CAS。

## 11. Artifact、Evidence、Gate 与 Knowledge

这些实体保留，但改用 Session/Run ID：

```text
Artifact.sessionId / Artifact.runId
Evidence.sessionId / Evidence.runId?
Gate.sessionId / Gate.runId?
Knowledge source_ref = session:<id> | run:<id>
```

- registry 各自有 revision 与分页读取。
- 大正文保存为 artifact/blob，由 resource cursor 读取。
- Run sealed 后不可修改其事实正文，但可以向 Session 添加新的审计 evidence，引用该 Run。
- Session complete/seal receipt 是知识治理 reconciliation 的权威边界，不依赖 Execution seal。

## 12. Resume Map

删除 Execution 后，恢复地图简化为：

```ts
interface ResumeMapV1 {
  sessionId: string;
  sessionStatus: SessionStatus;
  identityRevision: number;
  orchestrationRevision: number;
  activityRevision: number;

  activeRuns: Array<{ runId: string; stepId: string; status: RunStatus; revision: number }>;
  blockingGates: string[];
  openDecisions: string[];
  pendingPublications: Array<{ publicationId: string; resourceUri?: string }>;

  nextActions: Array<{ action: string; targetId: string; expectedRevision: number }>;
  fingerprint: string;
}
```

不再包含 executionId、generation、lease owner、epoch 或 operation 状态。

## 13. 迁移策略

### Schema 版本

```text
session/2.x + execution/1.0 + run/2.x
    -> session/3.0 + run/3.0
```

采用版本化 read-boundary normalization，不原地破坏旧数据。

### 迁移过程

1. 冻结旧 Session/Execution/Run 快照并计算 hash。
2. 将 Session identity、chain、decisions、gates、registry refs 投影到 `session/3.0`。
3. 将每个旧 Run 加上 sessionId、stepId、attempt、revision、participant/actor fallback。
4. 将 execution generation 映射为审计 metadata：`legacyExecutionGeneration`，不作为新身份。
5. 将 finalOutcome/seal summary 映射为 Session transition receipt。
6. 丢弃 lease、heartbeat、handoff、operation registry；迁移报告只记录其 hash 和丢弃原因，不复制 token。
7. 验证所有 Run/Artifact/Evidence/Gate 引用。
8. 原子发布 v3 pointer；旧目录保留只读。

### 双读单写

- 新 CLI 读取 v2/v3；所有新写只写 v3。
- 旧 CLI 对 v3 mutation 返回 `SESSION_SCHEMA_UNSUPPORTED`，不得回写旧格式。
- 禁止 dual-write，避免 v2 Execution 与 v3 Session 分叉。

### 在线会话

- 有 running Run 的旧 Session 不自动迁移。
- 先暂停创建新 Run，等待正在执行的 core mutation 结束；本地后台工作不阻止迁移，但后续提交将收到 schema/revision conflict 并重新读取。
- 不执行 lease handoff；迁移 commit 后旧 lease/operation token 永久无效，旧客户端 mutation 因 schema/capability 不匹配而 fail closed。

## 14. CLI 迁移映射

| 旧命令 | 新命令 |
|---|---|
| `execution start/attach` | `participant register`（可选）+ 直接使用 Session |
| `execution pause/resume` | `session pause/resume` |
| `execution seal` | `session complete` |
| `execution handoff *` | 删除；其他 participant 直接读取并提交 CAS mutation |
| `execution lease *` | 删除 |
| `execution operation *` | 删除 |
| `run next --execution` | `run next --session` |
| `run brief --execution` | `run brief --session --view map|full` |
| `session chain ...` | 保留，改为 orchestrationRevision CAS |

旧命令在过渡期只返回结构化 replacement；不得静默模拟 lease。

## 15. Capability 与兼容

新增 capability：

```json
{
  "session_run_minimal_v3": true,
  "entity_revision_cas": true,
  "participant_identity": true,
  "request_receipts_v2": true,
  "execution_lease": false,
  "operation_registry": false
}
```

Pi 必须按 capability 选择 adapter：

- v3：使用 Session/Run CAS。
- v2：仅用于迁移或只读兼容；不启动新的复杂 lease/operation 集成。
- capability 不完整：mutation fail closed，读取仍可用。

## 16. 安全与正确性边界

删除 lease 不等于删除并发控制。必须保留：

1. core 短事务锁。
2. target entity revision CAS。
3. request-id 幂等 receipt。
4. domain 状态机和引用完整性校验。
5. participant/actor 审计。
6. immutable sealed Run 和 append-only transition records。
7. 非人类消息不能拥有 objective-control/authorization。

不能只用 Session ID 直接写文件，也不能在 revision conflict 后自动替换 revision 重放旧 payload。

## 17. 验收测试

### 并发

- 不同 Run 的 mutation 并发成功。
- 同一 Run 的两个 mutation 只有一个成功，另一个收到 current revision。
- chain 与 run-complete 复合事务故障注入无半提交。
- request response loss 后同 requestId replay 返回相同 receipt。
- 同 requestId 不同 payload 返回冲突。
- 不同 Run 并发 mutation 时 activityRevision 递增不产生任何 CAS 冲突。
- 同 requestId 来自不同 participant 时返回 `REQUEST_CONFLICT`。

### 多窗口

- 3 个 Pi 窗口同时读取同一 Session，无 attach/lease/handoff。
- A 关闭不影响 B/C mutation。
- 旧 A 的延迟请求若 revision 过期被拒绝。
- participant 注销不改变 Session 状态。

### 迁移

- v2 fixture 到 v3 的 Run/chain/gate/artifact/evidence 引用无损。
- 不持久化任何 lease/operation private token。
- 旧目录 hash 可审计且只读。
- 新 CLI 双读单写；旧 CLI 对 v3 fail closed。

### 状态机

- pending Run 可直接取消。
- blocked Run 仅在附带不可恢复判定依据时可直接 failed。
- paused 期间 running Run 可 complete，但不能创建新 Run、不能推进 chain step。

### 恢复与知识

- resume-map 不含 Execution/lease 字段且 <=2KB。
- Session complete receipt 可驱动 knowledge reconciliation。
- Run sealed 后事实不可变，Session evidence 可追加引用。

## 18. 完成定义

只有以下全部满足，才能声明方案 B 落地：

- v3 schema、atomic mutation、receipt 和 migration 工具完成。
- Pi 不再创建、持有或显示 Execution lease/operation claim。
- 多窗口无需 handoff 即可对不同 Run 并发 mutation。
- 同 target 冲突由 revision CAS 可见且可恢复。
- 所有旧 Execution 命令有明确 replacement 或删除说明。
- packed consumer、迁移 fixture、并发故障注入和跨窗口集成测试通过。
- 文档、skills、CLI help、run-control tool description 不再要求 attach/lease/handoff。
