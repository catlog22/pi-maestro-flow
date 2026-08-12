# 基础设施审查修复计划（2026-08-12）

> 基线：`docs/infra-audit-multi-perspective-20260812.md` 的 33 项 findings。
> 原则：全部按待治理处理；当前 worktree 中已有的候选改动只有通过本计划验收后才能标记完成。
> 架构修订：采用 `docs/session-run-minimal-state-architecture-20260812.md` 的方案 B。本计划早期版本中的 Execution lease、operation claim/drain、handoff 和 seal-route 路线已被本修订取代，不再实施。

## 一、不要做 33 个零散补丁

33 项问题合并为七条根因主线。主线是根因归组，同一 finding 的具体实现位置以「实施小节」列与第六节覆盖矩阵为准：

| 主线 | 覆盖 findings | 根因 | 实施小节 |
|---|---|---|---|
| A. Session + Run 最小状态与 CAS | S3、S5、S6、L3，支撑 C5 | Execution/长期 lease/operation drain 把多窗口协作建模成所有权转移；改为 participant ID + target revision CAS + core 原子事务 | A0/E1/E2/E3 |
| B. Teammate publication 与 resource | T1、T2、T4、T5、T6、R1–R6 | 执行完成、原文保存、结果发布、通知和 resource 读取不是同一可靠事务 | B0/B1/B2/B3 |
| C. 消息 origin/authority | X1 | workspace peer custom message 在模型边界变为普通 user，来源和任务权限丢失 | C0 + 第四节 SDK |
| D. Resume map、brief 与 evidence | C1–C6、S1、S2、S4、S7、L2、L4 | checkpoint 已有数据但恢复入口未消费；brief/证据返回未按恢复用例分层 | D1/D2/D3/D4/D5 |
| E. 版本化迁移与本地任务边界 | C5、S5、S6、L5 | v2 Execution 状态需无损迁移到 Session/Run；本地异步任务清理需与 Session authority 解耦 | A0/E2/D2/F2 |
| F. CLI 与失败体验 | T1、T2、L1、L3、L5、L6 | 命令族重叠、help 非机器可读、错误缺少结构化 next action | B1/F1/F2/E3 |
| G. 效率与会话复用 | T3、T7 | 前台等待与 dispatch 生命周期耦合，固定 600 秒附着窗口阻塞主会话；每次 dispatch 冷启动，缺少稳定的跨 dispatch session 身份 | B4/B5 |

## 二、不可变约束

1. Maestro core 是 Session/Run、entity revision/CAS、短事务锁和 transition receipt 的唯一持久化权威。
2. Pi coordinator 只注入 participant/actor/request/expected revision，不维护第二套 workflow authority。
3. Session 允许多个 participant 并发；同一 target 的冲突由细粒度 revision CAS 检测，不使用长期独占 lease。
4. teammate/bash_bg/compaction/publication 只属于各 Pi 进程的本地任务生命周期；它们不占用 Session authority，也不阻塞其他 participant。
5. teammate run completion 与 publication completion 分开报告；publication 失败必须进入 recoverable 状态，不能发布死 URI。
6. 非人类消息不能更新 active human objective；`steer` 只代表投递时序，不代表 objective-control 或 authorization。
7. 任何截断必须提供可继续读取的 cursor/资源指针；不能出现不可逆的“只剩尾部文本”。
8. 所有兼容迁移由 capability/schema 驱动，不能只按 semver 猜测。

## 三、实施波次

### Wave 0：安全前置与快速确定性缺陷

#### A0. Session/Run v3 协议与迁移骨架

覆盖：S3、S5、S6、L3 的架构前置；支撑 C5（为 D1/D2 的 checkpoint/publication 对账提供 Session/Run 协议与迁移基础）。

实现：

- 冻结 `session/3.0`、`run/3.0`、participant identity、细粒度 revision 和 request receipt 合同。
- 删除目标模型中的 Execution、长期 lease、heartbeat、handoff、operation registry 和 distributed drain。
- core mutation 统一使用 `participantId + actorId + requestId + targetId + expectedRevision`。
- Session 拆分 identity/orchestration/activity revision；Run、artifact、evidence 各自有 revision。
- 关键跨实体动作（如 Run complete + chain advance、Session complete）下沉为 core 单一原子事务。
- 建立 v2 -> v3 双读单写迁移器；旧 Execution/lease/operation 只做只读审计，不复制 private token。

权威文档：`docs/session-run-minimal-state-architecture-20260812.md`。

并行协调：当前 `implement-pi-operation-drain-hooks` executor 的方向与目标架构冲突，应停止继续扩展 operation tree；其已有代码只可作为迁移期实验，不进入 v3 production 路线。

#### B0. 发布包完整性

覆盖：T5。

- `packages/pi-maestro-teammate/package.json` 显式包含 `src/experts-mode/config/*.json`。
- 增加 `npm pack -> 临时目录解包/安装 -> 从包外执行 loadRules()` 冒烟测试。
- tarball 清单断言 `default-rules.json` 存在。

#### C0. 消息权限短期防线

覆盖：X1 的插件层。

- 保留 typed `coordination/request/status/supervision` 协议；legacy message 降级为 coordination。
- 普通 peer 默认 follow-up；status 永远 follow-up；只有持有效 monitor binding/capability 的 supervision 可 steer。
- source 由入口派生，旧协议标为 `legacy-unknown`，不得默认 system。
- active human objective revision 不因 peer/custom 消息变化。

注意：当前 typed envelope 改动只是候选实现；还需要 steer authority matrix 与 source 可信化验收。

### Wave 1：结果不丢失与可恢复失败

#### B1. 统一 failure envelope

覆盖：T1、T2、T4、R3、R6、L6 的基础部分。

新增公共合同：

```ts
type FailureLayer =
  | "admission" | "package" | "spawn" | "runtime"
  | "provider" | "publication" | "resource";

interface TeammateFailureV1 {
  version: 1;
  layer: FailureLayer;
  code: string;
  retryable: boolean;
  retryScope: "same-model" | "restart" | "fallback" | "repair" | "manual" | "none";
  message: string;
  field?: string;
  allowedValues?: string[];
  nextAction?: string;
  diagnosticRef?: string;
}
```

- stderr 只作为诊断，不作为“发生外部副作用”的证据。
- 未出现 protocol/tool/IPC 时允许一次同模型冷重启；出现副作用后禁止 replay。
- TypeBox 的入口错误需要宿主 formatter hook；插件无法覆盖 execute 之前的校验时，T2 标记为外部阻塞而非伪装完成。

#### B2. Canonical publication store

覆盖：T6、R1、R2，并为 R4 提供数据源。

- publicationId 在 turn 开始时生成；原始 assistant stream 在 64KB transcript 展示截断前写入私有 spool。
- publication store 的领域所有权放入 `pi-maestro-teammate`，不再依赖 Flow 事件 listener 才持久化。
- 原子顺序：blob temp -> fsync/rename -> manifest -> alias；alias 永远最后更新。
- 每个最终结果返回 `PublicationReceiptV1`：persisted、canonicalUri、bytes、sha256、state、failure。
- `persisted=true` 必须保证 URI 可读且 hash 验证通过；失败时保留 inline 全文或 recoverable pending spool。
- 旧 Flow store 作为 legacy reader/facade 保留一个弃用周期。

#### B3. Resource 分页与诊断

覆盖：R4、R5、R6，闭环 R1–R3。

- resource 增加 `cursor/offset/limit/forceRefresh` 可选参数。
- 默认 page 32KB、最大 64KB；返回 totalBytes、complete、nextCursor、sha256、identifierKind、canonicalUri。
- cursor 绑定 publicationId/hash/offset，禁止跨 publication 复用。
- publication/correlation/name 三类解析在 details 中明确；missing/ambiguous/corrupt/scope-mismatch 返回机器错误码和 next action。
- PR/Issue 返回 cachedAt/expiresAt，支持 forceRefresh；agent 资源明确不参与 5 分钟 ghCache。

### Wave 2：确定性恢复地图

#### D1. `resume-map/1.0`

覆盖：C1、C2、C4、C5、S4、L4。

从已有 checkpoint 投影稳定 JSON：

- Pi session/checkpoint identity。
- Session ID + identity/orchestration/activity revisions + fingerprint；不含 execution locator、lease 或 operation 状态。
- blocking gates、open decisions、artifact/evidence refs。
- running/published/consumed agent + publicationId/resource URI。
- authority、next action、preconditions、guidance path+hash。
- canonical JSON hash；数组按稳定 ID 排序。

字段以方案 B ResumeMapV1 为基准；authority 指 next action 的授权前提（participant/gate 条件），非独占所有权；preconditions/guidance 为 Flow 侧扩展字段，走 `resume-map/1.x` 增量。

恢复入口直接消费 map，注入不超过 2KB 的地图卡；不再默认加载完整 brief。未知版本、损坏或 revision 冲突必须停止自动 mutation并给恢复动作。

#### D2. checkpoint v4 与 publication 对账

覆盖：C2、C5。

- checkpoint 新增 resumeMap、agent publication watermark 和 consumption 状态。
- 压缩期间新完成的 publication 在 watermark 后补入。
- running agent 只记录身份，不等待完成；published+durable 记录资源引用；persist failure 记录 repair action。
- Goal、output-limit、普通 compaction 的续接统一由单一 ResumeCoordinator 发出，保证恰好一次。
- 本方案以确定性 resumeMap 投影取代基线 C2 建议的模型摘要必保字段校验；摘要仅作辅助展示，不再是恢复正确性的依赖。

#### D3. brief 分层与 freshness

覆盖：S1、S2、L2。

Maestro core 新增：

```text
maestro run brief <run> --view map|full --json
```

- map 目标 <2KB：locator、revision、run/gates、continuation、artifact index、guidance path+hash。
- full 保持旧行为；先 capability rollout，下一 major 才考虑更改默认。
- accept 后刷新 map 并校验 revision/hash；仅 guidance/command contract hash 变化时加载正文。

#### D4. resume-view 与 evidence cursor

覆盖：S4、S7、L4。

- `maestro session resume-view --json` 或 `session status --full --json` 使用同一个 builder。
- 在单锁快照内返回 Session 状态、chain 邻域、blocking gates、active Runs、decisions、artifact/evidence index、participants 和 next actions。
- evidence 默认返回摘要/计数/索引，支持 projection/page-size/cursor；revision 改变返回 `EVIDENCE_CURSOR_STALE`。
- 大正文只返回 artifact path/hash/bytes，通过 resource 分页读取。

#### D5. C3/C6 治理

- C3：回放 41.9h transcript，验证 nudge -> auto-prune -> critical 顺序和提前量。
- C6 不应机械关闭 cache。较新的 governing spec 允许“两阶段、只否决 prune”的 cache gate 默认开启。
- 发布 ADR，明确 supersede 旧设计、critical bypass、无 telemetry 退化、回退开关和 saved tokens/invalidated suffix/veto/hard-compaction 指标。

### Wave 3：Session + Run v3 与 CLI 收敛

#### E1. Session orchestration CAS

覆盖：S3。

- `session chain insert|skip|replace|audit` 使用 `orchestrationRevision` CAS、requestId、participant/actor/reason/evidence。
- transition 记录 before/after hash；replay 幂等，不同 payload 同 requestId 返回冲突。
- chain 与 Run 状态需要同时变化时，使用 core 复合事务，禁止客户端多命令拼接。

#### E2. Session complete 原子事务

覆盖：S5、S6。

- 删除 lease handoff 与 seal-route；多个 participant 不需要转移 owner。
- `session complete` 在一个 core transaction 内执行 preflight、允许的确定性 projection repair、gate/Run/decision 校验、completion receipt。
- repair 只允许由 sealed Run/receipt 确定性证明的 pointer/projection 修复；不得跳 gate、伪造 evidence、替用户裁决。
- participant A 关闭不影响 B/C；A 的延迟 mutation 由 target revision CAS 拒绝。

#### E3. 上下文推导 fail-closed

覆盖：L3。

优先级固定为：显式 Session/Run ID > 当前 Pi session 绑定 > 唯一 open Session > 唯一可运行候选。多候选必须返回 SESSION_AMBIGUOUS 和候选列表；删除“按 mtime 取最新”。mutation 始终由 Pi 注入精确 target ID 和 expected revision。

#### F1. 可操作错误与 `help --json`

覆盖：L1、L6。

- 复用 `run-response/1.1.error.details`，增加 pointer、expected/allowed、candidates、blockers、retryable、nextActions。
- catalog 字段包括 mutation scope、target revision/CAS、options、examples、deprecated/replacement。
- catalog 从 Commander 注册树生成并做 parity gate，不能手工维护第二份命令表。

#### F2. 命令族收敛

覆盖：L5。

命令清单以方案 B 第 9 节替代命令为准：

- Session：open/pause/resume/complete/archive、status/resume-view、chain insert/skip/replace/audit。
- Run：next/create/brief/check/complete/cancel/seal。
- participant register/status/unregister 为可选管理面。
- Execution/lease/handoff/operation 命令在 v3 中删除；过渡期只返回结构化 replacement，不静默模拟 ownership。
- 旧别名先从默认 help 隐藏并返回 replacement；下一 major 才删除。

### Wave 4：效率与会话复用

#### B4. 前台窗口

覆盖：T3。

新增独立 `foregroundWaitMs`，建议默认 90 秒：

```text
foregroundWaitMs > concurrencyWaitMs(弃用) > timeoutMs(旧detach语义) > 90s
```

窗口结束只 detach，不取消任务；允许一个版本用环境变量回退到 600 秒。

#### B5. 显式跨 dispatch session reuse

覆盖：T7。

```ts
session?: { key: string; mode: "reuse" | "reset" }
```

稳定身份绑定 workspaceId + canonical cwd + role + resolved model + user session key。默认仍 fresh。reuse 必须校验受控路径、role/cwd/model 和单个本地 agent 实例；reset 不删除历史 publication。该本地 agent session 复用不构成 Maestro Session lease。

## 四、消息权限的根本修复

X1 不能仅靠插件文本完全关闭。需要 Pi SDK/宿主增加可信消息来源：

```ts
type MessageAuthority =
  | "objective-control" | "authorization"
  | "coordination" | "request" | "status" | "safety-lifecycle";
```

- human-user 只能由宿主认证的人类输入创建。
- extension/peer/agent/monitor origin 由宿主生成，插件不能通过正文或 details 自授。
- `convertToLlm()` 不再把所有 custom message 无差别变成普通 user；provider 不支持自定义 role 时，由宿主用不可伪造的结构化上下文投影。
- developer prompt 明确“最新 user request”只指 human-user，不包括 peer、custom、RPC、tool result、monitor、自动 continuation 和 compaction summary。
- compaction/fork/resume/replay 必须保留 origin/authority。

在 SDK 修复完成前，插件层只能把 X1 标记为 partial mitigation。

## 五、依赖与并行关系

```text
Wave 0 Session/Run v3 contract ─┬─> v2→v3 migration
                                 ├─> Session orchestration CAS
                                 └─> Session complete transaction

Wave 1 publication store ───────┬─> resource paging
                                 └─> resume-map publication references

Wave 2 resume map ──────────────┬─> brief map/freshness
                                 └─> resume-view/evidence pages

Wave 3 Session/Run v3 core ─────┬─> CLI canonical command catalog
                                 └─> Execution/lease aliases removal

Message SDK authority can parallelize, but X1 cannot close before it lands.
```

注：「Wave 2 resume map → brief map/freshness」的依赖是 resume-map 格式合同级别（合同先冻结），不是实现串行依赖；D1（Pi 侧投影）与 D3（Maestro core 侧 brief map）的实现可并行，与第九节第 4 步的「同时实现」不矛盾。

可并行 lanes：

- teammate publication/store。
- compaction resume-map。
- Maestro core read APIs。
- message authority SDK。
- package T5。

必须单一 writer 的热点：

- `D:/maestro2/src/run/schemas.ts` 与 Session/Run mutation/store：v3 schema/migration owner。
- `packages/pi-maestro-flow/src/session/coordinator.ts`、`bridge.ts`、`run-response.ts`：v3 adapter owner；删除 lease/operation 路线后再合并 resume/message 接口。
- `packages/pi-maestro-flow/src/extension/index.ts`：integration owner，负责移除旧 operation hooks 并接入本地任务 registry。
- generated `types/**`：所有源码 lane 合并后统一生成，避免覆盖并行声明变化。

## 六、覆盖矩阵

| Finding | 处理位置 |
|---|---|
| T1 | B1 failure envelope |
| T2 | B1 + 宿主 schema formatter |
| T3 | B4 foregroundWaitMs |
| T4 | B1 spawn/runtime replay classifier |
| T5 | B0 packed resource test |
| T6 | B2 pre-truncation durable spool |
| T7 | B5 explicit session reuse |
| C1 | D1 resume-map injection |
| C2 | D1/D2 schema validation + deterministic fallback |
| C3 | D5 transcript replay acceptance |
| C4 | D1 direct checkpoint resume |
| C5 | A0/D1/D2 agent publication reconciliation |
| C6 | D5 superseding ADR and metrics |
| R1 | B2 publication receipt |
| R2 | B2 reliable full-text channel |
| R3 | B1/B3 versioned resource contract |
| R4 | B2/B3 artifact + cursor |
| R5 | B3 cache timestamps/forceRefresh |
| R6 | B1/B3 identifier diagnostics |
| S1 | D3 brief map/full split |
| S2 | D3 revision/hash freshness |
| S3 | A0/E1 Session orchestration CAS/audit |
| S4 | D1/D4 resume-view |
| S5 | A0/E2 删除长期 lease/handoff，采用多 participant CAS |
| S6 | A0/E2 Session complete 原子事务 |
| S7 | D4 evidence cursor |
| L1 | F1 help JSON |
| L2 | D3 brief layering |
| L3 | A0/E3 fail-closed context resolution |
| L4 | D1/D4 composite recovery view |
| L5 | F2 command family convergence |
| L6 | B1/F1 actionable errors |
| X1 | C0 + Pi SDK trusted origin/authority |

## 七、验收门槛

每项 finding 只有同时满足以下条件才能从 open 改为 resolved：

1. 生产代码和公开协议已实现，不是仅文档或提示词建议。
2. 最小行为测试通过；高风险边界有失败注入/并发/重放测试。
3. packed consumer/旧协议兼容验证通过。
4. 运行时 metrics 或 replay 证明目标效果，而非仅单元测试存在。
5. 外部 SDK 依赖已发布并由当前 package 实际消费；否则只能标 partial/blocker。

重点验收：

- T5：真实 tarball 外部加载默认 rules。
- T4：崩溃诊断（spawn 参数、stderr）持久化且事后可读；仅允许一次同模型冷重启，出现副作用后禁止 replay 的围栏行为有失败注入测试覆盖。
- R1/T6/R4：92KB、600KB、多 MB UTF-8 结果可 hash 验证并分页无损重组。
- C1/C4：压缩恢复命令从 4–6 降为 0–1，注入 <=2KB。
- C2：resolved 判据是确定性 resumeMap 投影替代基线建议的模型摘要必保字段校验（与 D2 的取代关系一致）；不以摘要字段解析校验作为验收标准。
- S1/S2/L2：brief map <2KB；对照基线（单 workflow 约 17 次 brief 加载 ≈500KB ≈12.5 万 token），重复全文加载降为仅 guidance/command contract hash 变化时加载，其余场景只刷新地图卡。
- S3/S5/S6：不同 target 并发成功；同 target CAS 竞争只有一个成功；response loss、migration failure、Session complete failure 均无半提交。
- L5/L6：参数校验失败后，按错误中的 nextActions/allowedValues 做一次修正即可成功；调用旧 Execution/lease 命令返回结构化 replacement 而非静默失败或静默模拟。
- X1：非人类消息不能更新 human objective revision；legacy peer 无 steer/root objective authority。

## 八、回滚策略

- resume-map、brief layers、evidence cursor、help JSON 全部 additive + capability gated。
- brief 默认先保持 full；Flow 检测 capability 后请求 map。
- resource 旧 `uri` 调用保持有效；分页字段可选。
- message v1 缺 kind 按 legacy coordination/follow-up 处理。
- foreground window 提供 600 秒兼容开关一个版本。
- Session/Run 旧命令保留 deprecated alias 一个 major。
- publication dual-read、不 dual-write；新 store 失败时不得发布死 URI。
- v2→v3 迁移保留 v2 目录只读 + hash 审计；首个 v3 写入发生前允许原子回切 pointer；之后迁移视为单向（方案 B 禁止 dual-write，迁移 commit 后旧 lease/operation token 永久无效），放行以并发/故障注入迁移测试通过为门槛。
- checkpoint v4 新字段（resumeMap、publication watermark、consumption 状态）均为可选；旧 checkpoint 缺失这些字段时按旧恢复路径处理，不阻塞恢复。

## 九、建议立即执行顺序

1. 冻结并实现 Session/Run v3 schema、participant/request/revision 合同；通知 operation-drain executor 停止旧路线。
2. 并行完成 v2→v3 迁移器、T5 packed-resource 修复和 publication/failure contract。
3. 实现 canonical publication store，再实现 resource cursor。
4. 实现 resume-map/checkpoint v4，同时由 Maestro core 实现 Session resume-view、brief map、evidence cursor。
5. 实现 Session orchestration CAS、Run 细粒度 CAS 和 Session complete 原子事务。
6. 删除 Pi lease/operation/handoff adapter，收敛 help/error/command aliases。
7. 最后切换 foreground 默认值并开放 explicit teammate session reuse。
8. 单独推动 Pi SDK trusted origin/authority；在其落地前 X1 保持 partial。
