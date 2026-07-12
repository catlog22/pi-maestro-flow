# pi-observational-memory — 架构与设计参考文档

**Artifact**: ANL-002 | **Scope**: standalone/macro | **Target**: pi-observational-memory v3.0.3
**Date**: 2026-07-10 | **Confidence**: high (85%) | **Recommendation**: GO (adopt/reference)

> 本文是 `pi-observational-memory`（Pi 扩展，TypeScript）的设计架构与理念参考文档，供 `pi-maestro-flow` 后续会话级记忆设计借鉴。基于三层代码探索（模块发现→调用链追踪→代码锚点）+ 概念文档 + 与 ANL-001 `pi-ultra-compact` 的对比分析。

---

## 1. Executive Summary

`pi-observational-memory` 解决长 AI 编程会话的上下文衰减问题，核心创新是**把记忆工作前置到 compaction 之前**：会话进行中由三个后台 agent（observer/reflector/dropper）维护一个 append-only 账本（observations + reflections），compaction 时只做确定性折叠+渲染，**不调用模型**。这使 compaction 从"慢的 summarization 事件"变为"快的 render 步骤"。

架构成熟度高，六大支柱均经代码验证。最值得借鉴的模式：**ledger-as-truth + fold-on-read + model-free compaction render**，以及 **coverage-tier（none/partial/strong）作为 pruning safety 的结构信号**。残留风险集中在语义保真度不可机器验证（coverage 是结构代理非语义保证）与长程 coverage 不修复。

**Go/No-Go**: GO — 架构值得参考，模式可移植到 pi-maestro-flow 的会话级记忆层。

---

## 2. 设计理念 (Design Philosophy)

### 2.1 核心问题
长会话经多轮 compaction 后，agent 携带的是"压缩的压缩的压缩"——设计决策、被拒方案、约束、用户澄清逐渐消失。第二个痛点：compaction 本身慢（模型重写过去），恰在最需要连贯性时打断 flow。

### 2.2 理念倒置
传统 compaction 在"危机时刻"（context window 需要释放）调用模型重写过去。本项目把**重要的记忆工作提前**到会话进行时（`turn_end` 由 token-clock 触发），compaction 时记忆已准备好——compaction 退化为投影+渲染。

> "When compaction happens, you should barely notice." — README

### 2.3 六大设计支柱

| # | 支柱 | 一句话 | 代码锚点 |
|---|------|--------|----------|
| 1 | Ledger-as-truth | 分支局部 append-only 账本是唯一真相；记忆状态靠 fold 重建，永不 mutate | `fold.ts:50-100` |
| 2 | 双层记忆 | Observations（时序事件+provenance）+ Reflections（持久事实+support 链） | `types.ts:9-49` |
| 3 | 三 agent 管线 | write→distill→prune；model 提案、code 裁决结构不变量 | `agents/{observer,reflector,dropper}` |
| 4 | 无模型 compaction | `session_before_compact` 仅 fold+render，无模型调用 | `compaction-hook.ts:16-50` |
| 5 | Coverage-stewardship pruning | 确定性 tier（none/partial/strong）指导 drop 优先级 | `coverage.ts:18-42` |
| 6 | Exact-id recall | 12-hex id 反查源证据，非语义搜索 | `recall.ts:172-237` |

---

## 3. 架构总览 (Architecture Overview)

### 3.1 组件地图

```
src/
├── index.ts                  入口：单 Runtime + 3 hooks + 2 commands + 1 tool
├── runtime.ts                共享状态：config 缓存、in-flight flag、model resolver
├── config.ts                 配置 + DEFAULTS + calibrated/ratio 阈值
├── ids.ts                    hashId=sha256(content).slice(0,12)
├── serialize.ts              会话条目→带 [Source entry id:] 标签的文本
├── tokens.ts                 estimateStringTokens=ceil(len/4)
├── model-budget.ts           boundedMaxTokens=min(model.max,32K)
├── hooks/
│   ├── consolidation-trigger.ts   turn_end → token-clock → observer→reflector→dropper
│   ├── compaction-trigger.ts     agent_end → idle 检查 → ctx.compact()
│   └── compaction-hook.ts        session_before_compact → 折叠+渲染（无模型）
├── agents/
│   ├── observer/   {agent.ts, prompts.ts}      捕获 observations
│   ├── reflector/  {agent.ts, prompts.ts}      蒸馏 reflections + 算 coverage
│   └── dropper/    {agent.ts, prompts.ts, coverage.ts, pool.ts}  修剪 active 池
├── session-ledger/
│   ├── types.ts          Observation/Reflection/entry-data/validators
│   ├── fold.ts          foldLedger() — 首有效记录胜出 + drop 墓碑
│   ├── projection.ts    buildCompactionProjection — full-fold 升级 + 边界门控
│   ├── recall.ts        recallMemorySources — indexLedger + 源解析
│   ├── render-summary.ts 确定性 markdown 渲染
│   ├── progress.ts      token-since-coverage 计量
│   └── index.ts         barrel
├── tools/recall-observation.ts   recall 工具注册
└── commands/{status.ts, view.ts} /om:status /om:view
```

### 3.2 生命周期（数据流）

```
turn_end ──token-clock──> consolidation-trigger
   │ (observe ≥10K raw tokens since coverage)
   ├─ Observer: 序列化 chunk → record_observations 工具 → normalizeSourceEntryIds
   │            → hashId 去重 → appendEntry(om.observations.recorded)
   │ (reflect ≥20K & observer not due)
   ├─ Reflector: fold → coverageMap(none/partial/strong) → record_reflections
   │            → normalizeSupportingObservationIds → appendEntry(om.reflections.recorded)
   │ (pool > target & 同轮 reflection 非空)
   └─ Dropper: poolMetrics → maxDropCount → drop_observations 模型提案
              → selectDropCandidates(coverage→relevance→age→order) → appendEntry(om.observations.dropped)

agent_end ──idle + ≥81K──> compaction-trigger → ctx.compact()
   │
   └─ session_before_compact → compaction-hook
         buildCompactionProjection(fold + full-fold 升级) → renderSummary
         → { compaction: { summary, details: om.folded } }   ← 无模型
```

---

## 4. 支柱详解 (Pillars in Depth)

### 支柱 1 — Ledger-as-truth（事件溯源）

账本由三类 append-only custom entry 组成，永不 mutate：

```ts
// types.ts:104-119
om.observations.recorded: { observations: Observation[]; coversUpToId: string }
om.reflections.recorded:  { reflections: Reflection[];  coversUpToId: string }
om.observations.dropped:  { observationIds: string[];   coversUpToId: string }
```

`foldLedger()` 是核心 reducer（fold.ts:50-100）：线性扫描 entries，`observationsById.has(id)` 实现**首有效记录胜出**（同 id 重复 → 保留最早）。drop 是墓碑——从 `activeObservations` 排除，但保留在 `observations` 供 recall。compaction 时不写新 ledger entry（compaction-hook 不 appendEntry），只把折叠结果写入 compaction entry 的 `details: om.folded`。

**`coversUpToId` 的角色分离**（架构关键决策）：它是**进度/投影 watermark**（驱动 token-clock 计量 + 投影边界），**不是 provenance**。provenance 在 `Observation.sourceEntryIds`（→ 原始会话条目）和 `Reflection.supportingObservationIds`（→ observation）。混用两者是事件溯源经典反模式，本项目刻意分离。

### 支柱 2 — 双层记忆 + 双向 provenance

```ts
// types.ts:9-49
type Observation = { id; content; timestamp; relevance: "low"|"medium"|"high"|"critical";
                     sourceEntryIds: string[];    // → 原始会话条目（provenance）
                     tokenCount: number; }
type Reflection  = { id; content; supportingObservationIds: string[];  // → observation（覆盖证据）
                     tokenCount: number; }
```

- **Observations** = 时序事件（"用户决定从 REST 切到 GraphQL"），带 relevance 分级 + 源条目溯源。
- **Reflections** = 持久事实（"用户在构建 Next.js 15 dashboard + Supabase auth"），从 observations 蒸馏，`supportingObservationIds` 是**下游 dropper coverage 证据**。
- 双向链：observation→raw（sourceEntryIds），reflection→observation（supportingObservationIds）。后者使 deterministic coverage 计算成为可能。

### 支柱 3 — 三 agent 管线（model 提案 / code 裁决）

三 agent 共享相同 scaffold（observer/agent.ts:160-193）：构建 typed tool → 组装 user message → AgentContext+AgentLoopConfig（boundedMaxTokens 32K + sequential tool + agentMaxTurns cap）→ drain stream → 返回累积结果。**tool 的 `execute` 闭包是唯一累积通道——模型不能塞自由文本被解析。**

| Agent | 输入 | 工具 | code 裁决 |
|-------|------|------|-----------|
| Observer | 序列化 chunk + 已有 memory 摘要 | `record_observations` | `normalizeSourceEntryIds` 拒收未知源 id；`hashId` 去重 |
| Reflector | active observations + coverage tier + reflections | `record_reflections` | `normalizeSupportingObservationIds` 拒收未知 observation id；`hashId` 去重 |
| Dropper | active observations + coverage tier + pool 指标 | `drop_observations` | `selectDropCandidates` 重排 + maxDrops cap |

**核心设计洞察**：model 决定 *什么值得保留*（提案 observations/reflections/drop 候选）；deterministic code 强制 *结构不变量*（id 校验、content-hash 去重、coverage 计算、优先级排序、token 上限）。**模型无法伪造 provenance**——无效 id 被拒收。

### 支柱 4 — 无模型 compaction（已代码证明）

```ts
// compaction-hook.ts:16-50（节选）
pi.on("session_before_compact", async (event, ctx) => {
  if (runtime.compactHookInFlight) return { cancel: true };   // 并发守护
  runtime.compactHookInFlight = true;
  try {
    runtime.ensureConfig(ctx.cwd);
    const { firstKeptEntryId, tokensBefore } = event.preparation;
    const projection = buildCompactionProjection(branchEntries, firstKeptEntryId,
                          { observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) });
    const summary = renderSummary(projection.reflections, projection.observations);
    return { compaction: { summary, firstKeptEntryId, tokensBefore, details: projection.details } };
  } finally { runtime.compactHookInFlight = false; }
});
```

**证明**：此 hook 仅 import `buildCompactionProjection` + `renderSummary`，无 `resolveModel`/`agentLoop`/`apiKey`。模型只在更早的 consolidation 时被调用。compaction = `fold + render`，O(entries) 确定性。

### 支柱 5 — Coverage-stewardship pruning

确定性 coverage 引擎（coverage.ts:18-42）：
```ts
reflectionCoverageTierForCount(count): 0→"none", 1→"partial", ≥2→"strong"
reflectionSupportCounts: 遍历 reflections，对每个 supportingObservationIds 去重计数
reflectionCoverageMap: observation id → tier
```

- **Reflector** 把 `[coverage: none|partial|strong]` 注入每条 observation 行（reflector/agent.ts:166）——是 review context，**非配额**。
- **Dropper** 用 tier 作**主排序键**（selectDropCandidates, dropper/agent.ts:99-129）：
  ```
  sort: coverageDelta(strong=0/partial=1/none=2) || relevanceDelta(low=0...critical=3)
        || ageDelta(older=0) || proposalOrder
  slice(0, maxDrops)
  ```
  **词典序优先级，非加权评分**——可审计、无需调权、coverage-first 保证语义安全。模型提候选集，code 决定幸存者。

**prompt 层语义契约**（reflector/prompts.ts:43-53）：support ids 是 provenance set 非 checklist；"false or inflated support ids can cause unsafe downstream dropper pruning"。code 依赖的 coverage 计算的语义可信度由 prompt 强约束 + id 有效性校验共同保障。

### 支柱 6 — Exact-id recall（非搜索）

`recallMemorySources`（recall.ts:172-237）：`indexLedger`（保留**所有**出现以检测 id 碰撞）→ id 匹配 → 解析 `sourceEntryIds`。工具约束 `^[a-f0-9]{12}$`，**故意非语义搜索**——防止 agent 把 recall 当模糊检索拐杖，保持工具廉价，迫使 memory 层做抽象。

---

## 5. 关键机制深潜 (Implementation Deep-Dive)

### 5.1 投影不对称（可扩展性杠杆）

`buildCompactionProjection`（projection.ts:173-208）：
- **Normal（维护）compaction**：observations 折叠到 cut（firstKeptEntryId），reflections/drops 仅折叠到**上次 full-fold 边界**（保持稳定）。
- **Full fold**：当 normal 投影的 observation tokenSum ≥ `observationsPoolMaxTokens`（20K），升级为全折叠，`fullFold:true` 盖戳边界供后续 compaction 知晓。

效果：reflections 跨多次维护 compaction 持久存在（稳定层）；只有 pool 超压才触发昂贵全折叠。**摊销** reflection/drop 工作。

### 5.2 Token-clock 触发

`anyStageDue`（consolidation-trigger.ts:72-75）：observer due（raw tokens since observation coverage ≥10K）**或** reflector due（≥20K）。两时钟独立——一个 stage 跳过不影响后续。compaction 阈值 `resolveCompactAfterTokens`（config.ts:72-77）：calibrated（静态 81K，向后兼容）vs ratio（`floor(contextWindow×0.68)`，适配大窗口模型）。

raw/source tokens 仅计 `message`/`custom_message`/`branch_summary`（progress.ts:10）；memory ledger/compaction entry 不计进度——避免"记忆自身膨胀进度"的反馈循环。

### 5.3 竞态/不变量鲁棒性

- 三 in-flight flag 防重复运行；compaction-hook 并发→`{cancel:true}`。
- observer 优先级：reflect/drop 在 observer due 时不推进。
- no-output→no-entry：空结果不写空 progress 标记（不推进 coversUpToId）。
- compaction 不等待 worker promise——折叠当前账本；半写条目被 validator 跳过。
- 历史/无效 coverage marker 被 progress helper 容忍（不抛异常）。
- `recall` 返回 missingSourceEntryIds/nonSourceEntryIds 诊断（部分召回）。

---

## 6. 对比分析 (Comparison)

### 6.1 vs ANL-001 pi-ultra-compact（同领域兄弟项目）

| 维度 | pi-ultra-compact | pi-observational-memory |
|------|------------------|--------------------------|
| 问题 | 文件/代码内容压缩（token 体积） | 会话语义连贯性 |
| 作用层 | 素材层 | 会话层 |
| compaction | 压缩 message 内容（需模型） | render 预存 memory（无模型） |
| 持久形态 | 压缩后内容 | append-only ledger |
| ANL-001 风险 | 3 critical bugs + 4 幻觉特性 | 语义保真度代理风险 |

**结论**：互补——ultra-compact 压素材体积，observational-memory 维护会话决策/事实。可叠加。

### 6.2 vs 标准 compaction

标准：compaction 时模型重写过去→慢 + 经多轮语义衰减。本项目：semantic work 前置 + compaction=render。直击 README 双痛点（连贯性丢失 + 卡顿）。

### 6.3 对 pi-maestro-flow 的参考价值

pi-maestro-flow 已有 `.workflow/` 持久状态（state.json/specs/wiki/embedding index）——**工件级跨会话记忆**。observational-memory 的"ledger+fold+render"模式可移植为**会话内记忆层**，与现有工件级记忆互补：
- 工件级（.workflow/）= 跨会话、持久、显式管理
- observations（会话内 ledger）= 单会话、自动捕获、compaction 时渲染

---

## 7. 安全分析 (Security)

### Model 信任边界
- tool-schema-only 输出，`execute` 闭包唯一累积通道。
- provenance 伪造抵抗：`normalizeSourceEntryIds`/`normalizeSupportingObservationIds` 拒收未知 id。
- coverage 通胀抵抗：prompt 强约束 + id 校验。**但仅校验 id 有效性，不校验语义保真度**（残留）。
- dropper 未知 id：静默跳过（只能 drop 已知 active）。

### 残留风险
1. **语义保真度不可机器验证**：reflection 引用真实 id 却未真正保持含义→假 strong coverage→不安全 drop。结构代理 vs 语义保证的根本差距。mitigation：prompt 强约束 + relevance/age/maxDaps 兜底。
2. **coverage 不修复历史**（concepts.md:81）：弱 support reflection 长期存在→活跃池可能高于 target。mitigation：age 维度 + /om:status 暴露。
3. **recall 部分召回**：source entry 已被 compaction 移除→missingSourceEntryIds 诊断。

---

## 8. 性能分析 (Performance)

- **token 估算**：`ceil(length/4)` 偏粗，但 maxDropCountForPool 用"平均 observation token"自校正。
- **折叠成本**：`foldLedger` O(entries) 全量扫描，未增量缓存；但 `visibleProjection` 读最近 om.folded details 免重折叠（主要 amortization），full fold 仅 pool≥maxTokens 时触发。
- **池预算双轨**：observationsPoolMaxTokens(20K, compaction 压力) vs observationsPoolTargetTokens(10K, dropper 维护)——刻意分离避免互相干扰。
- **长程 coverage 漂移**：reflector 不回溯修复历史 coverage→活跃池可能偏高；age 维度部分补偿。

---

## 9. 六维评分 (Six-Dimension Scoring — Adoptability Assessment)

> 评分视角：将本项目架构作为 pi-maestro-flow 会话级记忆设计的参考。1-5 分，附置信度。

| 维度 | 分 | 置信 | 关键证据 |
|------|---|------|----------|
| **Feasibility**（可借鉴性） | 5 | high | 纯 TS、无重运行时依赖（仅 Pi SDK peerDeps）、模块边界清晰、模式可直接移植 |
| **Impact**（采纳价值） | 5 | high | 直击长会话连贯性+卡顿双痛点；与会话级记忆需求高度契合 |
| **Risk**（架构风险） | 3 | medium | 语义保真度代理风险 + coverage 不修复历史 + 长程漂移；均 mitigation 可控但非零 |
| **Complexity**（设计复杂度） | 4 | high | 三 agent 管线+投影不对称+coverage 引擎有学习曲线，但每层单一职责、可分块理解 |
| **Dependencies**（外部依赖） | 4 | high | 仅 Pi SDK（agent-core/ai/coding-agent/tui）+ 可选模型 override；无 DB/外部服务 |
| **Alternatives**（替代方案） | N/A | — | 标准 summarization compaction（慢+衰减）/ RAG 向量检索（重+不同问题）/ 不做（衰减） |

### 风险矩阵（概率 × 影响）

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 语义保真度代理误判（假 strong coverage→误 drop） | 低 | 中 | prompt 强约束 + relevance/age 兜底 + maxDrops cap |
| 长程 coverage 漂移（活跃池高于 target） | 中 | 低 | age 维度 + /om:status 可见 + full-fold 兜底 |
| compaction 时 worker 未跟上（drift） | 中 | 低 | intentional + drift 可见 + 后续 compaction 补偿 |
| token 估算偏差致时钟/预算不准 | 低 | 低 | 自校正平均 + 阈值有余量 |

---

## 10. 结论与推荐 (Conclusions & Recommendation)

**Go/No-Go: GO**（采纳/参考，置信 high 85%）

**最值得借鉴的模式**（按优先级）：
1. **ledger-as-truth + fold-on-read + model-free compaction render** — 把昂贵 semantic work 前置，crisis 时刻只 render。这是本项目对"compaction 慢+衰减"问题的根本解法。
2. **model 提案 / code 裁决** — tool-schema-only 输出 + provenance 拒收 + content-hash 去重。correct-by-construction even if model hallucinates。
3. **coverage-tier 作为 pruning safety 结构信号** — none/partial/strong 由 reflection 支持数确定性计算，dropper strong-coverage-first。词典序优先级优于加权评分。
4. **coversUpToId（watermark）vs provenance 分离** — 事件溯源经典正解。
5. **投影不对称（维护 vs full-fold）** — 摊销昂贵折叠工作。
6. **exact-id recall（非搜索）** — 迫制 recall 滥用，保持工具廉价。

**关键残留风险**：语义保真度不可机器验证（coverage 是结构代理）。借鉴时若需更强保证，可考虑：reflection 质量评分 + 周期性 coverage 审计/修复（本项目未实现）。

**对 pi-maestro-flow 的落地建议**：将会话内记忆层与现有 `.workflow/` 工件级记忆分层——observations ledger 处理单会话自动捕获，.workflow/ 处理跨会话显式工件。compaction 渲染复用 .workflow/state.json 的已存决策。

---

## 11. 置信度总结 (Confidence Summary)

| 维度 | 分数 | 置信 |
|------|------|------|
| architecture | 90% | high |
| implementation | 90% | high |
| performance | 80% | medium-high |
| security | 80% | medium-high |
| concept | 90% | high |
| comparison | 78% | medium-high |
| **Overall** | **85%** | **high** |

压力测试通过（compaction 无模型发现，4 级阶梯均成立）。Devil's advocate 完成（coverage-tier 残留=语义保真度代理）。残留风险均记录于第 7 节。

---

## 12. 代码锚点索引 (Code Anchor Index)

| 锚点 | 文件:行 | 重要性 |
|------|---------|--------|
| 类型基础 | `src/session-ledger/types.ts:9-49` | MEMORY_ID_PATTERN + 双层类型 + 双向 provenance |
| 折叠 reducer | `src/session-ledger/fold.ts:50-100` | 首有效记录胜出 + drop 墓碑 |
| 投影+升级 | `src/session-ledger/projection.ts:173-208` | 维护 vs full-fold + visible/full 分叉 |
| coverage 引擎 | `src/agents/dropper/coverage.ts:18-42` | none/partial/strong 确定性计算 |
| drop 优先级 | `src/agents/dropper/agent.ts:99-129` | 词典序 sort：coverage→relevance→age→order |
| 无模型 compaction | `src/hooks/compaction-hook.ts:16-50` | 仅 fold+render，无 resolveModel |
| id 生成 | `src/ids.ts:1-5` | sha256/12 确定性身份骨干 |
| 配置+阈值 | `src/config.ts:33-58,72-77` | DEFAULTS + calibrated/ratio |

---

*源：三层 Explore agent 探索 + docs/concepts.md + docs/how-it-works.md + README.md + ANL-001 (pi-ultra-compact) 对比上下文。CLI delegate 按用户选择跳过（W001 适配：用独立 agent 上下文交叉验证替代）。*
