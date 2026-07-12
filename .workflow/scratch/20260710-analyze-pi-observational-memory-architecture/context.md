# Context: pi-observational-memory Architecture Reference (ANL-002)

**Date**: 2026-07-10
**Scope**: standalone / macro
**Target**: pi-observational-memory v3.0.3 (G:/github_lib/pi-observational-memory)
**Purpose**: 参考文档——为 pi-maestro-flow 会话级记忆设计提供可借鉴模式
**Areas discussed**: architecture patterns, model/code boundary, pruning safety, compaction render, memory layering

## Decisions

### Decision 1: 采纳 ledger-as-truth + fold-on-read + 无模型 compaction render 作为核心模式
- **Context**: compaction 慢 + 经多轮压缩语义衰减是长会话双痛点。本项目把 semantic work 前置到 turn_end，compaction 退化为确定性 fold+render。
- **Options**: 1) 采纳此模式 2) 标准 summarization-at-compaction 3) RAG 向量检索 4) 不做
- **Chosen**: 采纳（模式 1）
- **Reason**: 直击双痛点；O(entries) 确定性 render；已代码验证（compaction-hook.ts:16-50 无模型）。

### Decision 2: 采纳 model 提案 / code 裁决 边界
- **Context**: 模型可能幻觉/伪造 provenance。需结构保证。
- **Options**: 1) tool-schema-only + provenance 拒收 + content-hash 去重 2) 自由文本解析模型输出 3) 纯规则无模型
- **Chosen**: 模式 1
- **Reason**: correct-by-construction even if model hallucinates；execute 闭包唯一累积通道；normalizeSourceEntryIds/normalizeSupportingObservationIds 拒收未知 id。

### Decision 3: 采纳 coverage-tier (none/partial/strong) 作为 pruning safety 信号 + 词典序优先级
- **Context**: 需确定何时 drop observation 是语义安全的。
- **Options**: 1) coverage-tier 确定性计算 + 词典序 sort（coverage→relevance→age→order）2) 加权评分 3) 纯 recency 4) 纯模型决定
- **Chosen**: 模式 1
- **Reason**: 可审计、无需调权、coverage-first 保证语义安全；strong-coverage drops first。

### Decision 4: 分离 watermark 与 provenance
- **Context**: 事件溯源中进度标记与因果溯源混用是反模式。
- **Options**: 1) coversUpToId(watermark) vs sourceEntryIds/supportingObservationIds(provenance) 分离 2) 单一字段兼用
- **Chosen**: 分离（模式 1）
- **Reason**: 事件溯源正解；避免进度耦合因果。

## Constraints

### Locked
- **ledger-as-truth + fold-on-read**：记忆状态靠 fold 重建，永不 mutate；drop 是墓碑不删除历史。
- **model-free compaction**：compaction 时只 fold+render，不调用模型；semantic work 前置到 turn_end token-clock 触发。
- **model 提案 / code 裁决**：tool-schema-only 输出；provenance id 拒收（未知 source/support id → 拒绝整条记录）；content-hash 确定性 id 去重。
- **coverage-tier pruning safety**：none/partial/strong 由 reflection 支持数（0/1/≥2）确定性计算；dropper strong-coverage-first 词典序排序。
- **watermark ≠ provenance**：coversUpToId 仅驱动 token-clock + 投影边界；provenance 在 sourceEntryIds/supportingObservationIds。
- **exact-id recall 非 search**：recall 工具约束 `^[a-f0-9]{12}$`，不做语义检索。

### Free
- **token-clock 阈值**：observe/reflect/compact 的具体 token 值（本项目 10K/20K/81K）可按目标会话密度调整。
- **池预算值**：observationsPoolMaxTokens(20K)/TargetTokens(10K) 可调；双轨分离的设计保留。
- **compaction 阈值模式**：calibrated（静态）vs ratio（按 contextWindow 缩放）——按目标模型窗口选择。
- **三 agent 拆分粒度**：observer/reflector/dropper 分离 vs 合并，取决于复杂度需求。
- **coverage-tier 阈值定义**：none/partial/strong 的支持数边界（0/1/≥2）可重定义。
- **relevance 分级**：low/medium/high/critical 的语义可适配领域。

### Deferred
- **V2→V3 迁移逻辑**：本项目不向后兼容 V2；若 pi-maestro-flow 无遗留格式，不需迁移路径。
- **Pi SDK 特定 hook 注册**（agent_start/turn_end/agent_end/session_before_compact）：绑定 Pi 事件系统，移植需适配目标 runtime 的事件钩子。
- **dropper 历史 coverage 修复**：本项目未实现（concepts.md:81 明确不修复）；若需更强保证可后续加周期性 coverage 审计。
- **reflection 质量评分**：本项目用 prompt 强约束 + id 校验，无显式质量分；可后续加 LLM/embedding 质量评分（ANL-001 也 deferred 了 "Semantic importance scoring"）。
- **增量折叠/缓存**：foldLedger 全量 O(entries) 扫描；超长会话可考虑增量折叠优化（本项目仅 visibleProjection 读 om.folded 免重折叠）。

## Code Context
- 类型基础：`src/session-ledger/types.ts:9-49`（MEMORY_ID_PATTERN `/^[a-f0-9]{12}$/`、Observation/Reflection、双向 provenance 字段）
- 折叠 reducer：`src/session-ledger/fold.ts:50-100`（首有效记录胜出、drop 墓碑）
- 投影+升级：`src/session-ledger/projection.ts:173-208`（buildCompactionProjection、维护 vs full-fold、visible/full 分叉）
- coverage 引擎：`src/agents/dropper/coverage.ts:18-42`（reflectionSupportCounts、tierForCount、coverageMap）
- drop 优先级：`src/agents/dropper/agent.ts:99-129`（selectDropCandidates 词典序 sort）
- 无模型 compaction：`src/hooks/compaction-hook.ts:16-50`（仅 buildCompactionProjection+renderSummary）
- id 生成：`src/ids.ts:1-5`（hashId=sha256(content).slice(0,12)）
- 配置+阈值：`src/config.ts:33-58,72-77`（DEFAULTS、resolveCompactAfterTokens calibrated/ratio）
