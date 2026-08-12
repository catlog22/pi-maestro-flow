# Session/Run v3（方案 B）开发行动规划（2026-08-12）

> 状态：行动规划（依据 `docs/session-run-minimal-state-architecture-20260812.md`，下称「方案 B」）
> 整改映射：对应 `docs/infra-audit-remediation-plan-20260812.md` 的 A0（Wave 0）、D1/D2（Wave 2）、E1/E2/E3、F1/F2（Wave 3）。
> 历史背景：`docs/session-execution-generation-migration-plan.md` 描述的 Execution/Generation + lease/handoff 路线已被方案 B 整体取代，本规划不采纳其任何执行项，仅沿用其中仍有效的 CLI 机器合同基线（单行 envelope、exit parity、request-id 幂等）。

## 0. 仓库边界与总原则

本仓库是 Pi 插件侧（`packages/pi-maestro-flow` 通过 spawn 外部 `maestro` CLI 与 core 交互；`packages/pi-maestro-teammate` 为协作子系统）。**Maestro core CLI 是独立代码库**：v3 schema、原子 mutation、transition receipt、v2→v3 迁移器、命令族收敛（E1/E2/E3、F1/F2 的 core 部分）全部在 core 侧实现。本规划中 core 侧工作一律标注「外部仓库」，本仓库只交付 Pi 侧适配。

禁止项（全程有效）：

1. 禁止 dual-write：Pi 不得同时向 v2 与 v3 协议写入同一业务状态（方案 B §13）。
2. 禁止 Pi 侧维护第二套 workflow authority：coordinator 只注入 participant/actor/request/expected revision（整改计划约束 2）。
3. v2 lease adapter 冻结：过渡期保持现行为，不再新增功能，只修正确定性缺陷。
4. 不复活 operation claim/drain/handoff 任何形式的变体。

阶段总览：

| 阶段 | 一句话目标 | 实现侧 | 启动条件 |
|---|---|---|---|
| 0 | operation claim/drain 拆除收尾与回归基线 | Pi | 立即 |
| 1 | v3 合同冻结与 core 实现（A0/E1/E2/E3/F1/F2） | core（外部仓库） | 立即（跨仓协调） |
| 2 | v3 capability 协商 + 双模 adapter | Pi | 先行项立即；完整交付待阶段 1 验收 |
| 3 | v2 lease adapter 退役 + resume-map 消费（D1/D2） | Pi | 阶段 2 稳定 + core resume-view 可用 |
| 4 | 端到端验收与文档收敛 | Pi | 阶段 1–3 完成 |

## 阶段 0：已完成项收尾（Pi 侧，立即）

分布式 operation claim/drain 实验代码的拆除视为已完成项，本阶段只做收尾验证。

- 交付物：
  - 确认 `src/session/coordinator.ts`、`src/extension/index.ts` 无 operation claim/drain/handoff 残留引用；本地任务清理仅走进程内 registry（方案 B §10）。
  - 全量单测通过基线（`test/workflow-coordinator.test.ts`、`test/run-recovery.test.ts` 等），作为后续阶段回归基准。
- 验收标准：grep 无 `operation claim/drain_root/handoff` 生产路径引用；对应方案 B §1「删除」清单中 Pi 侧条目。
- 依赖：无。
- 涉及文件：`packages/pi-maestro-flow/src/session/coordinator.ts`、`packages/pi-maestro-flow/src/extension/index.ts`、`packages/pi-maestro-flow/test/workflow-coordinator.test.ts`。

## 阶段 1：core 侧 v3 合同冻结与实现【外部仓库依赖】

对应整改计划 A0/E1/E2/E3/F1/F2。本仓库不实现，仅作为下游消费方提出输入与验收要求。

- 本仓库向 core 提供的输入：
  - Pi 侧消费的 capability 关键字清单（方案 B §15）：`session_run_minimal_v3`、`entity_revision_cas`、`participant_identity`、`request_receipts_v2`，且 `execution_lease`/`operation_registry` 必须显式为 `false`。
  - Pi 侧需要的命令面：`session open/pause/resume/complete/archive/status/resume-view`、`run next/create/brief/check/complete/cancel/seal`、`session chain insert/skip/replace/audit`，全部支持 `--participant/--actor/--request-id/--expected-<target>-revision/--json`（方案 B §9）。
  - 错误合同：`RUN_REVISION_CONFLICT` 等冲突响应须含 `current_revision` 与 `next_actions`（方案 B §6）；上下文歧义返回 `SESSION_AMBIGUOUS`（E3）。
- 对 core 的验收（作为阶段 2 启动门槛）：
  - `maestro capabilities --json` 返回上述 v3 capability 组合。
  - 方案 B §17「并发」全部条目：不同 Run 并发成功、同 Run CAS 冲突可见、复合事务（`run complete --advance`、`session complete`）故障注入无半提交、同 requestId replay 返回同 receipt、不同 payload 返回 `REQUEST_CONFLICT`。
  - 方案 B §17「迁移」：v2 fixture 无损投影、不持久化 lease/operation token、旧 CLI 对 v3 fail closed。
  - resume-map 输出满足方案 B §12 结构且 ≤2KB（§17「恢复与知识」）。
- 依赖：无（可与阶段 0、阶段 2 先行项并行）。
- 涉及文件：外部仓库（core 的 schemas、mutation store、命令注册、迁移器）。

## 阶段 2：Pi 侧 v3 capability 协商与双模 adapter

核心交付：cli-adapter 识别 v3 capability 并选择 adapter；v2 与 v3 双模并存，单一 authority 仍在 core。

- Pi 侧可先行项（core 未就绪即可开工，用 fake runner 驱动）：
  - `cli-adapter.ts` 新增 v3 capability keys 解析与 `RunCliCapabilityMode` 扩展；capability 不完整时 mutation fail closed、读取可用（方案 B §15）。
  - adapter 选择骨架：v3 完整 → v3 adapter；仅 v2 → 现行 v2 adapter；均不满足 → fail closed。
  - 单元测试：伪造 `capabilities --json` 输出覆盖「v3 完整 / v3 缺项 / 仅 v2 / probe 失败」四种矩阵，扩展 `test/cli-adapter-capabilities.test.ts`。
- core 就绪后的交付物：
  - v3 adapter 实现：Session/Run mutation 统一注入 `participantId + actorId + requestId + targetId + expectedRevision`（方案 B §6）；participant register/unregister 生命周期挂接窗口启停。
  - 注入规则（在 coordinator 层集中实现，模型不手写这些字段，方案 B §9 末段）：
    - `participantId`：每个 Pi 窗口进程启动时生成并注册，kind 固定 `pi-window`，进程内稳定、跨进程不复用。
    - `requestId`：每次 mutation 由 Pi 生成新 UUID；仅在「响应丢失后重试同一意图」时复用原 requestId 触发 receipt replay；收到 `REQUEST_CONFLICT` 视为编程错误上报，不自动换 ID 重试。
    - `expectedRevision`：来自最近一次读取的目标实体 revision；收到 `*_REVISION_CONFLICT` 后必须重新读取并重新评估意图，禁止自动替换 revision 重放旧 payload（方案 B §6/§16）。
  - `run-response.ts`/`bridge.ts`/`types.ts` 接入 v3 envelope 与 `SessionV3/RunV3` 投影；revision 冲突时向模型呈现 `next_actions`。
  - `coordinator.ts` 去除对 execution/lease 状态的依赖路径（仅 v3 分支），v2 分支不动。
  - 复合业务动作（完成 Run 并推进 chain、session complete）一律调用 core 单命令复合事务，Pi 不做多命令拼接（方案 B §8，E1/E2）。
- 验收标准：
  - 方案 B §17「多窗口」：3 窗口同读无 attach/lease；A 关闭不影响 B/C；过期 revision 请求被拒；participant 注销不改 Session 状态（多窗口集成测试）。
  - 方案 B §18：「Pi 不再创建、持有或显示 Execution lease/operation claim」在 v3 分支成立。
- 依赖：先行项无依赖；完整交付依赖阶段 1 core 验收通过。
- 涉及文件：`packages/pi-maestro-flow/src/session/cli-adapter.ts`、`coordinator.ts`、`bridge.ts`、`run-response.ts`、`types.ts`、`packages/pi-maestro-flow/src/extension/index.ts`；测试 `test/cli-adapter-capabilities.test.ts`、`test/workflow-coordinator.test.ts`、`test/session-bridge.test.ts`、`test/run-response.test.ts`。

## 阶段 3：v2 lease adapter 退役与 resume-map 消费

对应整改计划 D1/D2（Pi 侧）与 v2 退出。

- 交付物：
  - resume-map 消费（D1）：恢复入口直接消费 core `session resume-view`/resume-map 投影（方案 B §12 `ResumeMapV1`），注入 ≤2KB 地图卡。消费流程：
    1. 校验 schema 版本与 `fingerprint`；未知版本或 hash 损坏时停止自动 mutation，仅呈现恢复动作。
    2. 以 map 中的 `activeRuns[].revision`、`orchestrationRevision` 作为后续 mutation 的 expectedRevision 初值。
    3. `nextActions` 直接投影为恢复建议；不含任何 executionId/lease/operation 字段，出现即判定 core 版本不符并 fail closed。
  - checkpoint 对账（D2，Pi 侧部分）：checkpoint 记录 resumeMap 与 publication watermark；旧 checkpoint 缺字段走旧路径，不阻塞恢复（整改计划回滚策略）。
  - v2 lease adapter 退役：默认 adapter 切 v3 后，删除 execution/lease 协商分支（`execution_generation`、`core_execution_lease` 探测）与相关 UI 提示；v2 只保留只读兼容。
- 验收标准：
  - 方案 B §17「恢复与知识」：resume-map 不含 Execution/lease 字段且 ≤2KB；Session complete receipt 可驱动 knowledge reconciliation。
  - 整改计划验收门槛 C1/C4：压缩恢复命令从 4–6 次降为 0–1 次。
  - 方案 B §18：「多窗口无需 handoff 即可对不同 Run 并发 mutation」「同 target 冲突由 revision CAS 可见且可恢复」。
- 依赖：阶段 2 v3 adapter 稳定运行；core 侧 resume-view/resume-map（D3/D4，外部仓库）可用。
- 涉及文件：`packages/pi-maestro-flow/src/session/cli-adapter.ts`（删 v2 lease 分支）、`coordinator.ts`、`view-model.ts`（派生视图去 lease 展示）、compaction/恢复入口相关模块；测试 `test/run-recovery.test.ts`、`test/compaction.test.ts`。

## 阶段 4：验收与文档收敛

- 交付物：
  - 端到端验收：跨窗口并发、迁移 fixture、故障注入、packed consumer（`test/packed-consumer-e2e.test.mjs`）全部通过。
  - 文档/提示词收敛：Pi 注入提示、run-control tool description、skills 不再出现 attach/lease/handoff/operation 词汇（方案 B §18 末条）；本仓库 docs 中旧路线文档保持「已取代」标注。
  - 旧 Execution 命令的 Pi 侧调用点清零；如模型仍可能发出旧命令，透传 core 的结构化 replacement（F2）。
- 验收标准（方案 B §18 完成定义逐条勾验，其中 Pi 侧直接负责的条目）：
  - Pi 不再创建、持有或显示 Execution lease/operation claim。
  - 多窗口无需 handoff 即可对不同 Run 并发 mutation；同 target 冲突由 revision CAS 可见且可恢复。
  - packed consumer、迁移 fixture、并发故障注入和跨窗口集成测试通过。
  - 文档、skills、CLI help 透传、run-control tool description 不再要求 attach/lease/handoff。
  - 另按整改计划第七节验收门槛 1–4（生产实现、行为测试、packed 兼容、运行时证据）对 S3/S5/S6/L3/L5/L6 逐项复核。
- 依赖：阶段 1–3 全部完成。
- 涉及文件：`packages/pi-maestro-flow/src/extension/index.ts`（工具描述）、docs/skills 文案、`test/packed-consumer-e2e.test.mjs`。

## 依赖关系总览

```text
阶段 0（收尾）──────────────┐
阶段 2 先行项（fake runner）─┤（可并行，均不依赖 core）
                             │
阶段 1（core，外部仓库）────┴─> 阶段 2 完整交付 ─> 阶段 3 ─> 阶段 4
```

## 整改项覆盖矩阵

| 整改项 | 实现侧 | 落点阶段 |
|---|---|---|
| A0 v3 协议与迁移骨架 | core（外部仓库） | 阶段 1 |
| E1 orchestration CAS / E2 session complete 原子事务 / E3 fail-closed 上下文推导 | core（外部仓库）；Pi 只透传精确 target ID + expected revision | 阶段 1（core）+ 阶段 2（Pi 注入） |
| F1 结构化错误与 help --json / F2 命令族收敛 | core（外部仓库）；Pi 透传 replacement 与 nextActions | 阶段 1（core）+ 阶段 4（Pi 调用点清零） |
| D1 resume-map 投影与注入 / D2 checkpoint v4 对账 | Pi 侧（core 提供 resume-view/brief map 数据源） | 阶段 3 |

## 测试策略

- 单元层（fake runner）：`RunCliAdapter` 接受注入的 runner 函数，测试以伪造 `capabilities --json` 与命令响应驱动，不依赖真实 `maestro` 可执行文件。阶段 2 先行项的全部测试在此层完成。
- 合同层：v3 envelope 解析、revision 冲突呈现、requestId replay 语义在 `test/run-response.test.ts`、`test/cli-adapter-capabilities.test.ts` 固化；每个错误码（`RUN_REVISION_CONFLICT`、`REQUEST_CONFLICT`、`SESSION_AMBIGUOUS`、`SESSION_SCHEMA_UNSUPPORTED`）至少一个断言用例。
- 集成层（需真实 core，阶段 2 完整交付后）：多窗口并发脚本对同一 Session 启动 3 个 coordinator 实例，覆盖方案 B §17「多窗口」四条；恢复链路回放覆盖 C1/C4 指标（恢复命令 0–1 次）。
- 回归护栏：v2 分支在阶段 3 前的每次提交都必须跑 `test/workflow-coordinator.test.ts` 与 `test/run-recovery.test.ts`，证明 v2 行为零漂移。

## 风险与回滚

- 阶段 2 先行项风险最低：v3 分支占位实现保证 v2 行为零变化，任何时点可整体撤销该分支。
- 阶段 2 完整交付期间，adapter 切换由 capability 探测驱动（整改计划约束 8）：core 未发布 v3 时自动落在 v2 分支，无需 feature flag。
- 阶段 3 删除 v2 lease 分支是单向操作，须在 v3 adapter 通过多窗口集成测试后执行；回滚手段是 git revert 该删除提交，而非在运行时保留双路径（避免变相 dual-write/双 authority）。
- 数据层回滚归 core 侧（v2 目录只读 + hash 审计、首个 v3 写入前可原子回切 pointer，整改计划第八节）；Pi 侧不承担数据回滚职责。
- 跨仓节奏风险：core 的 capability 组合若与 §15 清单不一致（例如缺 `request_receipts_v2`），Pi 按 fail-closed 处理并阻断阶段 2 完整交付，不得放宽校验「先跑起来」。

## 下一步立即可执行（Pi 侧）

1. 阶段 0 收尾验证：grep 确认 operation claim/drain 生产路径清零，跑通现有测试基线。
2. 在 `cli-adapter.ts` 定义 v3 capability keys 常量与 `MaestroCapabilitiesV10.features` 的 v3 字段解析（含 `execution_lease/operation_registry === false` 校验）。
3. 实现 adapter 选择骨架（v3 / v2 / fail-closed 三态），v3 分支先以 `NotImplemented` 占位，保证 v2 行为零变化。
4. 用 fake runner 扩展 `test/cli-adapter-capabilities.test.ts`，覆盖四种 capability 矩阵与 fail-closed 语义。
5. 整理并向 core 仓库提交阶段 1 的输入/验收清单（capability 组合、命令面、错误合同、resume-map ≤2KB），作为跨仓协调依据。
