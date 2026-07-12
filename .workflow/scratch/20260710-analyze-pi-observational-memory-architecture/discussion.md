# Discussion — pi-observational-memory Architecture Analysis

**Session ID**: ANL-pi-observational-memory-architecture-2026-07-10 (artifact ANL-002)
**Topic**: 分析 G:\github_lib\pi-observational-memory 的设计架构与理念，产出参考文档
**Scope**: standalone / macro
**Mode**: Full (Deep Dive) — `-q` omitted
**Target**: pi-observational-memory v3.0.3 (Pi extension, TypeScript)
**Date**: 2026-07-10
**Dimensions**: architecture, implementation, performance, security, concept, comparison (all retained)
**Perspectives**: Architecture (claude-equivalent), Technical (gemini-equivalent), Domain Expert (gemini-equivalent) — synthesized via 3 parallel Explore agents; **maestro delegate CLI skipped per user explicit choice** (W001 adaptation: cross-validation via independent agent contexts instead of CLI subprocesses)
**Depth**: Deep Dive (3-layer exploration: module discovery → call-chain tracing → code-anchor extraction)

---

## Table of Contents
- [User Intent](#user-intent)
- [Current Understanding](#current-understanding)
- [Dimension Selection Rationale](#dimension-selection-rationale)
- [Discussion Timeline](#discussion-timeline)
  - [Round 1: Exploration Findings](#round-1-exploration-findings)
- [Intent Coverage Check](#intent-coverage-check)
- [Baseline Confidence Scoring](#baseline-confidence-scoring)

---

## User Intent

Original request: `分析G:\github_lib\pi-observational-memory 设计架构 理念 产出参考文档`

Decomposed intent items:
1. **设计架构** — Understand the system design and component architecture (observer/reflector/dropper, session-ledger, hooks).
2. **理念** — Distill the design philosophy / mental model (ledger-centered, two-tier memory, model-free compaction).
3. **产出参考文档** — Produce a reference document capturing architecture + philosophy for later reference (likely to inform pi-maestro-flow's own memory/compaction work, given prior ANL-001 analyzed sibling project pi-ultra-compact).
4. **对比与参考价值** (selected in scoping) — Compare against pi-ultra-compact + standard compaction; extract reusable patterns.

---

## Current Understanding

pi-observational-memory is a Pi extension that solves long-session context loss by inverting when memory work happens. Instead of summarizing the past AT compaction time (slow, lossy after repeated summary-chains), it maintains a branch-local append-only **ledger** of observations and reflections WHILE the session progresses, then renders that prepared memory deterministically at compaction time — no model call, near-instant.

The architecture rests on six pillars:
1. **Ledger-as-truth** — three custom entry types (`om.observations.recorded`, `om.reflections.recorded`, `om.observations.dropped`) appended to the Pi branch; memory state is reconstructed by folding, never mutated (event sourcing).
2. **Two-tier memory** — Observations (timestamped events w/ provenance `sourceEntryIds`) + Reflections (durable facts w/ `supportingObservationIds`). Bidirectional provenance links enable coverage-based pruning.
3. **Three background agents (write→distill→prune)** — Observer captures, Reflector distills + computes coverage tiers, Dropper prunes. Each is a model call over a single tool-schema; the model decides *what's worth keeping*, deterministic code enforces *structural invariants* (id validation, content-hash dedup, coverage sort, token caps).
4. **Model-free compaction** — `session_before_compact` hook only folds+renders; no model. The expensive work happened earlier at `turn_end` (token-clock-triggered consolidation). This is the headline latency win.
5. **Coverage-stewardship pruning** — deterministic tiers (none/partial/strong = 0/1/≥2 reflections citing an observation); dropper sorts strong-coverage-first. False support ids are explicitly flagged as causing unsafe pruning — prompt + code jointly enforce the contract.
6. **Exact-id recall** — `recall(<12-hex-id>)` recovers source entries behind compacted memory; deliberately not search.

---

## Dimension Selection Rationale

All four offered directions were selected (architecture & patterns, concepts & mechanisms, implementation & code structure, comparison & reference value) → all 6 scoring dimensions retained (feasibility/impact/risk/complexity/dependencies/alternatives). Deep Dive chosen → 3-layer exploration across the entire src/ tree via 3 parallel Explore agents, each covering a slice (session-ledger core / three agents / integration+hooks), plus direct reading of docs/concepts.md + docs/how-it-works.md for the philosophy layer.

---

## Discussion Timeline

### Round 1: Exploration Findings

**Sources used**: 3 Explore agents (3-layer each), docs/concepts.md, docs/how-it-works.md, README.md, package.json, src/ file listing. No external web research (familiar domain; codebase self-documenting).

**Key findings with code anchors**:

1. **Ledger-centered event sourcing** — `foldLedger()` (fold.ts:50-100) walks append-only entries with first-valid-record-wins by id; drops are tombstones excluded from `activeObservations` but retained in `observations` for recall. The ledger is never mutated; projection reconstructs state. [concepts.md: "the ledger is the source of truth"]

2. **Compaction = render, not summarization** — PROVEN: compaction-hook.ts:16-50 imports only `buildCompactionProjection` + `renderSummary`; no `resolveModel`/`agentLoop`/`apiKey` anywhere in the hook. `renderSummary` (render-summary.ts) is a pure string template. The model is invoked only earlier during consolidation (turn_end). [how-it-works.md: "V3 is model-free and renders a projection"]

3. **Projection asymmetry** — `buildCompactionProjection` (projection.ts:173-208): normal (maintenance) compaction folds observations to the cut but holds reflections/drops stable from the last full-fold boundary; full fold only when observation pool ≥ `observationsPoolMaxTokens` (20K). This amortizes reflection/drop work. `fullFold: true` stamps the boundary for future compactions.

4. **Coverage-tier deterministic engine** — `reflectionCoverageTierForCount` (coverage.ts:27-31): 0→none, 1→partial, ≥2→strong. The single function both reflector (prompt context) and dropper (pruning sort) depend on. Reflector injects `[coverage: none|partial|strong]` into each observation line (reflector/agent.ts:166).

5. **Lexicographic drop priority** — `selectDropCandidates` (dropper/agent.ts:99-129): sort by coverageDelta (strong=0/partial=1/none=2) || relevanceDelta (low=0...critical=3) || ageDelta (older first) || proposal order; then slice(0, maxDrops). Model proposes candidates; code decides survivors. No weighted scoring — auditable.

6. **Model/code responsibility split** — Observer `normalizeSourceEntryIds` rejects observations with unknown source ids; Reflector `normalizeSupportingObservationIds` rejects reflections citing unknown observations. The model cannot fabricate provenance. Content-hash `hashId=sha256(content).slice(0,12)` (ids.ts:1-5) gives deterministic dedup.

7. **Token-clock triggers** — `anyStageDue` (consolidation-trigger.ts:72-75): observer due when raw tokens since observation coverage ≥ 10K; reflector due when ≥ 20K (and observer not due). Compaction: `resolveCompactAfterTokens` (config.ts:72-77) — calibrated (static 81K) or ratio (floor(contextWindow×0.68)). Raw/source tokens only (message/custom_message/branch_summary).

8. **Race/invariant robustness** — in-flight flags prevent duplicate runs; observer priority; no-output→no-entry (no empty progress markers); compaction does NOT wait for workers (folds present state); invalid/historical coverage markers tolerated not thrown.

9. **Recall = exact-id reverse lookup** — `recallMemorySources` (recall.ts:172-237): `indexLedger` keeps ALL occurrences (collision detection); resolves `sourceEntryIds` against entry-by-id map; returns active/dropped status + missing/non-source diagnostics. Tool constrained to `^[a-f0-9]{12}$` — not search.

**Discussion points / open questions**:
- How does this compare to the prior ANL-001 (pi-ultra-compact)? Both address compaction but from opposite angles: ultra-compact compresses file content; observational-memory maintains session-coherence memory. Complementary, not competing.
- Is the coverage-tier heuristic (≥2 reflections = strong) robust against reflection quality drift over very long sessions? The reflector does NOT repair historical coverage (concepts.md:81) — a known limitation.
- Token estimation `ceil(length/4)` is crude; message entries use Pi SDK estimator but custom/branch use length/4. Acceptable for clock triggers but imprecise for pool budgets.

---

## Intent Coverage Check

| # | Intent Item | Status | Notes |
|---|-------------|--------|-------|
| 1 | 设计架构 (design architecture) | ✅ addressed | Round 1: full component map + call chains + 8 code anchors |
| 2 | 理念 (philosophy) | ✅ addressed | Round 1: six pillars distilled from concepts.md + code proof |
| 3 | 产出参考文档 (reference document) | 🔄 in-progress | analysis.md to be written in Step 6 (the deliverable) |
| 4 | 对比与参考价值 (comparison) | 🔄 in-progress | vs pi-ultra-compact noted; full comparison in analysis.md |

---

## Baseline Confidence Scoring

Factors (weights): findings_depth(.30), evidence_strength(.25), coverage_breadth(.20), user_validation(.15), consistency(.10).

| Dimension | findings_depth | evidence_strength | coverage_breadth | user_validation | consistency | Score |
|-----------|---------------|-------------------|------------------|-----------------|-------------|-------|
| architecture | high (.27) | high (.23) | full (.20) | pending (.075) | high (.10) | 88% |
| implementation | high (.27) | high (.23) | full (.20) | pending (.075) | high (.10) | 88% |
| performance | medium (.21) | medium (.15) | partial (.12) | pending (.075) | high (.10) | 66% |
| security | medium (.18) | medium (.15) | partial (.12) | pending (.075) | medium (.07) | 60% |
| concept | high (.27) | high (.23) | full (.20) | pending (.075) | high (.10) | 88% |
| comparison | medium (.21) | medium (.15) | partial (.12) | pending (.075) | medium (.07) | 60% |

**Overall baseline confidence: ~75%**
**Weakest dimensions**: comparison (60%), security (60%), performance (66%).
**Threshold note**: <60% continue deepening | 60-80% needs user confirmation to converge | >80% proceed to synthesis. Comparison/security/performance are in the 60% band → present to user for convergence decision.

---

### Round 2: Deepening Comparison / Security / Performance

**起点**: 基于 Round 1 的架构/概念高置信 (88%) 与对比/安全/性能低置信 (60-66%)，本轮从三个最弱维度切入深化。用户选择 "123"（全部三方向）。

#### 深化 1 — 对比与参考价值 (comparison: 60% → 78%)

**vs ANL-001 pi-ultra-compact** (sibling project, same problem space — Pi long-session context):

| 维度 | pi-ultra-compact | pi-observational-memory |
|------|------------------|--------------------------|
| 解决的问题 | 文件/代码内容压缩（token 体积） | 会话语义连贯性（memory coherence） |
| 作用层 | 素材层（压缩被引用文件的内容） | 会话层（维护 observations/reflections 账本） |
| compaction 介入 | 替换/压缩 message 内容（仍需模型参与压缩决策） | **render 预存 memory，无模型** |
| 模型依赖 | 压缩时调用模型 | 仅 consolidation 时调用；compaction 时无 |
| 持久形态 | 压缩后的 message 内容 | append-only ledger（可折叠/可 recall） |
| 风险 | ANL-001 发现 3 critical bugs（trigger dead/L4 budget/code destruction）+ 4 幻觉特性 | 语义保真度代理风险（coverage 是结构代理非语义保证） |

**定位**：互补而非竞争。pi-ultra-compact 压缩"素材体积"，pi-observational-memory 维护"会话语义"。两者可叠加——ultra-compact 处理被引用文件内容，observational-memory 维护会话决策/事实。

**vs 标准备 compaction**（朴素 summarization-at-compaction）：
- 标准：compaction 时模型重写过去 → 慢 + 经多轮压缩后语义衰减（"compressed of compressed"）。
- 本项目：semantic work 前置到 turn_end（token-clock 触发），compaction = 折叠+渲染（O(entries) 确定性）。直接消除 README 描述的两个痛点（连贯性丢失 + 压缩卡顿）。

**对 pi-maestro-flow 的参考价值**：本项目（pi-maestro-flow）已有 `.workflow/` 持久状态 + embedding index + spec/wiki 体系。observational-memory 的"ledger-as-truth + fold-on-read + model-free-render"模式可借鉴用于会话级记忆，与现有 `.workflow/` 工件级记忆互补（工件=跨会话，observations=会话内）。

#### 深化 2 — 安全面 (security: 60% → 80%)

**Model 信任边界**（核心安全设计）：
- 模型只能通过 tool-schema 输出结构化数据，不能塞入自由文本被解析。`execute` 闭包是唯一累积通道。
- **provenance 伪造抵抗**：`normalizeSourceEntryIds` 对每个 observation 的 sourceEntryIds 与 allowed 列表比对，任一未知 → 整条 observation 拒绝（rejected++，不入账本）。`normalizeSupportingObservationIds` 同理拒绝引用未知 observation 的 reflection。**模型无法凭空捏造 provenance。**
- **coverage 通胀抵抗**：reflector prompt 明确警告 "false or inflated support ids can cause unsafe downstream dropper pruning"；supportingObservationIds 是 provenance set 非 checklist；normalizeSupportingObservationIds 校验 id 有效性。**但仅校验 id 有效性，不校验语义保真度**——这是残留风险（见 Devil's Advocate）。
- **dropper 对未知 id**：`normalizeDropObservationIds` 静默跳过未知 id（不报错），因为 dropper 只能 drop 已知 active observation（selectDropCandidates 用 `byId.get(id)` 过滤 undefined）。

**竞态/不变量**：
- 三个 in-flight flag（consolidationInFlight/compactInFlight/compactHookInFlight）防重复运行。
- compaction-hook 并发检测：若已在 flight → `{ cancel: true }`。
- observer 优先级：reflect/drop 在 observer due 时不推进，避免在未观察的源文本上提炼。
- no-output→no-entry：空结果不写空 progress 标记，避免推进 coversUpToId 却无内容。
- compaction 不等待 worker promise——折叠当前账本状态；worker 半写条目被 validator（isObservationsRecordedData 等）跳过而非崩溃。
- 历史/无效 coverage marker 被 progress helper 容忍（不抛异常）。

**残留风险**：
1. 语义保真度不可机器验证（coverage 是结构代理）。
2. reflection 不修复历史 coverage（concepts.md:81）——一旦弱 support 的 reflection 存在，后续 dropper 按其原样处理。
3. recall 返回的 source entry 若已被 compaction 移除 → missingSourceEntryIds 诊断（部分召回）。

#### 深化 3 — 性能与长程鲁棒性 (performance: 66% → 80%)

**token 估算精度**：`estimateStringTokens=ceil(length/4)` 对 custom_message/branch_summary；message 用 Pi SDK estimator。对时钟触发（observe/reflect/compact threshold）足够；对池预算（observationsPoolMaxTokens/Target）偏粗——但 maxDropCountForPool 用"平均 observation token"自校正，单次误差被平均化。

**折叠成本**：`foldLedger` O(entries) 线性扫描。长会话 entries 增长 → 每次 consolidation/compaction 都全量折叠。**未做增量/缓存**——但 visibleProjection 读取最近 compaction 的 om.folded details 直接返回（免重折叠），是主要 amortization。full fold 仅在 pool≥maxTokens 时触发。

**长会话 coverage 漂移**：reflector 计算当前 coverage（此时此刻哪些 observation 被 reflection 覆盖），不回溯修复历史 reflection 的 support 漏洞。后果：早期 reflection 若漏标 support，对应 observation 的 coverage 长期偏低 → dropper 不愿 drop → 活跃池可能高于 target。缓解：dropper 的 age 维度（older drops first）部分补偿；`/om:status` 暴露 pool pressure。

**池预算双轨**：observationsPoolMaxTokens (20K, compaction full-fold 压力) vs observationsPoolTargetTokens (10K, dropper 维护目标)——刻意分离：compaction 压力与 dropper 维护用不同投影/阈值，避免互相干扰。

#### 压力测试 (Pressure Pass) — GATE 2 mandatory

**被压测发现**（最高置信）："compaction 是无模型确定性 render，非 summarization。"

| 阶梯 | 质询 | 结果 |
|------|------|------|
| 证据要求 | 代码是否真的不触模型？ | ✅ compaction-hook.ts:16-50 仅 import buildCompactionProjection+renderSummary；无 resolveModel/agentLoop/apiKey |
| 假设探查 | 是否真的不等待 worker？ | ✅ how-it-works:"does not wait for observer/reflector/dropper promises"；折叠"whatever ledger state is already present" |
| 边界/权衡 | worker 半写时 compaction 触发？ | ✅ append-only + validator 跳过 malformed entry；不崩溃。代价：可见 memory 可能略滞后（visible-vs-full drift） |
| 根因核查 | 为何成立？ | ✅ 账本是 truth，fold 是 entries 的纯函数；model 工作与 render 解耦 |

**压力测试结论**：发现成立。残留=staleness/drift 窗口（已被 concepts.md 明确为 intentional，/om:status 可见）。接受。

#### Devil's Advocate — coverage-tier pruning (dim>0.7)

**反方**："若 coverage-tier（≥2 reflections=strong=safe to drop）不成立？"——即 reflection 质量差/语义不符时，strong coverage 是假安全 → 不安全 drop。

**裁定**：
- 结构层防御到位（id 有效性校验 + prompt 禁止通胀）。
- 但语义保真度不可机器验证：一个 reflection 引用真实 observation id 却未真正保持其含义 → 制造假 "strong" coverage。
- 这是**结构代理 vs 语义保证**的根本差距。prompt+tier 系统降低但不消除该风险。
- 长会话累积：reflection 不修复历史 coverage → 弱 support reflection 长期存在。
- **残留风险已记录**：coverage 是 pruning safety 的结构信号，非语义保证。接受（设计上 prompt 强约束 + 确定性 sort 优先 strong-coverage；实际 drop 仍受 maxDrops cap + relevance/age 兜底）。

### Round 2: Narrative Synthesis

**起点**：基于 Round 1 的高置信架构/概念发现，本轮从对比/安全/性能三低置信维度切入。
**关键进展**：对比层面确认 pi-observational-memory 与 ANL-001 pi-ultra-compact 互补（会话语义 vs 素材体积），且相对标准 compaction 直击双痛点。安全层面厘清 model 信任边界（tool-schema-only + provenance 拒收）与残留语义保真度风险。性能层面定位 token 估算/折叠成本/coverage 漂移，确认双轨池预算与 visibleProjection amortization。
**决策影响**：用户选"123"全深化 → 三维度均提升至 ~78-80%。
**当前理解**：架构成熟度高；核心创新=coverage-tier pruning safety signal + model-free compaction；残留风险集中在语义保真度（结构代理的天花板）+ 长程 coverage 不修复。
**遗留问题**：无阻塞——进入评分。

### Round 2: Re-scored Confidence

| Dimension | Before | After | Δ |
|-----------|--------|-------|---|
| architecture | 88% | 90% | +2% |
| implementation | 88% | 90% | +2% |
| performance | 66% | 80% | +14% |
| security | 60% | 80% | +20% |
| concept | 88% | 90% | +2% |
| comparison | 60% | 78% | +18% |

**Overall: 75% → ~85%** (above 80% convergence threshold → proceed to synthesis). Pressure pass completed (1×). Devil's advocate completed on coverage-tier pruning. No unresolved contradictions.

### Intent Coverage Check (Round 2)

| # | Intent Item | Status | Where |
|---|-------------|--------|-------|
| 1 | 设计架构 | ✅ | Round 1+2 |
| 2 | 理念 | ✅ | Round 1+2 |
| 3 | 产出参考文档 | 🔄 | analysis.md 即将产出 (Step 6) |
| 4 | 对比与参考价值 | ✅ | Round 2 深化 1 |

No ❌ items. Proceeding to six-dimension scoring + synthesis.

---

## Conclusions

**Go/No-Go**: GO — 架构值得参考，模式可移植到 pi-maestro-flow 会话级记忆层（置信 high 85%）。

**Ranked key conclusions**:
1. (high) Ledger-centered event sourcing：分支局部 append-only 账本是唯一真相，fold 重建状态，永不 mutate；coversUpToId (watermark) 与 provenance 分离。
2. (high) Compaction 是确定性 render 非 summarization——已代码证明（compaction-hook 仅 fold+render，无模型）。
3. (high) Model 提案 / code 裁决：tool-schema-only + provenance 拒收 + content-hash 去重 = correct-by-construction。
4. (high) Coverage-tier (none/partial/strong) 是 pruning safety 结构信号；词典序优先级（coverage→relevance→age→order）优于加权评分。
5. (high) 投影不对称（维护 vs full-fold）+ visibleProjection 摊销折叠成本。
6. (medium-high) 与 ANL-001 pi-ultra-compact 互补，可叠加。
7. (medium-high) 残留风险：coverage 是结构代理非语义保证；历史 coverage 不修复。

**Prioritized recommendations**: 见 conclusions.json R1-R7（均 review_status=accepted）。最高优先：R1 采纳 ledger+fold+render，R2 model/code 边界，R3 coverage-tier+词典序。

## Current Understanding (Final)

**Established**: pi-observational-memory 把记忆工作前置到 turn_end（三 agent 维护 observations/reflections 账本），compaction 退化为无模型 fold+render。六大支柱均代码验证。最创新贡献=coverage-tier pruning safety signal。**Clarified/corrected**: compaction 无模型不是优化而是架构后果（账本是 truth，fold 是纯函数）；coverage 是结构代理非语义保证。**Key insights**: model/code 责任分离使系统即使模型幻觉也 correct-by-construction；投影不对称是可扩展性杠杆。

## Decision Trail

| 时间 | 决策 | 理由 |
|------|------|------|
| scoping | 全 4 维度 + 3 视角 + Deep Dive；跳过 CLI delegate | 全面参考文档；并行 Explore 等深度更快 |
| Round 1 | 呈现 findings + baseline 75% | GATE 1 满足 |
| Round 1.5 | 用户选"123"全深化三弱维度 | 对比是选定方向；安全/性能未充分 |
| Round 2 | 压力测试 model-free compaction + devil's advocate coverage-tier；75%→85% | GATE 2 要求；超 80% 收敛阈值 |

## Intent Coverage Matrix

| # | Original Intent | Status | Where Addressed | Notes |
|---|----------------|--------|-----------------|-------|
| 1 | 设计架构 | ✅ Addressed | Round 1+2, analysis.md §3-5 | 全组件图 + 调用链 + 8 代码锚点 |
| 2 | 理念 | ✅ Addressed | Round 1+2, analysis.md §2 | 六大支柱 + 倒置理念 |
| 3 | 产出参考文档 | ✅ Addressed | analysis.md (主交付物) | 完整架构参考文档 |
| 4 | 对比与参考价值 | ✅ Addressed | Round 2 深化1, analysis.md §6 | vs ANL-001 + 标准 + pi-maestro-flow 落地 |

## Session Statistics

- **Rounds**: 2 (+ scoping)
- **Sources**: 3 Explore agents (3-layer each), docs/concepts.md, docs/how-it-works.md, README.md, package.json, ANL-001 context
- **Artifacts**: exploration-codebase.json, perspectives.json, discussion.md, analysis.md, conclusions.json, context.md, context-package.json
- **Decisions**: 4 (all classified: 6 Locked, 6 Free, 5 Deferred)
- **Confidence**: 75% → 85% (high)
- **Pressure pass**: 1× (model-free compaction, 4-level ladder, all hold)
- **Devil's advocate**: 1× (coverage-tier, residual=semantic fidelity proxy)
- **CLI delegate**: skipped per user (W001 adaptation: independent agent contexts)

---

*Session sealed: ANL-002 registered in .workflow/state.json. artifact_id=ANL-002, scope=standalone, recommendation=GO, confidence=high.*
