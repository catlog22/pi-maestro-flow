# Context: pi-ultra-compact Compression Mechanism Analysis

**Date**: 2026-07-10
**Artifact**: ANL-pi-ultra-compact-compression-2026-07-10
**Scope**: standalone (macro mode)
**Target**: G:\github_lib\pi-ultra-compact (v1.2.1)
**Confidence**: 88% (high) | **Recommendation**: CONDITIONAL GO

## Areas Discussed

1. 三级压缩系统 (NONE/MICRO/FULL) 算法细节与触发机制
2. 4级渐进式逐出 (Graduated Eviction) 设计与边界条件
3. 安全系统 (Snapshot-Rollback + Circuit Breaker) 可靠性
4. 性能优化 (Token Estimation, Cache-Aware, LLM Summarization) 有效性
5. 代码块保护机制与三重矛盾
6. 文档/实现偏差 (4个不存在的宣传特性)
7. 与7个替代系统的对比分析

## Decisions

### Decision 1: 触发机制需要修复
- **Context**: shouldCompact() 使用硬编码 0.6 而非配置的 preemptiveWatermark(0.7)，hardWatermark 默认 0.5 而非文档的 0.95。整个触发配置是死代码。
- **Options**:
  1. 修复 shouldCompact 使用 preemptiveWatermark + 修复 hardWatermark 默认值为 0.95
  2. 保持现状但更新文档
  3. 重新设计触发机制
- **Chosen**: 选项1 — 修复配置使其生效
- **Reason**: 触发机制是压缩系统的核心决策点，配置无效是Critical bug

### Decision 2: Level 4 预算强制需要修复
- **Context**: removeOldCompressibleMessages 的 initialTokens 不更新，预算可被超出300%
- **Options**:
  1. 在 add-back 循环中更新运行 token 计数
  2. 添加后验 token 检查，移除超出预算的消息
  3. 重新设计 Level 4 逻辑
- **Chosen**: 选项1 — 更新运行计数器
- **Reason**: 最直接的修复，行1081注释已指出缺失逻辑

### Decision 3: 代码块压缩需要重新设计
- **Context**: compressMessage 将完整代码块替换为50字符桩，>99%信息丢失，直接矛盾于代码保护逻辑
- **Options**:
  1. 保留首尾N行 + 中间省略
  2. 使用哈希引用
  3. 不压缩代码块，仅截断非代码部分
  4. 使用 tree-sitter AST 提取关键结构
- **Chosen**: 待定 — 需要进一步评估
- **Reason**: 这是最复杂的修复，涉及设计决策

## Constraints

### Locked
1. **架构管线**: classify→protect→evict→summarize 管线设计已验证优秀，不应改变
2. **4级渐进式逐出**: 4级递进剥离设计是7个独特价值之一，不应改变
3. **断路器+损失截断**: 3次失败→损失截断的安全网设计已验证可靠，不应改变
4. **engine.ts 零 Pi 耦合**: 引擎独立于 Pi 框架，是最佳架构品质，必须保持
5. **跨 Provider 兼容**: 20+模型自动适配的设计不应改变

### Free
1. **代码块压缩策略**: 可选择首尾N行、哈希引用、AST提取等不同方式实现 (implementer's choice)
2. **摘要合并策略**: 可选择 LLM 合并、规则合并、或截断+重新提取 (implementer's choice)
3. **recency/position 权重**: 可按 RESEARCH.md 推荐 (0.30/0.20) 或自定义权重 (implementer's choice)
4. **utils.ts 处理**: 可选择完成重构（engine导入utils）或删除utils.ts (implementer's choice)
5. **缓存感知默认值**: 可选择默认开启或保持默认关闭但更新文档 (implementer's choice)

### Deferred
1. **语义重要性评分** — 使用 LLM/embeddings 替代 regex 评分 — 推迟到未来版本（需要额外依赖和延迟）
2. **tree-sitter AST 解析** — 为代码块提供结构化理解 — 推迟到未来版本（需要依赖和复杂度增加）
3. **动态文件包含** — 类似 Cursor 的语义搜索拉入相关文件 — 推迟到未来版本（超出压缩扩展范围）
4. **查询条件压缩** — 根据用户即将提出的问题保留相关上下文 — 推迟到未来版本（需要预测模型）
5. **LRU Token 估算缓存** — 实现已宣传的 LRU 缓存 — 推迟到性能优化阶段（需要先验证性能瓶颈）

## Code Context

### 关键代码锚点 (修复优先级排序)

| Priority | File:Line | Issue | Fix Direction |
|----------|-----------|-------|---------------|
| Critical | engine.ts:438 | shouldCompact hardcoded 0.6 | Replace with preemptiveWatermark |
| Critical | engine.ts:154 | hardWatermark default 0.5 | Change to 0.95 |
| Critical | engine.ts:1074-1083 | Level 4 initialTokens frozen | Update in add-back loop |
| Critical | engine.ts:1403-1416 | compressMessage code destruction | Redesign code block compression |
| High | engine.ts:1131-1134 | Summary bloat (verbatim prepend) | Add merge/condense step |
| High | README.md:19,24, CHANGELOG.md:241-242 | 4 non-existent features advertised | Remove or implement |
| Medium | engine.ts:1191-1230 | Missing recency/position signals | Add to importance scoring |
| Medium | engine.ts:25-35, utils.ts:13-23 | Code duplication (dead utils.ts) | Complete refactoring or delete |

### 跨Bug交互图

```
Bug 2 (hardcoded 0.6) ──┐
                        ├──→ Trigger config ALL DEAD → premature compaction
Bug 5 (hardWatermark 0.5)┘                                │
                                                          ↓
Bug 4 (summary bloat) ←── faster re-trigger ←── premature compaction
    │
    ↓
Summary grows → context re-bloats → Bug 1 (budget not enforced) → no safety net

Bug 3 (code destruction) + Bug 6 (no recency) → code AND reasoning lost simultaneously
```
