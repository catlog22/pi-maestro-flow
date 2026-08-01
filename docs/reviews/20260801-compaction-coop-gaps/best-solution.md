# 压缩剪枝系统跨流程配合缺口：Swarm 最佳解综合

## 1. 执行摘要

本轮只审查跨流程配合边，不重复 20260728 已完成的单流程正确性审查。目标是识别压缩、剪枝、扩展钩子、状态持久化、provider 请求、Goal/Todo/Plan 以及会话/嵌套会话之间的状态丢失、顺序违规、所有权冲突和交接遗漏。

- **Swarm 配置**：完整图 12 个节点、66 条活动边；每条路径最多 4 个节点；`3` 轮 × `5` ants，共 `15` 个 artifact；ACO 参数 `alpha=1.0`、`beta=2.0`、`rho=0.2`、`q=1.0`，每轮保留 3 个 elite。
- **最佳 ant**：`ANT-1-3`，iteration `1`，verified score `0.9999999999999999`（下文按 `1.000` 展示）。
- **Top 路径**：`deferred-intent -> extension-wiring -> nested-session -> budget-guard`。
- **核心结论**：应把“会话本地的压缩/provider 安全”与“父会话拥有的 Workflow/Goal/Plan/Todo 生命周期”拆开。当前 teammate child 只保留交互/权限代理 surface，连同 output-limit 结算和最终 payload 守卫一起被裁掉，导致 child 截断结果无法 compact-and-continue，以及 K2 在 child 上的衍生风险。
- **系统级结论**：最佳路径不是唯一高价值区域。第 3 轮 `ANT-3-3` 以另一条路径同分 `1.000`，并确认 telemetry/deferred/settings 边界的 3 个 live high。因此结果代表多个交接不变量同时失守，不是单一根因。

## Best Solution（最佳解）

**Path**：`deferred-intent -> extension-wiring -> nested-session -> budget-guard`  
**Verified Score**：`1.000`  
**Iteration**：`1 / 3`  
**Ant**：`ANT-1-3`

### 最佳解摘要

teammate launcher 明确给每个 child 设置 `PI_TEAMMATE_CHILD=1` 并继承 Maestro extension，但 extension 在 child 分支提前返回，仅注册代理工具和少量生命周期监听。父级 Workflow/Goal/Todo 不应在 child 中重复拥有是正确的；把 `context`、`before_provider_request`、`agent_end`、`agent_settled` 以及 child 自己的 compaction arbiter 一并排除则过度隔离，破坏了两条会话本地不变量：任何截断输出都必须被结算或明确失败；任何 Anthropic payload 都必须满足 thinking budget 约束。

### Evidence Chain

- `packages/pi-maestro-teammate/src/runs/execution.ts:500`：child 环境写入 `PI_TEAMMATE_CHILD=1`。
- `packages/pi-maestro-teammate/src/runs/execution-infra.ts:1249-1266`：child 显式加载 teammate extension，并继续加载继承的 extensions。
- `packages/pi-maestro-flow/src/extension/index.ts:490-493`：Maestro extension 检测 child 后调用 `registerMaestroChildSurface()` 并立即返回。
- `packages/pi-maestro-flow/src/extension/index.ts:2008-2072`：child surface 只注册代理工具/权限；没有 root 的 pressure/provider/end-of-turn hooks。
- `packages/pi-maestro-flow/src/extension/index.ts:1843-1886`：root surface 才注册 `context`、`before_provider_request`、`agent_end`、`agent_settled`。
- `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:195-224`：K2 最终 payload 守卫 `disableInvalidBudgetThinking()`。
- `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:990-1077`：root 的 deferred/output-limit 捕获和 settled 结算链。
- `packages/pi-maestro-flow/test/extension-tools.test.ts:555-566`：现有 child 测试反向确认 `agent_end` 缺席，却没有 child 本地压缩/provider 安全测试。

### Candidate Artifact

完整候选解位于 `outputs/ant-1-3.json`。其最小方向是抽取 child-safe、session-local 的 compaction surface：每个 child 自有 `CompactionArbiter` 与自动压缩状态，注册 `session_start/context/before_provider_request/agent_end/agent_settled/session_before_compact/session_compact/session_shutdown`；继续排除父级 Workflow、Goal、Plan 和 root Todo 所有权。

## Why This Path Won（为何胜出）

| 路径决策 | 引导 | 关键性 |
|---|---|---|
| `deferred-intent -> extension-wiring` | evidence；初始权重 `0.0909` | 把“意图被存储后必须在 settled 结算”定位为钩子接线契约，而非单函数问题。 |
| `extension-wiring -> nested-session` | evidence；初始权重 `0.0909` | 找到决定性 early return：extension 被继承，但关键 hook surface 被整体裁掉。 |
| `nested-session -> budget-guard` | evidence；初始权重 `0.0909` | 把 K2 从“root 已修复”推进为 child 衍生风险，证明不变量没有随会话所有权迁移。 |

最佳路径出现于第 1 轮，三个决策都发生在尚未形成信息素偏好的均匀权重上，因此是证据驱动，不是信息素偶然推高。结论又被 `ANT-1-4` 与 coordinator 综合的 `ANT-2-2` 从 budget/child 两个方向交叉确认。

`1.000` 的直接原因也必须限定：评分脚本奖励至少 3 个 file:line 锚点、compaction 与 extension 双侧覆盖、dual anchor、tri-state/severity、K1-K5 关联、不变量、minimal fix 和路径决策。`ANT-1-3` 完整命中这些项。这个分数是报告/证据完整度，不是影响面的绝对量尺，也不证明它严格优于同分的 `ANT-3-3`。

## Runner-Up Solutions（次优路径）

| 排名 | Ant | 路径 | Score | 与最佳解的差异 |
|---|---|---|---:|---|
| 2 | `ANT-3-3` | `telemetry -> deferred-intent -> settings-arbiter -> budget-guard` | `1.000` | 同分；发现 corrected estimate 丢失、linked threshold 漂移、禁用设置后旧 intent 仍结算。最佳 ant 的选择带稳定排序因素。 |
| 3 | `ANT-3-1` | `telemetry -> cache-gate -> context-evaluate -> prune-manifest` | `0.975` | 复现 cache veto 反而触发 full compaction，以及 cacheDelta 被静默消费；与最佳解互补。 |
| 4 | `ANT-1-4` | `budget-guard -> nested-session -> extension-wiring -> checkpoint-summary` | `0.950` | 独立确认 child K2 风险，并指出直接 checkpoint completion 的未来守卫缺口。 |
| 5 | `ANT-3-5` | `native-compaction -> settings-arbiter -> budget-guard -> checkpoint-summary` | `0.950` | 找到 native fallback 的 live K2、arbiter 生命周期错位及 summary headroom 漂移。 |

最佳路径中的 child surface 缺口有多 ant 交叉确认，不是单次运气；但“哪一个 ant 排名第 1”不稳定，因为第 3 轮出现同分且探索的是不同高危区域。修复规划应吸收 top 5，而不能只实施 `ANT-1-3` 的 child surface 拆分。

## 2. 发现总览

下表对 15 个 artifact 的同源发现做了去重；状态与严重度沿用 ant 的已验证结论，冲突时采用第 3 轮复核口径并在详情中保留限定条件。

| ID | 状态 | 严重度 | 涉及流程对 | 一句话 |
|---|---|---|---|---|
| CF-01 | live | high | Goal continuation <-> output-limit/native compaction | Goal 先排队续接再捕获截断意图，且 before-compact 会失效 marker，成功/取消/错误都缺少事务式 rollback。 |
| CF-02 | risk | high | teammate child surface <-> provider budget guard | child 省略 `before_provider_request`，root 已修复的 K2 在 child 仍可能重现。 |
| CF-03 | live | high | Pi fork <-> prune manifest/spill hydration | fork 复制父记录却更换 sessionId，Flow 丢弃 `reason=fork`，继承 manifest 在首请求前被拒。 |
| CF-04 | live | high | prune replay <-> transcript identity | manifest 只以 callId 为键，跨轮复用 ID 会把旧 replacement 套到新结果。 |
| CF-05 | live | high | reversible session switch <-> spill lifetime | 根/子或 A/B 会话切换把 parked 会话当作永久放弃，异步删除仍需恢复的 spill root。 |
| CF-06 | risk | high | multi-owner session <-> spill/manifest ownership | 同 sessionId 多 owner 共用目录且整快照 last-writer-wins，一方 compact 可破坏另一方活跃状态。 |
| CF-07 | live | high | cache gate <-> pressure escalation | cache gate 拒绝小范围 prune 后仍保留 `action=prune`，near-threshold 逻辑会触发破坏更大前缀的 full compaction。 |
| CF-08 | live | high | Maestro settings <-> Pi preparation | Maestro 保存 `compaction.hard.*`，Pi 0.82.1 只读 legacy top-level 字段，cut point 与 summary budget 使用不同设置快照。 |
| CF-09 | live | high | replacement telemetry <-> deferred intent | spill/prune 修正后的 token estimate 在创建 intent 时被旧 assistant usage 重新覆盖，可能误 abort/compact。 |
| CF-10 | live | high | linked summary threshold <-> output-limit capture | main policy 使用 session/summary 较小窗口，output-limit capture 却只按 active session 百分比判断。 |
| CF-11 | live | high | Pi native summary fallback <-> final payload guard | Maestro 失败后的 Pi summarizer 绕过 `before_provider_request`，可确定性生成 `max_tokens=1, budget_tokens=1024`。 |
| CF-12 | live | high | compaction arbiter <-> host fallback lifecycle | handler throw 会提前解锁，handler undefined 后 fallback 失败则锁到 5 分钟超时。 |
| CF-13 | live | medium | teammate child <-> deferred output-limit settlement | child 没有 `context/agent_end/agent_settled`，截断结果既不记录也不结算。 |
| CF-14 | live | medium | cache gate <-> spill upgrade | gate 用短 plain placeholder 通过经济性判断，随后更长 spill preview 使最终替换跌破阈值却仍被持久化。 |
| CF-15 | live | medium | replayable pass <-> bulk pass | 两阶段 prune 对同一失效后缀各自从零计收益，会拒绝合并后本应盈利的第二阶段。 |
| CF-16 | live | medium | spill reload/fileOps <-> durable checkpoint references | 临时 spill 路径及失败的 read/write 尝试会被提升为 active durable reference，随后 cleanup 令其失效。 |
| CF-17 | risk | medium | async cleanup <-> next-epoch spill write | fire-and-forget cleanup 与立即续接/新 spill 写没有 epoch 屏障，可删新文件或留下 orphan。 |
| CF-18 | live | medium | session switch <-> pending intent | shutdown/start 的 `releaseInFlight()` 清掉纯内存 intent，纯 Q&A 恢复轮无法重建第二轮压缩承诺。 |
| CF-19 | live | medium | fork attachment <-> root Todo hydration | child attach 可恢复父级 active skilled Todo，注入 `todo-active-skill` 并驱动对子会话的压缩。 |
| CF-20 | live | medium | persisted manifest <-> tmp storage | manifest 持久化绝对 `os.tmpdir()` 路径，换 TMPDIR/host/OS 后 L2 恢复必然降级。 |
| CF-21 | risk | medium | spill naming <-> keyed storage | 声称 injective 的 path token 仅 32 位摘要，已有确定碰撞对；当前虽 fail closed，仍会拒绝 spill/互相清理。 |
| CF-22 | live | medium | prune manifest <-> cache telemetry | normal-pressure tool batch 不显示 `cacheDelta`，但 runtime 随后无条件清空，唯一纵向归因丢失。 |
| CF-23 | risk | medium | provider cache semantics <-> provider-agnostic gate | Flow 把“从未报告缓存”与真实 0% miss 合并，且默认 gate 不看 provider/model/实际费率。 |
| CF-24 | live | medium | Pi compaction entry <-> session_compact knowhow | 相同 summary 文本重复出现时 Pi 用 `find(summary)` 取最早 entry，knowhow 绑定错 checkpoint。 |
| CF-25 | live | medium | settings refresh <-> retained pending intent | 用户禁用 compaction 后，旧 intent 仍携带旧 settings 在第二次 settled 时提交。 |
| CF-26 | live | medium | linked threshold <-> summary fit model | threshold 未纳入 summary 固定 4096 safety + 1024 minimum output headroom，触发点可能必然无法摘要。 |
| CF-27 | risk | low | direct Maestro completion <-> provider guard | 自定义 checkpoint `complete()` 也绕过 AgentSession hook；当前未启用 reasoning，未来启用时会暴露。 |
| CF-28 | live | low | configured model cache <-> auth lifecycle | model resolver 命中缓存后不复核认证，过期模型仍影响 threshold，直到真正 completion 才修正。 |
| CF-29 | risk | low | threshold constants <-> telemetry escalation | output clamp 的 `0.03` 一处导出、一处硬编码，未来修改会静默漂移。 |
| CF-30 | risk | low | stale evaluate <-> lifecycle cleanup | cleanup 可在延迟 spill 建目录前完成，generation fence 只阻止发布，无法回收已写 orphan。 |
| CF-31 | fixed | medium | root deferred intent <-> native owner | root 已按 owner-before-complete 顺序保存 continuation 决策，native completion handoff 有回归覆盖。 |
| CF-32 | fixed | low | evaluate <-> projectCompactionInput | 两种 transform 共用串行 tail 并有 generation fence，未发现二者之间的并发透传。 |
| CF-33 | fixed | low | prune custom entry <-> compaction/tombstone order | projected manifest 是 compaction 的 parent，空 tombstone 在 compact 后追加，恢复取最新记录。 |
| CF-34 | fixed | low | Plan/Todo/status projection <-> runtime compaction state | Plan/Todo end hook 不产生 Goal 同类续接；statusline 只读 extension status，不回写 intent/manifest。 |

## 3. 高价值发现详情

### High

#### CF-01 Goal/output-limit continuation 不是一个事务（live/high）

- **结论**：production `agent_end` 先执行 Goal，再执行 output-limit capture。`length` 不走 Goal 的 aborted/error 分支，Goal 会排队带 marker 的续接；随后 `onOutputLimit()` 因队列非空直接清意图。即使仅调整顺序，`goalBeforeCompact()` 仍会在 compaction 成功前失效 marker，PreCompact veto、summary error 与 fallback error 都没有 rollback。
- **A 侧证据**：`packages/pi-maestro-flow/src/extension/index.ts:1870-1876`；`packages/pi-maestro-flow/src/tools/goal.ts:482-544`。
- **B 侧证据**：`packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1028-1077`；`packages/pi-maestro-flow/src/tools/goal.ts:427-432,1140-1148`；`packages/pi-maestro-flow/src/hooks/pi-adapter.ts:444-451`。
- **minimal_fix**：由 compaction arbiter 持有 continuation transaction。先捕获 length/usage；把已排队 Goal message 标记为 post-compact continuation；before-compact 只 suspend marker，`session_compact` 成功时 commit，cancel/error 时 rollback 并重排队；checkpoint 保存足够的 owner/marker 状态。

#### CF-02 child 缺少 K2 最终 payload 守卫（risk/high）

- **结论**：child 确定走精简 surface；静态接线证明其没有 final request guard。尚未在 live child 中复现 upstream clamp，因此保持 `risk`。
- **A 侧证据**：`packages/pi-maestro-teammate/src/runs/execution.ts:500-511`；`packages/pi-maestro-teammate/src/runs/execution-infra.ts:1249-1266`；`packages/pi-maestro-flow/src/extension/index.ts:490-493`。
- **B 侧证据**：root guard 位于 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:195-224` 并仅在 `packages/pi-maestro-flow/src/extension/index.ts:1852-1853` 注册；child surface `packages/pi-maestro-flow/src/extension/index.ts:2008-2072` 未注册该 hook。
- **minimal_fix**：立即在 child surface 注册无状态 `before_provider_request -> disableInvalidBudgetThinking`；它不依赖父级 Workflow/Goal 所有权。

#### CF-03 fork 首请求丢失继承剪枝身份（live/high）

- **结论**：Pi fork 复制所选分支和 custom prune entry，但创建新 sessionId；Flow 没把 `reason=fork` 传给 guard，`loadPersistedPrunes()` 因父 sessionId 不匹配直接返回空 map，连安全降级水合都没有机会执行。
- **A 侧证据**：`packages/pi-maestro-flow/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1077-1105`；`packages/pi-maestro-flow/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js:217-226`。
- **B 侧证据**：`packages/pi-maestro-flow/src/extension/index.ts:1619-1627`；`packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1474-1489`；`packages/pi-maestro-flow/src/compaction/tool-result-spill.ts:75-93`。
- **minimal_fix**：`onSessionStart(ctx,event)` 接收 reason。fork 时在首次 context hook 前把继承项至少转换为 plain prune；若父 spill digest 验证通过则复制到 child namespace、重写 sessionId/locator 并持久化 child-owned manifest。

#### CF-04 callId 不是持久 transcript identity（live/high）

- **结论**：录制、水合、replay 和 spill 文件名都只以 callId 为键；唯一性检查只覆盖一个最终 tool batch。跨轮或跨分支复用 ID 时，新小结果会被旧 placeholder 替换。
- **A 侧证据**：`packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1259-1280,1347-1393`。
- **B 侧证据**：`packages/pi-maestro-flow/src/compaction/tool-result-spill.ts:20-25`；批内检查仅在 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1587-1591`。
- **minimal_fix**：manifest v4 使用稳定 session-entry ID，或至少 `callId + contentDigest`；replay 前校验 digest，spill locator 同时包含 digest，不匹配时当作全新结果。

#### CF-05 可逆会话切换破坏 parked spill（live/high）

- **结论**：`/teammate-session` 和普通 A/B/A 切换是临时 session replacement，但 guard 在看到不同 sessionId 时 fire-and-forget 删除前一 root；这与 shutdown 明确保留资源以便 resume 的语义冲突。
- **A 侧证据**：`packages/pi-maestro-teammate/src/extension/teammate-core.ts:738`；`packages/pi-maestro-teammate/src/extension/index.ts:2945-2979`。
- **B 侧证据**：`packages/pi-maestro-flow/src/compaction/auto-compaction.ts:894-900,1118-1127`；`packages/pi-maestro-flow/src/compaction/tool-result-spill.ts:147-163`。
- **minimal_fix**：session switch 不做破坏性清理；只在显式删除或 TTL GC 时回收。若保留异步清理，必须用不可变 owner/epoch 标识并在 transform 生命周期内 await，避免 A->B->A 的 ABA 删除。

#### CF-06 同 sessionId 多 owner 没有单写者/epoch 所有权（risk/high）

- **结论**：两个 guard 实例共享 `sessionId/callId` 目录，一方 `onCompact()` 可让另一方仍广告 dead path；真实多进程还叠加整快照 last-writer-wins。单进程双实例子机制已复现，多进程部署前提未在本轮建立，因此总体保留 `risk/high`。
- **A 侧证据**：`packages/pi-maestro-flow/src/compaction/tool-result-spill.ts:20-25,147-160`。
- **B 侧证据**：`packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1092-1109,1455-1480`；live replay `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1259-1285` 不再次验证 path。
- **minimal_fix**：最小方案是 per-session 单写者 lease；多写者方案需 `writerId + epoch` namespace、owner-scoped cleanup、revision/CAS manifest merge，并在外部 lifecycle 事件后重验 live spill。

#### CF-07 cache veto 反向触发 full compaction（live/high）

- **结论**：gate 拒绝候选后 `derivePressureBand()` 仍可返回 auto-prune，`decideContextAction()` 仍给 `action=prune`；runtime 在距离 hard threshold 3% 内排队 full compaction。于是为保 cache 拒绝局部改写，却执行更大范围 compact。
- **A 侧证据**：`packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1766-1807`；`packages/pi-maestro-flow/src/compaction/pressure-telemetry.ts:230-243`。
- **B 侧证据**：`packages/pi-maestro-flow/src/compaction/auto-compaction.ts:539-584`；`packages/pi-maestro-flow/src/extension/index.ts:1884-1886`。
- **minimal_fix**：prune planner 返回显式 `cacheVeto/candidateSavings`。若下一步是 full compaction，先绕过 gate 应用被否决的局部计划；若未变更且不需 fallback，则输出 `action=none, reason=cache-veto`。

#### CF-08 hard settings 方言分裂（live/high）

- **结论**：Maestro 优先读并保存 `compaction.hard.reserveTokens/keepRecentTokens`，迁移时删除 top-level 字段；Pi 0.82.1 的 `SettingsManager` 仍只读 top-level。Pi 先确定 preparation cut point，Maestro 再用另一份设置投影和选模型，形成 torn snapshot。
- **A 侧证据**：`packages/pi-maestro-flow/src/compaction/compaction-settings.ts:138-143,406-471`。
- **B 侧证据**：`packages/pi-maestro-flow/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js:520-530`；`packages/pi-maestro-flow/src/compaction/maestro-compaction.ts:638-647`。
- **minimal_fix**：短期保存时同时保留 Pi-compatible top-level 字段；长期由 adapter/Pi 统一读取 `compaction.hard`，并把同一个 effective settings/model revision 随 arbiter lease 传入 preparation、projection 和 summary。

#### CF-09 修正后的 pressure estimate 在 intent handoff 丢失（live/high）

- **结论**：replacement `tokenDelta` 已正确更新 `pressure.estimatedTokens`；但创建 deferred intent 时重新调用 `estimateContextTokens()`，它锚定最近 assistant usage，无法看到该 usage 之前的 replacement，导致同轮出现低于阈值的 AUTO-PRUNE 与高于窗口的 COMPACT 两套数字。
- **A 侧证据**：`packages/pi-maestro-flow/src/compaction/pressure-telemetry.ts:136-168`；`packages/pi-maestro-flow/src/compaction/auto-compaction.ts:521-537,1245-1256`。
- **B 侧证据**：`packages/pi-maestro-flow/src/compaction/auto-compaction.ts:553-584,612-780,1563-1577`。
- **minimal_fix**：intent 直接携带 corrected pressure estimate；以 `pressure.estimatedTokens` 为 tokens，并重算 `usageTokens=max(0,tokens-trailingTokens)`。trigger/status/abort/instructions 全部使用同一对象。

#### CF-10 output-limit capture 忽略 linked summary window（live/high）

- **结论**：main policy 会取 session model 与 configured summary model 的更早阈值；output-limit capture 却只对 active session 调 `deriveCompactionThreshold()` 并比较 usage 百分比。100K session + 50K summary 在 50K usage 已越过 linked 45K，却因低于 session-only 80% gate 丢弃 intent。
- **A 侧证据**：`packages/pi-maestro-flow/src/compaction/auto-compaction.ts:363-384,446-495`；`packages/pi-maestro-flow/src/compaction/compaction-threshold.ts:217-240`。
- **B 侧证据**：`packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1028-1052`；settlement 到 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:800-839` 才看 linked threshold。
- **minimal_fix**：`onOutputLimit()` 先调用 `linkedThresholdFor()`，按绝对 token 与 linked soft/hard threshold 比较；intent 保存 threshold signature，并在 settlement 复核 model/settings revision。

#### CF-11 Pi native summary fallback 复活 K2（live/high）

- **结论**：Maestro summary 返回 undefined/容量失败后，Pi 直接用 `agent.streamFunction` 运行 native summarizer，并携带 session thinking level；该 standalone request 没有 Agent loop 的 `onPayload`。极限容量下 thinking budget 被压到 0，Anthropic builder 再用 `||1024` 复活，形成非法 payload。
- **A 侧证据**：`packages/pi-maestro-flow/src/compaction/maestro-compaction.ts:417-449`；`packages/pi-maestro-flow/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1421-1428,1655-1662`；`packages/pi-maestro-flow/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:426-485`。
- **B 侧证据**：guard 仅由 `packages/pi-maestro-flow/src/extension/index.ts:1852-1853` 接入普通 Agent；`packages/pi-maestro-flow/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:627-633,770-775` 使用 falsy fallback。
- **minimal_fix**：host stream wrapper 对所有 provider 调用统一执行 extension `before_provider_request/onPayload` 链，包括 compaction 与 branch summary；摘要侧再做 defense-in-depth，无法满足 budget 不变量时禁用 budget thinking。

#### CF-12 arbiter owner 与 host fallback 生命周期错位（live/high）

- **结论**：`runObservedCompaction()` 在 extension handler throw 时释放 native owner，但 Pi ExtensionRunner 吞掉异常后仍继续 fallback，于是 fallback 无 owner；若 handler 返回 undefined，owner 保持，但 fallback 失败只发 Pi 内部 `compaction_end`，不发 `session_compact` 或 extension cancellation，owner 卡到 5 分钟 timeout。
- **A 侧证据**：`packages/pi-maestro-flow/src/compaction/compaction-arbiter.ts:92-146,168-177`。
- **B 侧证据**：`packages/pi-maestro-flow/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:569-598`；`packages/pi-maestro-flow/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1421-1481,1655-1729`；当前取消回调只在 `packages/pi-maestro-flow/src/hooks/pi-adapter.ts:444-451`。
- **minimal_fix**：owner 绑定 host compaction operation ID，而不是 `session_before_compact` handler 调用。Pi 应发统一 finalized 事件 `{success,cancel,error}`；本地替代是把 guarded fallback 收进 Maestro handler 并用单一 finally 关闭事务。

### Medium

#### CF-13 child 没有 output-limit 捕获/结算（live/medium）

- **双侧证据**：launcher/继承侧 `packages/pi-maestro-teammate/src/runs/execution.ts:500-511`、`packages/pi-maestro-teammate/src/runs/execution-infra.ts:1249-1266`；surface/guard 侧 `packages/pi-maestro-flow/src/extension/index.ts:490-493,1843-1886,2008-2072`。
- **minimal_fix**：抽取 child-owned session-local guard，注册 context、output-limit、settled、compact 生命周期；没有 recovery 能力时必须把截断状态显式返回父进程，不能静默交付 partial result。

#### CF-14 cache gate 没有评估最终 spill bytes（live/medium）

- **双侧证据**：gate 侧 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1720-1807`；spill/commit 侧 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:516-543,1917-1967` 与 `packages/pi-maestro-flow/src/compaction/tool-result-spill.ts:131-144`。
- **minimal_fix**：在 gate 前生成但不发布最终 spill replacement，按最终 savedTokens 评分；或 upgrade 后重跑 gate，并在 persist/response 前回滚被拒项。

#### CF-15 replayable 与 bulk 两 pass 重复计后缀成本（live/medium）

- **双侧证据**：共享 suffix snapshot 位于 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1225-1240`；每次 `cacheWorthwhileDepth()` 从 cumulative=0 开始，见 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1766-1778,1807`。
- **minimal_fix**：第一 pass 向第二 pass 传递累计 savedTokens 与 earliest invalidated index；按合并收益/单一最早后缀成本决策。

#### CF-16 临时/失败路径被确认为 durable reference（live/medium）

- **双侧证据**：spill replacement 邀请模型读取 tmp path，见 `packages/pi-maestro-flow/src/compaction/tool-result-spill.ts:131-143`；Pi 的 `extractFileOpsFromMessage()` 只看 toolCall args，不看 toolResult `isError`，见 `packages/pi-maestro-flow/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js:15-43`。Maestro 在 `packages/pi-maestro-flow/src/compaction/maestro-compaction.ts:479-484,543-555` 无条件标 active，而 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1092` 删除 root。
- **minimal_fix**：从成功的 toolCall/toolResult pair 推导 reference；排除失败 read/write；current 与 inherited lineage 都过滤 session spill-root path，并把 summary prose 中的 tmp reload 指令改成 expired-resource 标记。

#### CF-17 cleanup 与下一 epoch 写入无屏障（risk/medium）

- **双侧证据**：cleanup/续接侧 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1092,1110-1112`；写入侧 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1917-1967` 与 `packages/pi-maestro-flow/src/compaction/tool-result-spill.ts:45-65,147-163`。
- **minimal_fix**：使用 generation-specific spill 目录，或维护 per-session cleanup promise 并在写入/续接前 await；stale spill 完成后精确删除其创建的文件。

#### CF-18 session switch 清除 deferred intent（live/medium）

- **双侧证据**：生命周期侧 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:392-417,894-905,1118-1127`；结算/重建侧 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:469-473,990-1020,1580-1591`。
- **minimal_fix**：pending intent 按 sessionId/threshold signature 停放与恢复，或持久化最小 intent；切换不应调用等价于永久 reset 的全量 `releaseInFlight()`。

#### CF-19 fork attach 泄漏 root Todo active skill（live/medium）

- **双侧证据**：Todo 不按 sessionId 作用域恢复，见 `packages/pi-maestro-flow/src/tools/todo-serialization.ts:47-55`；恢复的 active skill 在 `packages/pi-maestro-flow/src/tools/todo.ts:433-452` 注入 context，随后进入 `packages/pi-maestro-flow/src/extension/index.ts:1843-1847` 的 pressure policy。
- **minimal_fix**：仅在“teammate attach 到 fork child”的明确边界追加空 `todo-state v5` tombstone；不要把普通 fork 的 Todo 全局改成 session-scoped。

#### CF-20 绝对 tmp locator 不可移植（live/medium）

- **双侧证据**：存储/展示侧 `packages/pi-maestro-flow/src/compaction/tool-result-spill.ts:20-25,131-143`；恢复侧要求当前 tmp root containment，见 `packages/pi-maestro-flow/src/compaction/tool-result-spill.ts:75-93`，manifest 原样保存 path 于 `auto-compaction.ts:1293,1466`。
- **minimal_fix**：持久化 logical locator + content digest；同机由 session storage root 解析，承诺跨 host 恢复时改用 durable store。

#### CF-21 32 位路径摘要发生碰撞（risk/medium）

- **双侧证据**：`packages/pi-maestro-flow/src/compaction/tool-result-spill.ts:179-191` 只保留 SHA-1 前 8 hex；`packages/pi-maestro-flow/src/compaction/tool-result-spill.ts:106-112` 的完整内容比较会让第二个不同 payload fail closed，但无法消除拒绝 spill 和共享 cleanup root。
- **minimal_fix**：改用至少 128 位、优先全量 SHA-256；更新错误的 injective 注释，并固定碰撞对 `same-prefix-123455544` / `same-prefix-1234531793` 为回归样例。

#### CF-22 cacheDelta 被 normal batch 静默消费（live/medium）

- **双侧证据**：归因在 `packages/pi-maestro-flow/src/compaction/pressure-telemetry.ts:388-408` 生成；`updatePressureStatus()` 在 normal 早退，而 caller 在 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:539-542` 无条件清空。
- **minimal_fix**：`updatePressureStatus()` 返回是否实际渲染，只有 true 才清 `cacheDelta`；更稳妥的是写独立 epoch telemetry sink，不依赖 pressure UI。

#### CF-23 “缓存未报告”被当成真实 0%（risk/medium）

- **双侧证据**：Flow 在 `packages/pi-maestro-flow/src/compaction/pressure-telemetry.ts:256-267` 直接算 ratio；Pi 在 `packages/pi-maestro-flow/node_modules/@earendil-works/pi-coding-agent/dist/core/cache-stats.js:17-39` 保持 `reportedCache`、provider/model 与实际费率语义。gate 本身在 `packages/pi-maestro-flow/src/compaction/auto-compaction.ts:1720-1807` provider-agnostic。
- **minimal_fix**：planner 接收 normalized cache economics：capability/history、provider/model、真实 input/read/write rate；从未报告前保持 undefined，模型切换单独标记。

#### CF-24 相同 summary 文本绑定旧 compaction entry（live/medium）

- **双侧证据**：Pi append 后丢弃返回 ID，并用 `newEntries.find(summary)`，见 `packages/pi-maestro-flow/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1433-1439,1674-1680`；Flow 在 `packages/pi-maestro-flow/src/extension/index.ts:1805-1813` 转发并由 `packages/pi-maestro-flow/src/compaction/maestro-compaction.ts:491-508` 信任 event entry。
- **minimal_fix**：Pi 保留 `appendCompaction()` 返回 ID，并按 ID 解析刚追加 entry；Flow 防御性检查 event entry 是否为当前 branch 最新 compaction。

#### CF-25 禁用设置没有取消旧 intent（live/medium）

- **双侧证据**：设置刷新位于 `packages/pi-maestro-flow/src/extension/index.ts:1831-1834`，disabled branch `auto-compaction.ts:448-454` 不清 retained intent；intent 捕获旧 settings 并在 `auto-compaction.ts:612-780,990-1020` 不复核当前配置。
- **minimal_fix**：settings/model/threshold signature 改变即使 intent generation 失效；disabled/unusable 分支显式清 intent，提交前重新读取 effective settings 与 linked threshold。

#### CF-26 linked threshold 与 summary fit 的 headroom 不同（live/medium）

- **双侧证据**：threshold 使用 `MIN_RESERVE_RATIO=0.05` 与 `summaryOutputTokenLimit(0.8*reserve)`，见 `packages/pi-maestro-flow/src/compaction/compaction-threshold.ts:10-53,217-240`；真正 fit 另减 4096 并要求至少 1024，见 `maestro-compaction.ts:40-78`。
- **minimal_fix**：建立单一 `SummaryBudgetModel`，供设置校验、linked threshold、UI、arbiter trigger 和 final fit 共用；最终 fit 保留 fail-closed 校验。

### Low / Future Risk

| ID | 双侧证据 | minimal_fix |
|---|---|---|
| CF-27 | `maestro-compaction.ts:176,684` 直接 `complete()`；普通 Agent guard 在 `extension/index.ts:1852-1853`。当前 summary 不启用 reasoning。 | 给自定义 summary options 注入同一 `onPayload` guard，尤其在未来启用 reasoning 前。 |
| CF-28 | resolver 在 `maestro-compaction.ts:707-754` 命中缓存即返回；threshold 在 `auto-compaction.ts:363-384` 先信任它，completion 到 `maestro-compaction.ts:666-681` 才复核 auth。 | registry lookup 可缓存，auth 每个 threshold epoch 复核，或按 credential/model-registry revision 建 key。 |
| CF-29 | 常量在 `compaction-threshold.ts:25-30` 导出；escalation 在 `auto-compaction.ts:548-554` 再写裸 `0.03`。 | 若语义相同则直接 import；若不同则分别命名，并添加边界契约测试。 |
| CF-30 | lifecycle cleanup 在 `auto-compaction.ts:894-900,1092` 不走 transform tail；spill await 后的 generation fence 在 `auto-compaction.ts:517-520,1944-1967` 只阻止发布。 | stale write 完成后精确删除自己的资源，或把 destructive cleanup 串到同一 transform/epoch 队列。 |

## 4. 已知问题 K1-K5 当前状态

| Known issue | 当前结论 | 证据与限定 |
|---|---|---|
| K1 | **fixed（当前集成路径）** | native `/swarm` controller 已移除，`packages/pi-maestro-flow/src/tools/swarm.ts:13-30` 仅提供 status/inspect；权限解析同时接受 `file_path/path`，见 `src/permissions/policy.ts:236-239`。Pi 的 `sendUserMessage` 不展开 skill template 仍是平台约束，但当前路径不再调用它。 |
| K2 | **系统级仍 live；root ordinary Agent fixed** | root final payload guard 在 `auto-compaction.ts:195-224` + `extension/index.ts:1852-1853`，测试覆盖边界；child 为 CF-02 `risk/high`，Pi native fallback 为 CF-11 `live/high`。因此不能再把 K2 总体标为 fixed。 |
| K3 | **fixed** | `onCompact()` 清 manifest 后立即持久化空 tombstone，见 `auto-compaction.ts:1093-1109`；`test/compaction.test.ts:3791-3847` 覆盖 resume。fork/session ownership 是新问题，不是 K3 回归。 |
| K4 | **fixed（原问题）** | `extension/index.ts:1792-1795` 在 custom/default summarizer 前调用 `commitProjectedCompactionInput()`；`test/compaction.test.ts:3669-3674` 验证 fallback preparation 接收投影。它不等于 provider guard，因此 CF-11 仍成立。 |
| K5 | **fixed/refuted（共享根因假设）** | `claude_model_required` 仍属于独立远端模型路由问题；15 条路径均未给出它与 compaction cooperation 的可信边。配置中的 K5 结论维持不变。 |

## 5. 已确认无缺口的负向证据

1. **root output-limit/native handoff 已闭环**：`auto-compaction.ts:1079-1109` 在清状态前保存是否需要 continuation；`extension/index.ts:1805-1809` 先读取 owner 再 `complete()`。现有测试覆盖 yield 与 native completion continuation。
2. **evaluate 与 projectCompactionInput 相互串行**：共享 transform tail 位于 `auto-compaction.ts:339-349`，两入口在 `:912-979` 走同一锁，并在 awaited spill 后检查 generation；`test/compaction.test.ts:1224-1261` 覆盖并发 evaluate。
3. **K3 空 tombstone 顺序正确**：compact 后空 manifest 会落盘，不会因 close 发生在下一次 evaluate 前而恢复旧 prune。
4. **K4 投影不会被 Pi fallback 复活为 raw messages**：`commitProjectedCompactionInput()` 修改 Pi 原 preparation；投影本身操作副本，测试确认原 branch messages 不被原地改写。
5. **prune custom-entry 与 compaction entry 的 branch 顺序无直接冲突**：project 阶段 append 的 manifest 成为随后 compaction entry 的 parent；`session_compact` 再追加空 tombstone，`loadPersistedPrunes()` 取最新 matching custom entry。
6. **Plan/Todo end hook 没有 Goal 的确定性排队问题**：`plan.ts:391-403` 只保存 proposed plan draft；`todo.ts:462-463` 只清临时 injection anchor。两者在 production `agent_end` 不发送续接消息。
7. **statusline/overlay 对 runtime compaction state 是只读的**：`statusline/statusline.ts:495-503` 只从 FooterData 读取 `maestro-auto-compact*` 并渲染，没有 guard/intent/manifest 引用。
8. **32 位碰撞目前不会串读错误字节**：`tool-result-spill.ts:106-112` 对 EEXIST 做完整内容比较，确认碰撞会 fail closed。剩余缺口是可用性、命名与 cleanup ownership，不是 wrong-byte disclosure。
9. **cacheHitRatio 本身不直接驱动 action**：`pressure-telemetry.ts:218-243` 只把它加入 reasons；live 问题来自独立 cache gate 与 escalation 的组合，不应把根因误写成“ratio 直接触发 prune”。

## 6. 修复优先级建议

### P0

1. **统一所有 provider 请求的最终 payload choke point**：先修 CF-11，并同时把无状态 guard 接到 child（CF-02）和 direct checkpoint completion（CF-27）。这是 recovery 路径上的确定性 provider 400。
2. **把 compaction/continuation 做成 operation-scoped transaction**：合并 CF-01 与 CF-12；host 明确发 success/cancel/error finalization，Goal marker 与 arbiter owner 一起 commit/rollback。
3. **统一 settings、linked threshold 与 summary budget snapshot**：合并 CF-08、CF-10、CF-25、CF-26；一个 revision 驱动 trigger、cut point、projection、model 和 output budget。
4. **修复 session/transcript identity**：CF-03、CF-04、CF-05、CF-06 一起设计。只改 fork 或只加 cleanup await 都会留下 callId、多 writer 或 reversible switch 缺口。
5. **修复 pressure handoff 与 cache-veto fallback**：CF-09 先保证同一 token estimate；CF-07 让 cache veto 在 full compact 前可被局部 prune 覆盖。

### P1

1. 抽取完整 child-owned session-local compaction surface（CF-13），但继续 fence 父级 Workflow/Goal/Plan/Todo。
2. 让 cache economics 基于最终 bytes 并跨 pass 累积（CF-14、CF-15），再修 cacheDelta 消费（CF-22）与 capability normalization（CF-23）。
3. 重做 spill resource lifecycle：epoch directory、logical locator、cleanup barrier（CF-17、CF-20、CF-30）。
4. checkpoint reference outcome-aware 且过滤 ephemeral spill；同时按 entry ID 绑定 session_compact（CF-16、CF-24）。
5. teammate attach 明确隔离 root Todo hydration（CF-19），pending intent 按 session 停放（CF-18）。

### P2

1. 扩展 spill digest 至至少 128 位并固定碰撞回归（CF-21）。
2. 给 configured-model cache 加 credential/model revision（CF-28）。
3. 去除 `0.03` 常量漂移（CF-29）。
4. 在启用 checkpoint reasoning 前完成 direct completion guard（CF-27；若 P0 已统一 choke point，则自然关闭）。

## 7. 测试覆盖缺口与建议回归

| 优先级 | 建议测试 | 覆盖发现 | 核心断言 |
|---|---|---|---|
| P0 | Maestro error -> Pi native fallback -> payload capture | CF-11 | `max_tokens <= 1024` 时 thinking disabled；fallback 仍可完成或正确报错。 |
| P0 | handler `{throw,undefined}` × fallback `{success,fail}` | CF-12 | operation 期间无第二 lease；四个终态都立即释放 owner。 |
| P0 | active Goal + length stop 的 success/error/cancel 矩阵 | CF-01 | 只保留一个有效 marker/续接；无静默吞消息、无重复 continuation。 |
| P0 | child extension provider/output-limit harness | CF-02、CF-13 | child 有 budget guard 和本地 compact-and-continue；仍无父级 Goal/Workflow 所有权。 |
| P0 | fork 含 prune + spill，首次 child user frame | CF-03 | 新 sessionId 下先翻译 manifest；不透传原始大输出，copy 失败安全降级。 |
| P0 | 两轮相同 callId、不同 payload，含 resume/fork | CF-04 | digest/entry identity 不匹配时不 replay 旧 replacement。 |
| P0 | root -> teammate child -> root，根持有 live spill/intent | CF-05、CF-18 | spill 和 intent 都可恢复；切换不产生 destructive cleanup。 |
| P0 | 双 owner 同 sessionId 并发写/compact | CF-06 | owner-scoped cleanup；manifest CAS/merge 不丢另一 writer。 |
| P0 | gate-on/off 穿过两次 settled | CF-07 | gate veto 不再造成 `0 prune/1 compact`；full compact 前先尝试局部计划。 |
| P0 | replacement corrected estimate handoff | CF-09 | UI、trigger、abort 和 intent 使用同一 token 数；首 settled 不误 compact。 |
| P0 | 100K session + 50K summary + length stop at 50K | CF-10 | 按 linked absolute threshold 捕获并结算 output-limit intent。 |
| P0 | settings UI save -> Pi reload -> prepare/summary | CF-08、CF-26 | hard=9000/7000 贯穿 cut point、projection、summary fit；threshold+1 可实际 fit。 |
| P1 | plain ratio >0.25，spill final ratio <0.25 | CF-14 | 最终 spill replacement 被重新 gate，uneconomic manifest 不落盘。 |
| P1 | mixed replayable+bulk combined payoff | CF-15 | 单 pass 不够但合并够阈值时两类都被接受。 |
| P1 | spill reload -> failed read -> compact -> knowhow | CF-16 | failed/ephemeral path 不进入 active reference 或 summary reload 指令。 |
| P1 | delayed cleanup/write 与 A->B->A 调度 | CF-17、CF-30 | 不删新 epoch 文件，不留下 ownerless orphan，不广告 dead path。 |
| P1 | fork attach 含 active skilled root Todo | CF-19 | child 不注入 `todo-active-skill`，也不因父任务触发压缩。 |
| P1 | prune -> final text -> normal tool batch -> pressure batch | CF-22 | `cacheDelta` 穿过 normal frame，直到实际发布后才清。 |
| P1 | no-cache provider / first cache epoch / model switch | CF-23 | unknown 不显示成真实 0%；切模 delta 不归因给 prune。 |
| P1 | 两次相同 summary、不同 checkpoint ID | CF-24 | 第二次 `session_compact` 和 knowhow 精确绑定第二个 entry。 |
| P1 | retained intent 后 `enabled=false`/model change | CF-25 | stale intent 被 generation/signature 拒绝，不再提交 compact。 |
| P2 | TMPDIR/host locator restore + 32-bit 碰撞对 | CF-20、CF-21 | logical locator 可解析或明确降级；碰撞对生成不同路径。 |
| P2 | auth success -> cache -> revoke -> resolve | CF-28 | threshold resolver 复核 auth/revision，不继续使用过期模型。 |

现有测试的主要盲点是“单模块行为有覆盖、跨 hook 组合没有覆盖”。例如当前 child harness 明确断言 `agent_end` 缺席；cache gate 测试止于 `prunedToolResults=0`；output-limit 与 linked threshold 分开测试；payload guard 与 native summary budgeting分开测试。新增测试应优先放在 extension/host integration 层，而不是继续增加孤立 helper 单测。

## Convergence Story（收敛过程）

- **Iteration 1**：entropy `5.8471437971`，`tau_max=3.75`，`tau_mean=1.04318`。`ANT-1-3` 首次得到全局 best `1.000`；高浓度边开始落在 `extension-wiring <-> nested-session`、`budget-guard <-> nested-session` 和 `deferred-intent <-> extension-wiring`。
- **Iteration 2**：entropy `5.6832024757`，`tau_max=6.0`，`tau_mean=1.03341`。没有改善全局 best；搜索集中于 nested session/fork/spill ownership。该轮 4 个 artifact 标注为 coordinator 基于 explorer 证据综合，独立 ant 多样性低于表面上的 5。
- **Iteration 3**：entropy `5.5921065953`，`tau_max=6.6`，`tau_mean=1.07218`。`ANT-3-3` 从 telemetry 路径追平 `1.000`，`ANT-3-1=0.975`；搜索没有只困在 child 路径，还发现了新的高价值簇。

从第 1 轮到第 3 轮，entropy 仅下降约 `4.36%`，66 条边仍全部活动；最大信息素却从 `3.75` 增到 `6.6`，其中 `extension-wiring <-> nested-session` 最强。结论是局部主题已集中，但搜索空间没有塌缩到单一最优。全局 best 连续两个后续 iteration 没有提升，满足 stagnation `patience=2, min_delta=0.02`；同时报告显示已跑满 `max_iterations=3`。`swarm-report.json` 没有最终 trigger 字段，因此只能确认两项条件在结束时都成立，不能断言 coordinator 先采用哪一个。

## Caveats（限制）

- verified score 来自结构化评分脚本，重点衡量 file:line、跨流双侧、triage、known issue、minimal fix 等报告纪律，不是影响概率或业务损失的校准分数。
- `ANT-1-3` 与 `ANT-3-3` 同分；best.json 选择前者不构成唯一最优证明。
- iteration 2 的 `ANT-2-1/2-2/2-4/2-5` 是 coordinator 综合产物，不是四次完全独立执行；其确定性结论主要由第 3 轮重新验证补强。
- `risk` 项区分了“静态接线/并发前提明确”与“本轮未在真实 child/多进程环境复现”；不应在修复说明中擅自改写为 `live`。
- 本报告核对了当前工作树中的引用锚点，但没有重新运行每个 ant 的所有临时 probe；数值复现取自相应 artifact 的 verification 字段。
- 配置未记录 random seed，因此无法按随机选择序列逐步重放；config、trail、pheromone history 和 15 个 artifact 足以重放已发生的路径与评分。

## Reproducibility（复现材料）

- 配置：`work/team/swarm-config.json`
- 任务图：`work/team/task-space.json`
- 最佳路径：`work/team/best.json`
- 完整报告：`outputs/swarm-report.json`
- Trail：`work/team/trails/1.jsonl`、`2.jsonl`、`3.jsonl`
- Ant 证据：`outputs/ant-1-1.json` 至 `outputs/ant-3-5.json`
- 信息素历史：`work/team/pheromone/history/1.json` 至 `3.json`
- 评分规则：`work/team/compaction-coop-scoring.py`
- Random seed：**未记录**
- 本综合验证方法：`cross_ref_with_best.json + all_trails + all_ant_artifacts + source_anchor_readback`
