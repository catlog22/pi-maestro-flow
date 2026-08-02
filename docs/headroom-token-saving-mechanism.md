# Headroom 压缩节省 Token 机制分析

> 分析对象：`G:/github_lib/headroom`（"The context compression layer for AI agents"，Rust + Python + TypeScript）。
> 覆盖：`headroom/transforms/`（Python 管道，约 24.5K 行）、`crates/headroom-core/`（Rust 并行实现，约 17K 行）、`headroom/compress.py`、`headroom/relevance/`。
> 生成日期：2026-08。SmartCrusher 算法位于 Rust（Python 文件为 PyO3 桥接层）。

---

## 一、总体架构：内容感知 + 分层压缩 + 可逆

主流水线（`headroom/transforms/pipeline.py`）：

```
TransformPipeline.apply()
  ├─ CacheAligner        — 只检测不重写（system prompt 缓存前缀稳定性观测）
  └─ ContentRouter       — 内容类型检测 → 路由到专用压缩器
        └─ 每个压缩器内部：Lossless-first → Lossy(Kompress/CCR)
```

核心设计原则：

1. **无损优先、有损兜底** — 所有策略先跑 `_lossless_first()`，失败/不足再走有损；
2. **有损必有可逆出口（CCR）** — 原文缓存 + `<<ccr:hash>>` 检索标记，按需取回；
3. **永不膨胀** — 压缩结果必须实际变短才采用（`accept_ratio`），管道末尾有 inflation guard（`compress.py`）；
4. **缓存前缀稳定** — 前缀单调、冻结区、确定性映射贯穿全部机制。

宣称效果：JSON 数据 **60–95%** 节省、编码 agent **15–20%**。

---

## 二、第一层：内容检测与路由

### 2.1 内容类型检测（`content_detector.py`）

检测优先级（`detect_content_type`）：

1. **JSON** — 解析式检测（非正则）：`json.loads` 解析成功即算；容忍外层小包装（`_JSON_MIN_BULK_FRACTION=0.6`，如 harness 包装的 `Exit code:` 前缀）；识别空格分隔的连续 JSON 对象（web_search 形态 `{...} {...}`）并规范化为数组（`normalize_concatenated_json`）
2. **Git diff** — 头部/变更行模式（含 `diff --combined`/`diff --cc` merge-commit 形态），扫描窗口 500 行（修复 `git log -p` 长提交消息误路由）
3. **HTML** — DOCTYPE/`<html>`/结构标签计数，前 3000 字符
4. **搜索输出** — `file:line:` 行占比 ≥30%
5. **日志/构建输出** — ERROR/WARN 等 25+ 种模式（含 Python/JS/Go/Rust/.NET 堆栈特征），匹配率 ≥10%
6. **表格** — markdown 表分隔行 / 分隔符列数一致性（CSV/TSV），带 prose 守卫
7. **结构化配置** — YAML/TOML/INI（TOML/INI 用 stdlib 解析器确认，YAML 启发式 + prose/front-matter 守卫）
8. **源代码** — 每语言正则集计分（python/js/ts/go/rust/java/csharp/php），≥3 命中
9. **纯文本** — 兜底

### 2.2 路由表（`content_router.py:2335-2347`）

| 内容类型 | 压缩器 | 节省来源 |
|---|---|---|
| `JSON_ARRAY` | SmartCrusher（→Rust 核心） | 去重、行选择、字段结构编码 |
| `SOURCE_CODE` | CodeAwareCompressor（tree-sitter AST） | 函数体截断、docstring 缩减 |
| `SEARCH_RESULTS` | SearchCompressor | 路径 heading 折叠 + 相关性保留 |
| `BUILD_OUTPUT` | LogCompressor | 重复段折叠 + 错误行保留 |
| `GIT_DIFF` | DiffCompressor | 可逆冗余剥离（禁用 Kompress 防破坏 git apply） |
| `HTML` | HTMLExtractor | 正文提取 |
| `TABULAR` | TabularCompressor | 结构化表格编码 |
| `STRUCTURED_CONFIG` | ConfigCompressor | 重复块回引用 |
| `PLAIN_TEXT` | KompressCompressor（ML） | 词级重要性抽取 |
| 混合内容 | 分段后逐段重路由 | — |

### 2.3 门槛与保护（`content_router.py` `apply()`）

- `min_tokens_to_compress`：库默认 250，消息路径 50
- `protect_recent=4`：最近 N 条不压缩（活跃会话）
- `protect_analysis_context`：analyze/review 意图检测，命中保护代码
- `frozen_message_count`：缓存前缀逐字节保留，不重写
- 含 `cache_control` 的 block 永不改写（防破坏显式 provider cache breakpoint）
- 已含 `Retrieve more: hash=` 的内容视为已压缩，禁止二次压缩
- 两级内容缓存：Tier1 无收益跳过、Tier2 压缩结果缓存；`HEADROOM_FREEZE_BLOCK_DECISION` 冻结首次判定防前缀抖动

---

## 三、第二层：Lossless-first — 格式原生可逆压缩

核心在 `lossless_compaction.py`。**每种手段自带精确逆函数，运行时自校验往返**（`compact_lossless`：逆变换不能逐字节还原或结果不变小 → 返回原文，绝不抛出）：

| 手段 | 作用 | 逆函数 |
|---|---|---|
| `strip_ansi` | 剥离 ANSI 颜色（非语义） | 单向 |
| `collapse_runs` | 连续相同行 → `... (repeated N times)`（syslog 惯例） | `expand_runs` |
| `fold_repeated_blocks` | 相隔 D 行的 K 行重复块 → `... (repeats K lines from D lines back)`（k8s 容器 stanza 场景，重复不必相邻） | `unfold_repeated_blocks` |
| `search_heading` | grep `path:line:content` → ripgrep heading 形（重复**文件**折叠） | `search_unheading` |
| `search_dir_heading` | 目录头折叠（`grep -rn` 每文件一命中场景，重复**目录**折叠） | `search_dir_unheading` |
| `path_heading` | `find/ls -1/rg -l` 纯路径列表的父目录折叠 | `path_unheading` |
| `diff_strip_index` | 删 diff 中 `index <sha>..<sha>` 簿记行（仍可 apply） | 纯删减 |

关键属性：**输出仍"长得像"自己的类型**（grep 还是 grep、日志还是日志），模型无需任何解码。这是编码 agent 15-20% 节省的主要来源。

---

## 四、第三层：有损压缩器

### 4.1 SmartCrusher — JSON 数组（60-95% 来源）

**注意**：Python `smart_crusher.py` 现为 **PyO3/Rust 桥接层**，算法在 `crates/headroom-core`。可确认的配置与行为：

- **Lossless 表格编码优先**（`lossless_min_savings_ratio=0.15` 才采用）：`csv-schema` / `json` / `markdown-kv` 三种渲染——CSV/schema 形态消除每行重复字段名；嵌套统一对象扁平化（≤6 内部键）
- **Lossy 行选择**：Rust 依据 variance/anomaly/position 统计特征选行（最多保留 15 项）；`preserve_change_points`、`first_fraction=0.3`、`last_fraction=0.15` 锚点
- **相同项去重**：`dedup_identical_items`；`similarity_threshold=0.8` 相似去重
- **常量字段提取**：`factor_out_constants`（默认关）
- **CCR 卸载**：被丢行尾部追加 `{"_ccr_dropped":"<<ccr:HASH N_rows_offloaded>>"}` sentinel；大 opaque blob 替换为 `<<ccr:HASH,KIND,SIZE>>`，原文存入 CCR store 按需取回
- **审计保护**：`protected_patterns` 匹配行压缩后按规范 JSON 身份（`json.dumps(sort_keys)` + Counter 重数敏感）补回；无法保证则 fail-closed 返回原数组

### 4.2 CodeCompressor — 代码

tree-sitter AST 感知，目标 `target_compression_rate=0.2`（保留 ~20% 行）：

- **函数签名完整保留**（参数/返回类型/泛型/多行签名）；imports 原样集中保留（可编译性）；装饰器/export 包装保留
- **函数体按预算截断**：只保留预算内完整 AST 语句（不切断表达式），超出替换为 `[N lines omitted; calls: ...]`（最多列 5 个被调用符号，用少量 token 保留调用关系线索）；Python 追加 `pass` 保语法
- **docstring 缩减**：默认只留首行（`FIRST_LINE`）；**函数体注释直接删除**；声明前无空行的连续注释作为 doc-comment 保留（不丢 API/许可证语义）
- **类内逐方法压缩**：类属性/类型注解/类 docstring 保留；未识别顶层代码（全局变量、`if __name__`）原样保留
- **预算分配**：`body_budget = total_lines × target_rate − fixed_lines`，按重要性（引用数 +refs、public +1、fan-out +0.5、dunder +2、context 命中 +3）加权，每函数上限 5 行
- **语法验证**：Python 三重校验（`ast.parse` + `compile` + tree-sitter），其他语言 tree-sitter ERROR/MISSING 检查；无效或结果 <5% 原文 → 回退原文
- **CCR**：保留率 <80% 时可缓存原文附 hash 取回
- 量化：模块注释声称 AST 压缩约 **5-8×**、token 级约 **3-5×**（经验声明）；tokenizer 不可用时按 `len(text)//4` 估算

### 4.3 Kompress — ML 抽取式文本压缩

`chopratejas/kompress-v2-base`，**抽取式**（不是生成式摘要）：

- **模型结构**：ModernBERT encoder + token keep/discard 二分类 head + span head（两层 1D CNN 加权重要连续区）
- **分块**：按 350 词/chunk（须匹配训练配置），tokenizer `is_split_into_words=True`，子词分数映射回 word
- **"解码" = `" ".join(保留词)`** — 原序抽取、无新事实，但换行/缩进/连续空白折叠
- **压缩比控制**：`target_ratio=None` 时模型自决（token 概率 ≥0.5，或 0.3–0.5 且 span>0.5）；指定时按 `token_prob × (0.5 + 0.5 × span_score)` 排序取 top-k（每 chunk 近似比例）
- **must-keep 硬保护**：数字、hex ID、ALLCAPS、路径、扩展名、CLI flags、CamelCase 等正则命中词无条件保留（`HEADROOM_KOMPRESS_MUST_KEEP=0` 关闭）；ContentRouter 先将自定义 XML/workflow 标签占位符化再恢复
- **运行模式**：本地 ONNX（int8）优先 → PyTorch 回退（可强制 `onnx_cpu`/`onnx_coreml`/`pytorch`/`pytorch_mps`）；远程 `HEADROOM_KOMPRESS_ENDPOINT` POST（远端只做推理，CCR 仍本地）
- **fail-open 全家桶**：模型未缓存（`allow_download=False`）/依赖缺失/推理异常/HTTP 错误/semaphore 饱和/全局 time budget 超时/canary 降级 → 原文直通；CCR 仅在 ratio < 0.8 时写入

### 4.4 其他结构化压缩器

- **LogCompressor**：无损折叠重复日志 → relevance split → 仅 Kompress 低价值尾部；错误行由重要性信号保留
- **SearchCompressor**：无损 heading 折叠 + 相关性保留高相关记录
- **DiffCompressor**：仅可逆剥离（`git apply` 必须可用），明确禁止接 Kompress
- **HTMLExtractor / ConfigCompressor / TabularCompressor**：各按结构压缩，无节省时统一尝试 Kompress（选 token 更少者）

---

## 五、关键支撑机制（决定"留什么"）

### 5.1 相关性感知切分（`relevance_split.py` + `headroom/relevance/`）

- 查询 = **用户 prompt + 触发工具调用参数**（grep 模式/读路径是最精确信号，`build_relevance_query`）
- 内容按空行/窗口分段（`segment`：缩进续行保持附着，不切堆栈/pretty JSON；`window=8` 行、`max_chars=1200`；分割无损 `"".join(segment)==content`）
- BM25 / bge-small embedding / hybrid 打分（Rust 有 `bm25.rs`/`embedding.rs`/`hybrid.rs`）
- **Otsu 自适应阈值**（`adaptive_threshold`）：取本输出相关分分布的天然分界（最大化类间方差，无 bin/常数），下限 `floor` 兜底 → 输出有序 KEEP/DROP runs（相邻同类合并）

### 5.2 自适应规模计算（`adaptive_sizer.py`）

- **Kneedle 拐点**：统计唯一 bigram 覆盖率曲线（CJK 文本用字符 bigram），找边际信息增益骤降点
- **SimHash 多样性**：`count_unique_simhash`（4-gram 指纹 + Hamming ≤3 聚类）；多样性比率修正——全唯一→保留 100%，多重复→~30%；高多样性时加地板防膝点弱信号
- **zlib 校验**（Tier 3）：子集压缩比与全集差异 >15% 时上调 K 20%（防漏信息）

### 5.3 锚点选择（`anchor_selector.py`）

- 数据模式 → 分配策略：搜索→`FRONT_HEAVY`、日志→`BACK_HEAVY`（最近的算数）、时间序列→`BALANCED`、通用→`DISTRIBUTED`
- 信息密度评分：字段值稀有度 40% + 内容长度 30% + 结构独特性 30%（罕见字段/缺失常见字段 = 可能是错误或特殊数据）

### 5.4 跨轮去重（`cross_turn_dedup.py`）

编码 agent 常跨轮重复 `cat foo.py` → `sed -n 75,100p` → `git diff` → `cat foo.py`：

- 后块中与**严格更早块**逐字节相同的连续 span（≥3 行且 ≥40 字符）→ 替换为上下文内指针 `[↑N L same as msg T: anchor]`（约 35 字符、带首行锚，无 hash= 检索 token，恢复在上下文内）
- **前缀单调性硬不变式**：只与更早块匹配（`is_prefix_monotonic` 断言）——追加回合永不改动先前回合字节 → 上游 prompt cache 前缀稳定
- **容忍行号平移**：编辑重排行号后重读仍折叠（`match_key` 剥离行号前缀、统一 delta 记录偏移），非数字行须精确匹配；前导零行号（`08:00:01`）刻意不匹配防破坏字节精确性
- 平凡行（`return`/`pass`/`}` 等）不索引；每行锚候选上限 16（防热行爆炸）

### 5.5 Thinking 压缩（`thinking_compactor.py`）

Claude 4.6+ 将历史轮次 thinking 作为输入**重新计费**（实测 opus-4-6 +995 tok/块、sonnet-4-6 +688）：

- **原位编辑无效**（Anthropic 用 block `signature` 固定并服务端重展开）→ **转为无 signature 的 text block** 才真正省（实测 716<835）
- 用 Kompress 压缩 thinking 文本，`[prior reasoning, compressed]` 标记
- **确定性 memo**（内容 hash → 压缩结果，LRU 8192）：客户端每轮重发原文、缓存持有压缩形，确定性映射保证转发前缀逐字节稳定（缓存仍命中）
- `keep_last_turns` 最近 N 轮保留原文；`bills_prior_thinking` 保守判定（4.6 以上才压缩，防在剥离模型上把免费 thinking 变收费）

### 5.6 可逆性 CCR（`headroom/ccr/`）

- 有损压缩的默认承诺：原文存入 CCR store，输出 `<<ccr:hash>>` / `Retrieve more: hash=` 标记
- MCP `headroom_retrieve` / 代理层拦截检索按需取回
- Kompress/SmartCrusher/CodeCompressor 三处都有 CCR 写入路径（阈值各异：Kompress ratio<0.8、CodeCompressor 保留<80%）

---

## 六、缓存感知（省的不只是 token，还有钱）

| 机制 | 作用 |
|---|---|
| `CacheAligner`（detector-only，P2-23 起不重写） | 结构解析（非正则）检测 system prompt 中 UUID/ISO8601/JWT/hex hash 易变内容，警告前缀不稳定；违反"缓存热区不可变"不变式的重写路径已删除；`get_alignment_score` 供仪表盘 |
| `frozen_message_count` / `cache_control` | 前缀逐字节保留；显式断点 block 永不改写 |
| 决策冻结（`HEADROOM_FREEZE_BLOCK_DECISION`） | 首次 compress/skip 判定冻结，防 min_ratio 漂移使同一块在原文/压缩间反复切换破坏前缀 |
| 两级内容缓存 | Tier1 无收益跳过、Tier2 压缩结果缓存（hash → 文本/ratio/strategy） |
| **net-mutation 成本模型**（`compression_policy.py` + Rust `compression_policy.rs`） | 缓存写 1.25x / 读 0.1x（Anthropic 5 分钟 tier）：`gain = dT·(w + r·(R−1)) − P_alive·(w−r)·(S+dT)`；只在净收益为正时深改缓存区后缀（`should_mutate_deep`） |
| 按认证模式策略 | Subscription 保守（lossy 上限 25%、volatile 阈值 32 tok、TOIN 只读、live-zone-only）；PAYG/OAuth 激进（45%、128 tok、TOIN 可写） |

---

## 七、Rust 并行实现与信号层（`crates/headroom-core`）

Python 与 Rust 双实现（parity 测试锁定一致性，`headroom-parity` crate），Rust 侧新增信号层：

- **行重要性**（`signals/`）：
  - `LineImportanceDetector` trait：输出 category（Error/Warning/Security/Importance/Markdown）+ priority + confidence，按上下文（Text/Search/Diff/Log）选择模式集
  - `KeywordDetector`：**aho-corasick 单遍自动机**（O(n+m)），置信度 0.7；修复 Python 两个 bug——正则集漏 `abort/timeout/denied/rejected`、`token` 在 LLM 代码库中误报安全
  - `Tiered` 组合器：置信度 ≥0.7 短路，否则取最佳——为未来 ML 检测器留位（组合而非继承）
- **相关性**：BM25 / embedding / hybrid 三实现
- **转换层并行**：adaptive_sizer、anchor_selector、code_compressor、log_compressor、search_compressor、diff_compressor、tag_protector、live_zone、kompress 均有 Rust 版本

---

## 八、端到端节省链路总结

```
编码 agent 典型请求：
  grep/搜索输出 ── lossless heading 折叠(文件/目录) + 相关性 KEEP/DROP ──▶ ~50%+
  日志/构建输出 ── 重复段折叠 + 错误行重要性保留 ──▶ ~60%
  代码块 ── AST 截断函数体/签名保留 ──▶ 3-5x
  JSON 数据 ── 表格编码 + 行选择 + 去重 + CCR ──▶ 60-95%
  thinking ── 确定性 Kompress 化(4.6+) ──▶ 数百 tok/块
  跨轮重复 cat/diff ── 上下文指针替换 ──▶ 冗余归零
  系统提示 ── 冻结 + 易变检测 ──▶ 缓存命中率↑(成本↓)
```

**三条贯穿不变式**：

1. **无损优先、失败回退原文**（永不膨胀——管道尾部 inflation guard）；
2. **缓存前缀稳定**（前缀单调、冻结区、确定性映射、决策冻结）；
3. **有损必有 CCR 可逆出口**。

---

## 附录：关键常量速查

| 常量 | 值 | 位置 |
|---|---|---|
| `min_tokens_to_compress`（库/消息） | 250 / 50 | compress.py / content_router.py |
| `protect_recent` | 4 | compress.py |
| `_JSON_MIN_BULK_FRACTION` | 0.6 | content_detector.py |
| `lossless_min_savings_ratio` | 0.15 | smart_crusher.py |
| 行选择上限 / first / last fraction | 15 / 0.3 / 0.15 | smart_crusher.py |
| `similarity_threshold` | 0.8 | smart_crusher.py |
| `target_compression_rate`（代码） | 0.2 | code_compressor.py |
| 每函数保留行上限 | 5 | code_compressor.py |
| Kompress chunk | 350 词 | kompress_compressor.py |
| 跨轮去重 min_lines / min_chars | 3 / 40 | cross_turn_dedup.py |
| 相关性分段 window / max_chars | 8 行 / 1200 字符 | relevance_split.py |
| thinking memo LRU | 8192 | thinking_compactor.py |
| Subscription / PAYG lossy 上限 | 0.25 / 0.45 | compression_policy.py |
| 缓存写 / 读乘数 | 1.25 / 0.1 | compression_policy.py |
| 行重要性置信度阈值（Tiered） | 0.7 | signals/tiered.rs |
