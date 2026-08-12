# Session/Run v3 core 合同清单（Pi 侧 → core 仓库，2026-08-12）

> 用途：`docs/session-run-v3-action-plan-20260812.md` 阶段 1 的跨仓协调依据。本文是 Pi 插件侧（消费方）向 Maestro core 仓库（`D:\maestro2`）提出的输入与验收清单；条目全部派生自权威架构文档 `docs/session-run-minimal-state-architecture-20260812.md`（方案 B，含 2026-08-12 并发语义修订），括注对应小节。
> 本清单的全部条目通过即满足行动规划「阶段 2 完整交付」的启动门槛。

## 0. 现状基线（2026-08-12 实测）

本机安装的 core（cli_version 0.5.69）`maestro capabilities --json` 广播：

```json
{
  "schema_version": "maestro-capabilities/1.0",
  "cli_version": "0.5.69",
  "session_schema_writes": ["session/1.3", "session/2.0"],
  "execution_schema_writes": ["execution/1.0"],
  "run_response_writes": ["run-response/1.0", "run-response/1.1"],
  "features": {
    "execution_generation": true,
    "core_execution_lease": true,
    "execution_handoff": true,
    "execution_operation_drain": true,
    "session_statusless": true,
    "legacy_session_aliases": true
  }
}
```

与目标态的差距：无任何 v3 capability；仍广播并实现 `execution_operation_drain`（分布式 operation registry/drain，方案 B §1 明确删除，Pi 侧对应实验代码已于 2026-08-12 拆除）；`execution handoff prepare` 仍强制要求 `--drain-operation`（Pi 真实 CLI 集成测试因此暂时移除了该段）。

## 1. Capability 广播（方案 B §15）

v3 core 必须在 `maestro capabilities --json` 中同时满足：

| 键 | 要求 |
|---|---|
| `features.session_run_minimal_v3` | `true` |
| `features.entity_revision_cas` | `true` |
| `features.participant_identity` | `true` |
| `features.request_receipts_v2` | `true` |
| `features.execution_lease` | **显式 `false`**（键缺失视为不满足） |
| `features.operation_registry` | **显式 `false`**（键缺失视为不满足） |
| `session_schema_writes` | 含 `session/3.0` |
| `execution_schema_writes` | 不含任何 `execution/*`（v3 无 Execution 写入） |

Pi 侧协商已实现并冻结（`cli-adapter.ts` 的 `RunCliV3Support`/`selectProtocol`）：六项整组成立才选择 v3 协议；缺任何一项且 v2 三要素也不完整时 mutation fail-closed。**广播格式保持 `maestro-capabilities/1.0` schema 形状**（顶层字段不增删；新增 feature 键走 features 的布尔 catchall），否则 Pi 解析 fail-closed。

## 2. 命令面（方案 B §9）

全部替代命令必须存在且支持 `--participant <id> --actor <id> --request-id <id> --expected-<target>-revision <n> --json`：

```text
session open / pause / resume / complete / archive
session status / resume-view
session chain insert / skip / replace / audit
run next / create / brief / check / complete / cancel / seal
participant register / status / unregister      # 可选管理面
```

- 复合事务命令：`run complete <run-id> --advance` 在单一 core transaction 内完成 Run + 校验 orchestration revision + 推进 chain step + 写单一 receipt（方案 B §8）；`session complete` 同样是单一原子事务（整改计划 E2）。
- 旧 `execution */lease */handoff */operation *` 命令：删除或在过渡期返回结构化 replacement（`warnings[].replacement_command` 或 error `next_actions`），**不得静默模拟 lease/ownership**（方案 B §14）。
- 上下文推导 fail-closed（整改计划 E3）：优先级固定为 显式 ID > 当前绑定 > 唯一 open Session > 唯一可运行候选；多候选返回 `SESSION_AMBIGUOUS` 与候选列表；删除「按 mtime 取最新」。

## 3. Mutation 合同（方案 B §6，含并发语义修订）

core 每次写操作按以下顺序执行，整体原子：

1. 规范化并验证 ID → 2. 取目标数据短事务锁 → 3. 检查 requestId receipt → 4. 读当前 revision → 5. 比较 expectedRevision → 6. 业务状态机与引用完整性校验 → 7. collect→validate→commit → 8. target revision +1 且 Session.activityRevision 盲递增 → 9. 写 immutable transition receipt → 10. 原子提交并释放锁。

- **activityRevision 盲递增**：不参与 CAS、不可作为 targetType、绝不产生冲突。
- **锁序固定**：先 target entity 锁，后 Session 记录锁（仅为递增计数器与写 receipt），全部 mutation 同序，禁止反序。
- **request receipt**：记录 participantId；同 requestId + 同 canonical payload hash → 返回原 receipt（replay）；同 requestId + 不同 payload 或不同 participant → `REQUEST_CONFLICT`；receipt 只存 payload hash 与 receipt 引用；随 Session 生命周期保留，archived 后方可归档清除。
- **Run 状态机**：含 `pending -> cancelled` 与 `blocked -> failed`（后者必须附 `reason`/`evidence` 判定依据）；failed/sealed Run 不得改回 running；重试 = 新建 Run（`retryOfRunId`/`attempt+1`）。
- **paused 语义**：已 running/blocked 的 Run 可走完自身状态机；只禁止创建新 Run 与推进 chain；`session complete` 的「无 running Run」校验不因 paused 放宽。

## 4. 错误合同（方案 B §6；整改计划 F1）

- revision 冲突响应必须含：`code`（如 `RUN_REVISION_CONFLICT`）、`target_type`、`target_id`、`expected_revision`、`current_revision`、`changed_by`、`next_actions`。
- Pi 至少断言以下错误码的结构：`RUN_REVISION_CONFLICT`、`REQUEST_CONFLICT`、`SESSION_AMBIGUOUS`、`SESSION_SCHEMA_UNSUPPORTED`（旧 CLI 对 v3 数据 fail-closed 用）。
- `help --json` catalog 从 Commander 注册树生成并做 parity gate（F1），字段含 mutation scope、target revision/CAS、options、examples、deprecated/replacement。

## 5. Resume map（方案 B §12）

`session resume-view --json` 输出 `ResumeMapV1`：

- 字段：sessionId、sessionStatus、三个 revision、activeRuns[]（runId/stepId/status/revision）、blockingGates、openDecisions、pendingPublications、nextActions[]（action/targetId/expectedRevision）、fingerprint。
- 硬约束：**不含** executionId/generation/lease/operation 任何字段（Pi 侧见到即判协议不符并 fail-closed）；序列化后 ≤2KB；数组按稳定 ID 排序、canonical hash 作 fingerprint。

## 6. 迁移（方案 B §13）

- v2→v3 迁移器：冻结旧快照并记 hash；session/2.x+execution/1.0+run/2.x 投影为 session/3.0+run/3.0；execution generation 映射为 `legacyExecutionGeneration` 审计字段；finalOutcome/seal summary 映射为 Session transition receipt。
- **不复制任何 lease/operation private token**；迁移报告只记 hash 与丢弃原因。
- 双读单写：新 CLI 读 v2/v3、只写 v3；旧 CLI 对 v3 返回 `SESSION_SCHEMA_UNSUPPORTED`；禁止 dual-write。
- 有 running Run 的旧 Session 不自动迁移；迁移 commit 后旧 lease/operation token 永久失效。

## 7. 验收清单（阶段 2 完整交付的启动门槛，方案 B §17）

并发：

- [ ] 不同 Run 的 mutation 并发成功；activityRevision 递增不产生 CAS 冲突
- [ ] 同一 Run 两个 mutation 仅一个成功，另一个收到 current revision + next_actions
- [ ] `run complete --advance` / `session complete` 故障注入无半提交
- [ ] 同 requestId + 同 payload replay 返回同 receipt；不同 payload 或跨 participant 返回 `REQUEST_CONFLICT`

状态机：

- [ ] pending Run 可直接 cancel；blocked Run 直接 fail 需附判定依据
- [ ] paused Session：running Run 可 complete，创建新 Run 被拒

多窗口：

- [ ] 3 个 participant 同读同一 Session，无 attach/lease/handoff
- [ ] participant A 关闭不影响 B/C；A 的过期 revision 请求被拒；注销不改 Session 状态

迁移与恢复：

- [ ] v2 fixture 投影后 Run/chain/gate/artifact/evidence 引用无损；旧目录 hash 只读可审计
- [ ] resume-view 输出满足 §5 全部硬约束（无 lease/execution 字段、≤2KB）
- [ ] 旧 CLI 对 v3 mutation 返回 `SESSION_SCHEMA_UNSUPPORTED`

capability：

- [ ] `capabilities --json` 满足 §1 全表；对照 Pi 侧 `test/cli-adapter-capabilities.test.ts` 的 v3 fixture（`v3StructuredCapabilities`）可直接互测

## 8. core 侧应删除项（方案 B §9；对齐 Pi 已完成的拆除）

- operation registry / admission / drain_root / operation claim / parent_operation_id / operation token 全部持久化状态与 `execution operation *` 命令族。
- `execution handoff prepare` 的 `--drain-operation*` 参数族（Pi 已不再发送；当前 core 强制要求该参数会导致普通 prepare 失败）。
- Execution 实体、generation、长期 lease、heartbeat、handoff（按 §13 迁移路径退役，运行期不再新建）。
