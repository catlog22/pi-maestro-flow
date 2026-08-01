---
kind: best-solution
---

# Swarm Result — Vision 多模态策略缺口审查

## Best Solution

**Path**: observability → failover-circuit → delegation-runtime → attached-image-path  
**Verified Score**: 0.85  
**Iteration**: 2 of 3  
**Ant**: ANT-2-1

### Summary

ANT-2-1 把问题识别为一条运行时失效链：Vision 委托没有结构化可观测性；`callCandidates` 又绕开共享断路器，导致失效模型在每次调用中重新重试；同一条委托路径还被附件自动分析复用，但附件处理既不可取消，也缺少成功率、延迟和模型选择记录。这个路径没有覆盖所有配置和协议面，却最清楚地揭示了多个缺口如何叠加成“重复阻塞且无法诊断”的用户故障。

### Consolidated Gaps

下表从 15 个 ant 的 67 条原始 finding 中合并高频、交叉验证后的独立缺口；严重度和状态沿用相关 ant 产物中的主结论。原始产物没有 `fixed` finding。

| # | Gap | Severity | Status | Evidence | Actionable fix |
|---|-----|----------|--------|----------|----------------|
| 1 | Vision 委托绕开共享断路器：`callCandidates` 只有单次调用内重试，没有 `acquireCandidate`、`recordSuccess` 或 `recordRetryableFailure` | high | live | `packages/pi-maestro-flow/src/providers/vision-assist.ts:511-549`; 对照主链集成 `packages/pi-maestro-flow/src/providers/model-failover.ts:210-240` | 将共享断路器注入 Vision 候选循环；尝试前 acquire，成功后 recordSuccess，仅对可重试 provider 错误 recordRetryableFailure，非 provider 的 MIME/尺寸错误不得污染模型健康状态。 |
| 2 | Vision 可观测性为零，断路器状态转换也不可订阅：只有最终异常或 `ctx.ui.notify`，没有逐模型 attempt、latency、cache、result、transition 指标 | high | live | `packages/pi-maestro-flow/src/providers/vision-assist.ts:1-14,490-549`; `packages/pi-maestro-teammate/src/models/model-circuit-breaker.ts:119-168` | 定义统一事件接口并覆盖 delegation start/attempt/result、cache hit/miss、model switch、breaker transition；输出计数器和延迟直方图，并携带 session/turn correlation id。 |
| 3 | capability 判定和 API Manager 默认语义不一致：配置读取缺少 `input` 时默认 multimodal=true，保存路径默认 `text+image`，注册路径默认 `text`，运行时则保守判 false | medium | live | `packages/pi-maestro-flow/src/providers/api-provider-config.ts:331`; `packages/pi-maestro-flow/src/providers/api-provider-ops.ts:395-402,651-654`; `packages/pi-maestro-flow/src/providers/vision-assist.ts:110-112` | 统一为显式 capability/unknown 三态；缺字段按 unknown 或保守 false 处理，在 API Manager 保存前校验并提示迁移，禁止不同路径各自补默认值。 |
| 4 | capability 只信任静态 `model.input`，实际 Vision 调用失败不会反馈到能力目录或后续路由 | medium | live | `packages/pi-maestro-flow/src/providers/vision-assist.ts:110-112,524-545` | 在声明能力之外记录真实调用健康度；将反复出现的“不支持图片”错误降级为 capability mismatch，并在目录刷新或首次使用探测时纠正。 |
| 5 | Teammate 模型目录没有 `input`/multimodal 字段，签名与系统提示也不暴露 Vision 能力 | medium | live | `packages/pi-maestro-teammate/src/models/model-catalog.ts:7-25,56-81` | 扩展 `AvailableModelEntry`/`TeammateModelCapability`，将 modalities 纳入 signature，并在模型目录提示中输出稳定的 `[vision]` capability 标签。 |
| 6 | MCP sampling 将 user/assistant 的所有非文本内容块直接抛错，模型选择也不按图片能力过滤 | high | live | `packages/pi-maestro-flow/src/mcp/sampling-handler.ts:120-161,181-214` | 支持 MCP image block 到内部 `ImageContent` 的无损转换；检测到图片时只选择多模态候选，若没有候选则返回明确 capability 错误或调用 Vision 委托。 |
| 7 | 附件自动分析被 `model-failover.enabled` 提前返回门控；该开关默认关闭时，Vision delegation 即使开启也不会自动处理附件 | high | live | `packages/pi-maestro-flow/src/providers/model-failover.ts:252-264` | 把附件检测/分析从 model failover handler 解耦，改由 `vision-delegation.enabled` 管理；failover 只负责候选模型切换和健康状态。 |
| 8 | 附件顺序分析没有传递 `AbortSignal`；默认 30 秒 timeout × 3 attempts 已可超过 90 秒/候选/图片，多个图片或候选继续线性放大 | high | live | `packages/pi-maestro-flow/src/providers/model-failover.ts:276-287`; 信号接口 `packages/pi-maestro-flow/src/providers/vision-assist.ts:191-203,511-545` | 从 turn/session 生命周期取得 signal 并传入每次 `visionAnalyzer`，循环间检查取消；增加整批预算和图片数量上限，取消时停止后续候选与图片。 |
| 9 | 附件触发 `pi.setModel` 切换到多模态模型后不会恢复原模型，后续无图片 turn 仍承受不同成本与行为 | high | live | `packages/pi-maestro-flow/src/providers/model-failover.ts:210-240,264-272,368-375` | 在 `ActiveModelRun` 记录 original model 与 `imageTriggered`，在该 turn settle 后恢复；优先采用单 turn model override，避免修改 session 全局选择。 |
| 10 | `attachedCaches` 是模块级 `Map`，但 shutdown 只清理工具私有 cache；跨 session 残留并且附件/工具两条路径形成双 cache | medium | live | `packages/pi-maestro-flow/src/providers/vision-assist.ts:108,191-203,206-210,253` | 每个 `agentDir` 只保留一个 lifecycle-owned cache；在 session shutdown 删除对应 Map entry，必要时增加 TTL，并让附件分析与 `describe_image` 复用。 |
| 11 | handler 注册顺序会先给文本模型注入“使用 describe_image”，随后 failover 才切到原生多模态模型，留下 stale/矛盾提示 | medium | live | `packages/pi-maestro-flow/src/providers/model-failover.ts:181-184,252-272`; `packages/pi-maestro-flow/src/providers/vision-assist.ts:244-251` | 先完成 capability-aware model selection，再计算工具可见性和系统提示；将这三个动作合并到显式编排阶段，避免依赖事件监听器注册顺序。 |

### Evidence Chain

- `packages/pi-maestro-flow/src/providers/vision-assist.ts:490-549` — `delegateImage`/`callCandidates` 构成独立的缓存、候选和重试链；源码中没有断路器调用，也没有逐 attempt 的结构化事件。
- `packages/pi-maestro-teammate/src/models/model-circuit-breaker.ts:119-168` — 主断路器确实维护 CLOSED/OPEN/HALF_OPEN 状态，但只提供命令式写入和 `snapshot()` 拉取，没有 transition hook。
- `packages/pi-maestro-flow/src/providers/model-failover.ts:252-318` — 附件检测、模型升级、Vision 分析和断路器选择耦合在同一 handler，并被 failover 开关整体门控。
- `packages/pi-maestro-flow/src/providers/model-failover.ts:276-287` — 附件逐张串行分析，调用参数没有 `signal`，失败后只发 UI warning。
- `packages/pi-maestro-flow/src/providers/api-provider-config.ts:331` 与 `packages/pi-maestro-flow/src/providers/vision-assist.ts:110-112` — 同一缺失 capability 在配置面和运行时被解释成相反默认值。
- `packages/pi-maestro-flow/src/mcp/sampling-handler.ts:203-214` — 非文本 sampling block 被直接拒绝，没有图片 passthrough 或委托回退。
- `packages/pi-maestro-teammate/src/models/model-catalog.ts:7-25,56-81` — 模型 capability 和目录签名仅包含 reasoning/thinking，不包含输入模态。

### Candidate Artifact

获胜产物见 `outputs/ant-2-1.json`。其候选摘要确认四个核心可观测性缺口：Vision 子系统缺少日志/metrics/tracing、断路器转换无事件、`callCandidates` 无逐模型延迟/成功率、附件自动分析无成功/失败/延迟追踪。本报告没有改变该候选的评分，而是用并列 runner-up 和其余 ant 的证据补足配置、目录、MCP 与生命周期面。

## Why This Path Won

| Decision | Pheromone-guided? | Why it mattered |
|----------|-------------------|-----------------|
| start = observability | weighted start | 从“系统能否证明 Vision 正常工作”切入，快速识别不是单点日志遗漏，而是委托、failover、附件三条链都无法量化的系统性盲区。 |
| observability → failover-circuit | evidence, weight 1.0 | 将不可观测问题落到有状态组件：断路器会改变路由，却不发 transition 事件，因此 `/model-health` 的人工快照无法支持告警。 |
| failover-circuit → delegation-runtime | evidence, weight 1.0 | 找到最关键的架构断层：主模型链使用共享 breaker，Vision `callCandidates` 另写无状态重试；重复故障既不会 fast-fail，也不会进入统一健康视图。 |
| delegation-runtime → attached-image-path | evidence, weight 1.0 | 证明断层会进入默认用户路径：附件分析复用 Vision 委托，同时增加串行、不可取消和开关耦合风险，而不只是显式工具调用的边缘问题。 |

三次 path transition 均标记 `deviation_from_hint=false`，所以这不是一次反信息素的偶然发现。需要强调的是，ANT-2-1 与两个 runner-up 的 verified score 同为 0.85；它“赢”是 `best.json` 的最终选择，不存在可声称的分数领先。它的 self score 为 0.82，高于两名并列项的 0.75，并且因果链更完整，但 swarm 产物没有记录正式 tie-break 规则。

## Runner-Up Solutions

| Rank | Ant | Path | Score | Diff from best |
|------|-----|------|-------|----------------|
| 2 (tie) | ANT-2-2 | config-surface → capability-detection → failover-circuit → observability | 0.85 | 0.00；更直接揭示默认值冲突和无状态重试，但未覆盖 MCP、目录与附件生命周期。 |
| 3 (tie) | ANT-2-3 | failover-circuit → capability-detection → model-catalog-exposure → observability | 0.85 | 0.00；补足 teammate 目录能力不可见，但附件运行时证据少于获胜路径。 |

两个 runner-up 并非“较差解”；它们与最佳项共同确认三条稳定结论：断路器旁路、capability 语义不一致、结构化可观测性缺失。差异主要来自路径覆盖面，而不是评分随机波动。

## Convergence Story

Iterations: 3 of 3 max  
Trigger: max_iterations（未达到 target_score=0.90；entropy 也远高于 floor=0.5）

Entropy curve:

- iter 1: 5.347671（广泛探索；本轮最高 0.80）
- iter 2: 5.226069（最佳 ANT-2-1 及两个并列项出现；本轮最高 0.85）
- iter 3: 5.110833（继续缓慢收窄，但本轮最高回落到 0.60）

熵从 5.35 降到 5.11，只下降约 4.4%，说明搜索偏好开始集中但没有形成强共识。最佳项在第 2 轮出现，第 3 轮主要发现附件 cache、取消、模型恢复和 handler 顺序等新问题，没有提高 best score；因此结果更像“有限预算下保留了已知最佳路径”，而非证明已收敛到全局最优。停止原因是达到 3 轮上限，不是 stagnation、目标分或 entropy floor。

## Caveats

- `outputs/swarm-report.json` 在分析时未生成；排名、每轮得分和 top runner-up 从 `work/team/trails/*.jsonl` 重建，熵从 `work/team/pheromone/history/*.json` 读取。
- 67 条是原始 finding 数，不是 67 个独立 bug；跨 ant 存在重复以及严重度/状态分歧，例如 AbortSignal 被分别标成 high 与 low，model catalog 被分别标成 live 与 risk。本表按当前源码是否真实存在行为缺口进行合并，没有重新计算 ant score。
- 所有 15 个产物合计为 17 high、41 medium、9 low；52 live、15 risk、0 fixed。“没有 fixed finding”仅表示本轮没有产出已修复项，不等于仓库历史上没有修复。
- 这是静态源码审查和产物交叉核验，没有执行真实 provider、MCP server 或多图片取消场景；handler 合并语义、切模恢复成本和 provider capability drift 仍需集成测试确认。
- ANT-2-1、ANT-2-2、ANT-2-3 同分，且缺少显式 tie-break 记录；不能把最终 `best.json` 选择解释为统计显著优势。

## Reproducibility

- Objective/config: `work/team/swarm-config.json`
- Best path and verified score: `work/team/best.json`
- Best candidate: `outputs/ant-2-1.json`
- All candidates: `outputs/ant-1-1.json` through `outputs/ant-3-5.json`（3 iterations × 5 ants）
- Full trails: `work/team/trails/1.jsonl`, `2.jsonl`, `3.jsonl`
- Pheromone/entropy snapshots: `work/team/pheromone/history/1.json` through `3.json`
- Scoring mode: script, `scripts/vision-review-scoring-rule.py`; self-score discount 0.5
- ACO: alpha=1.0, beta=2.0, rho=0.2, q=1.0; max path length 4
- Random seed: not recorded in `swarm-config.json`
- Verification: best score cross-referenced with `best.json`; runner-up scores checked against all trail rows; cited source anchors read from the current worktree; all 15 ant JSON artifacts parsed successfully.
