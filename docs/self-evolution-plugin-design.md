---
kind: design
title: 自进化插件设计 — pi-maestro-flow harness 式知识沉淀闭环（修订 v2）
created: 2026-08-06
updated: 2026-08-06
status: draft-v2
supersedes: [self-evolution-plugin-design-v1]
related:
  - docs/advisor-vs-monitor-relationship-20260803.md
  - docs/supervision-unification-analysis-20260803.md
  - .pi/skills/maestro-knowledge/SKILL.md
  - .pi/skills/team-swarm/SKILL.md
---

# 自进化插件设计：把「运行轨迹」接上「知识沉淀」的闭环（v2 修订稿）

> 目标：在 pi-maestro-flow 中实现 harness 式自进化——让系统从每一次实际运行中自动识别「值得沉淀的经验」，经治理门写入 knowhow/spec（memory/prompt 等价物），并在未来运行中通过既有注入通道生效。
> 本稿基于 5 路并行 agent 交叉分析 + qwen/gpt 双模型评审修订。**v2 关键修正**：① 评审门改为「提示层 checklist + 阻断层 promote」双层模型；② 定位收敛为「知识生命周期协调器」（MVP 为半自动流水线，非全自动自进化）；③ 补齐知识健康闭环（验证→失效→回收）；④ 修正 3 处误述与 3 条验收断言。

## 1. 背景与结论

用户问题：prime-agent 的 harness 通过「模型可编辑的持久行为状态 + 自动评审门 + 每轮反馈注入」实现自进化；本环境的 knowhow/spec 与之对应（knowhow↔memory、spec↔prompt），是否能开发插件复刻该能力？

**结论：可以开发。纯外围实现、无需改 maestro/Pi 核心代码。MVP 定位 = knowledge lifecycle coordinator（半自动流水线）**，把已有的知识生命周期（stage→review→promote）接到 run 执行轨迹上。全自动自进化（自动评审门、自动规划、知识健康闭环）属于 Phase 2+，且按治理纪律保持人工晋升。

关键评分（交叉验证）：

| 映射 | 成立度 | 判定 |
|---|---|---|
| spec ↔ harness.prompt | 0.80 | 注入通道真实（`spec-injector.ts:194` 按类别整文件注入），但为静态类别条款注入，非行为状态 recall；本项目 `specInjection` 配置未激活 |
| knowhow ↔ harness.memory | 0.58 | 存储/检索/记账/supersede 齐全，缺自动 recall（靠主动 search）、自动写入（全人工）、遗忘衰减 |
| 自进化就绪度（整体） | 0.45 | 自动收集 + 自动去重 + **人工晋升**的半自动流水线 |

实据：`maestro knowledge audit` → **81 条候选滞留 pending，0 条自动晋升**，全库仅 2 条 promoted。

## 2. 机制差异：为什么不能照搬 harness

harness 与 maestro 知识体系**控制方向相反**：

| 维度 | prime-agent harness | pi-maestro-flow 知识体系 |
|---|---|---|
| 状态 | **模型可写**，写后下轮 system prompt 立即生效 | **模型只读**，写入必须走 stage→review→promote 治理门 |
| 注入 | 每轮渲染条目内容摘要（`system-prompt.ts:105-106`） | knowledge_context 是**对账卡片（元数据）**，不含知识全文（`run/runtime.ts:3670`） |
| 触发 | 自动评审门（reviewAutoRefine）+ 自动规划 | 无自动触发；seal 时仅自动汇总候选 |
| 归因 | 弱（仅 refinements 事件列表） | **强归因账本**（consumed/cited/validated/contradicted × source + evidence 锚点） |
| 强项 | 在环自适应闭环 | **可审计 + 治理门 + 谱系链** |

**maestro 侧缺失的 harness 四件套**：
1. **P0-1 自动评审门**：reconcile 产出 review_required 后须人工 `resolve --as --reason`，无打分阈值自动放行 → 81 候选滞留的咽喉；
2. **P0-2 运行轨迹证据输入**：evidence 仅 `run:/artifact:/file:line` 手工引用，无自动采集 gate 结果/测试结果/diff 作为证据信号；
3. **知识编辑规划步骤**：无「基于轨迹证据生成知识编辑提案」的 LLM 步骤；
4. **快照级回滚**：spec 无 snapshot；knowhow snapshot 是生命周期迁移专用（见 §8 V8 修正），非通用编辑快照。

## 3. 载体选型与集成点

### 3.1 载体：Pi 扩展第二入口（主）+ skill 可演化内容 + hooks 可选

- **先例已存在**：`packages/pi-maestro-flow/package.json` `pi.extensions` 已注册双入口，advisor 即第二入口落地（"never touches the main maestro extension's registration surface"）——零核心改动。
- 被演化的**内容**落 knowledge store（spec/knowhow）；**Phase 2 之前禁止自动改写 `.pi/skills/`**（skill 可改变工具与行为权限，需独立签名/版本化/回滚的 proposal 流程，见 §9.5）。
- 限频复用 advisor 的 **DeliveryGate**（冷却/去重/降级三档，`src/advisor/runtime.ts:39-45`）；但注意 DeliveryGate 在模型评估**之后**，只限投递不限 LLM 成本——插件需自带 per-run evaluation budget、最大候选数、超时（见 §10）。
- hooks（`.pi/hooks.json`，Codex 事件格式）承担可选低频外部触发，不作主逻辑载体。

### 3.2 集成点（全部有宿主事件支撑）

| 集成点 | 事件/机制 | 自进化用途 |
|---|---|---|
| turn 边界 | `agent_end`（每轮，含 messages） | **turn_interval 等价源**：计数 + 冷却后触发评估 |
| compact 边界 | `session_before_compact`（可 cancel）+ `session_compact` | **compact 等价源**：压缩后审查轨迹 |
| run seal | agent_end 时 refreshWorkflow 快照对比（index.ts:2587） | Run 完成后自动评估沉淀 |
| session seal | `maestro session seal`（CLI） | 候选 backlog 的 review/promote 收尾 |
| 注入/改写面 | `context`、`before_agent_start`、`before_provider_request` | 已进化策略下轮生效 |
| 跨轮持久化 | `appendEntry` / `.pi/*.json` | 自进化状态（版本、精化历史、回滚点） |

## 4. 闭环数据流（含时序铁律）

```
触发:  agent_end（turn_interval 等价）│ session_before_compact / session_compact（compact 等价）
         │
         ▼
评审清单（提示层，非阻断）: run check 的 finish-checklist（finish: frontmatter 扩展）
         │   ├─ 复用既有知识 → record --signal validated|contradicted（+证据锚点）
         │   ├─ 可复用发现 → stage knowhow --run <run-id>（run 活跃期内，seal 前）
         │   └─ 硬结论 → 写 report.md decisions/constraints（seal 时自动 stage）
         ▼
安全应用: run complete（seal 事务：自动 stage + 自动抑制 + receipt 固化，run 转不可变）
         ▼
阻断层:  promote（fail-closed 硬门）——未 seal 源 run / review_required 未裁决 /
         receipt 缺失或 stale / title 冲突 / reason 为空 → 全部 throw
         ▼
晋升:  session seal 阶段 review backlog → resolve 冲突 → promote
         ▼
反馈:  promote 落盘 → 索引器 mtime 增量感知 → 未来 run 的 maestro search 命中
         └→ knowledge_context 卡计数更新（曝光非消费；Phase 2+ 可加有界 retrieval_hints）
```

**时序铁律（实证）**：
1. **评审必须在 seal 之前**——sealed run 拒绝 sidecar 写入（`run/store.ts:592-620`）；而 promote 要求源 run 已 sealed。节奏：**run check 评审清单 → run complete seal → session seal 时 review/promote**。
2. **注意单点依赖**：seal 自动 stage 的候选（frontmatter 草拟）只能在 seal **后**被 review——天然错过 run check 窗口，只能在 session seal 阶段补审。执行者若在 check 阶段找不到自动草拟候选，属预期行为，非闭环失效。

## 5. 评审门设计（v2 修正：双层模型 + v3 事实型自动层）

**v1 误述**：把 run check 的 finish-checklist 当作「评审门」。**实测纠正**：finish checklist 是 *"Prompt-layer guidance — never a blocking gate"*（`run/runtime.ts:274`），执行者无视它也能 `run complete`——提示层靠纪律，不靠机制。

**v2 双层模型 + v3 分层自动化**：按知识来源的可验证性分层，**事实型知识可全自动，推断型知识留人工**：

| 层 | 覆盖 | 机制 | 性质 |
|---|---|---|---|
| **T0 自动抑制** | exact_duplicate | reconciliation 自动 suppressed | 全自动（已有） |
| **T1 自动草拟** | frontmatter decisions/constraints（run 执行者声明的**事实**） | seal 事务自动 stage（`runtime.ts:2905`） | 全自动（已有） |
| **T2 事实型自动晋升** | unique/eligible 候选（含 T1 事实候选） | `promote --all`（sealed 源 run + receipt 新鲜时晋升全部 eligible，observed-only 仅警告不阻塞） | **可全自动**（验收 V2 已实证：frontmatter 候选被 --all 正常晋升） |
| **T3 推断型人工** | semantic_duplicate/conflict/supersede（需要真伪/关系判断） | review_required → `promote` fail-closed 直到人工 `resolve --as --reason` | 保持人工（幻觉防线） |
| **阻断层** | 未 seal 源 run、receipt 缺失/stale、title 冲突、空 reason | `promote` throw（`run/knowledge.ts:876-931`） | 硬门 |

**结论修正**：早先「半自动」论断过度泛化——**事实型路径（T0-T2）已具备全自动能力**，`session done` 后执行 `promote --all` 即自动晋升全部事实候选（决策/约束/唯一候选），仅 review_required（推断型）留人工 resolve。剩余自动化缺口不在机制而在**策略**：把 T2 设为 seal 后默认步骤（skill 编排），并在 `--all` 前做一次性用户确认（治理纪律）。

**判定规则**：
- 候选存在性：机器判定（frontmatter accepted/locked 自动草拟 + `stage` 显式声明 + 对账 receipt 候选列表）；
- 候选正确性：MVP = 人工/主 agent 在 review 台裁决（`--resolve --as <disposition> --reason` 必填非空）；
- **corroborated 修正**：现状仅「≥2 runs 同候选时豁免 observed-only 警告」（`run/knowledge.ts:917`），**不改变 eligibility、不自动提权**（`reconcile.ts:487-496` eligibility 只看 disposition）。「独立证据根」自动提权是 Phase 2 待开发项，且必须排除同 Session 复制（见 §9.2）。

**证据源可靠性排序（实测）**：knowledge review receipts / reconciliation receipt（机器可验证、双指纹防 stale）> report.md frontmatter（结构化、自动草拟）> outputs/ 工件 + evidence.json（file:line 锚点）> session 轨迹（非结构化，仅作线索不作证据）。

## 6. 安全护栏（v2 补强）

| 护栏 | 机制 |
|---|---|
| 证据要求 | promote 前：① 源 Run 全部 sealed（否则 throw）；② 每个源 Run 有 reconciliation receipt；③ receipt 新鲜（corpus_fingerprint 比对，stale → throw） |
| 标题/内容冲突 | 同 title 不同 content → promote throw（除非已 resolve 为 supersede）；同 content → outcome=reaffirmed 幂等 |
| 不可变边界 | deprecated/superseded 条目排除出 search/load；MVP 不可自动改：已晋升 active spec、用户标记 conflict/contested 条目、global scope 条目；**Phase 2 前禁止自动改 `.pi/skills/`** |
| 版本/谱系 | `spec supersede <old> --by <new>` + `spec history` 显链；knowhow 同构 |
| 回滚 | 候选级 `review --resolve` 可逆（rejected→pending 显式路径）；knowhow snapshot/restore 仅限 supersede 迁移回退（见 §8 V8）；**spec 已晋升内容回滚 = 手工（已知限制）** |
| 权限边界 | 写入点 = 显式 CLI（stage/promote/review）+ 非空 reason；Knowledge Gate 是纪律非强授权——Phase 2B 补 capability + approval receipt + promotion 强制 reason |
| 不可信数据 | transcript / advisor message / 工具输出按 untrusted data 处理：secret redaction + 指令型内容 lint + 来源标记；advisor verdict 只能生成「线索候选」，不能证明知识正确 |
| 正反馈自强化 | 搜索曝光不影响基础排名（已有保护）；「坏知识指导执行→自报 validated→多 run 重复→提权」必须排除循环证据，要求机器验证或独立 verifier |
| 修剪 | `knowledge audit --prune --apply` 带备份的确定性软修剪 |

**残余竞态（官方已承认，MVP 接受）**：promote 校验后、项目写入前 corpus 仍可能变化（freshness TOCTOU）；audit 可 deprecate reconciliation target 而 receipt 不感知。Phase 2B 处理：promotion commit 绑定 corpus generation、每个 await 前复验、audit apply 前扫描 pending receipts。

## 7. 反馈注入（v2 修正）

1. **检索可见性（自动，主通道）**：promote 写入 `.workflow/specs|knowhow` → WikiIndexer 惰性 mtime 增量感知（`wiki-indexer.js:197-233`，非实时 invalidate）→ 下次 `maestro search` 命中；
2. **knowledge_context 卡（自动，元信息）**：未来 run brief 的 `run.knowledge_ids`、`session.promoted_candidates` 计数更新——**足够对账，不足以引导行为**（卡内无标题/适用条件/相关性）；
3. **全文注入（手动，条件性）**：执行者按 Knowledge Gate 对相关 ID `maestro load` 才算 consumed；
4. **Phase 2+ 增强（有界 retrieval_hints）**：卡中加最多 3 个 `{id, title, reason, query_hash, health}` 提示，仍标记 exposure；对低健康/contested 条目明确警告，不注入正文。MVP 不引入自动全文注入（防膨胀，符合 `exposure_only` 政策）。

## 8. MVP 范围与验收标准（v2 修正）

**MVP = 半自动流水线（零新增核心代码）+ 验收脚本 + 流程纪律**，明示不含自动化：自动识别「值得沉淀的经验」属 M3/M4。

**MVP 范围**：
1. 单 Session 单 Run 流水线：`next → brief（看卡）→ 执行 → check（对账+checklist）→ 人工 stage → complete → review --resolve → promote → 未来 run search 命中`；
2. 自动草拟：report frontmatter decisions/constraints → spec 候选（seal 时物化，零手工）；
3. 人工评审台：`--as` 支持 **5 种处置** duplicate/related/conflict/supersede/unique + 非空 reason（v2 补 related）；
4. 谱系：supersede 链 + history 可查；
5. 反馈：search 可见性 + knowledge_context 卡计数；
6. 验证工具：`knowledge audit` 健康报告（基线 diff）。

**验收标准（可执行，v2 修正）**：

| # | 验收项 | 验证命令 / 断言 |
|---|---|---|
| V1 | 闭环触发 | `maestro run create <cmd>` + `run brief <id> --json` 返回含 `knowledge_context` 卡 |
| V2 | 自动草拟 | **（v2 修正：断言链含 complete）** 写 frontmatter accepted decisions → `run complete`（seal 物化）→ `knowledge review <session> --json` candidates 非空 |
| V3 | 显式 stage | `knowledge stage knowhow "<t>" --content-file - --run <id> --evidence "<file:line>"` 返回候选 id |
| V4 | 对账 | 重复 stage 同内容 → **exact_duplicate 自动 suppressed（无需 resolve）**；semantic_duplicate 才需 resolve → eligibility=suppressed |
| V5 | 晋升门禁 | 未 seal Run 上 promote → throw（文案可断言）；seal 后成功返回 promoted_id |
| V6 | 冲突拦截 | 与既有 spec 同 title 不同 content → promote throw 要求 resolve |
| V7 | 谱系 | `spec supersede` 后 `spec history` 显链、`spec health --json` deprecated +1（必要时先 `spec backfill-sid`） |
| V8 | **（v2 降级）** supersede 回滚演练 | `knowhow snapshot create --old <id>` → `snapshot seal --snapshot` → `restore --snapshot` 恢复。**语义限定为生命周期迁移回退，非通用编辑快照**；spec 回滚仍为手工 |
| V9 | **（v2 修正）** 反馈注入 | **不删缓存**：promote → `maestro search "<title>" --type knowhow` 命中（覆盖 daemon 存活/不存活两分支：mtime 增量 vs search-cache 重建） |
| V10 | **（v2 修正）** 审计健康 | **基线 diff**：先固化 `knowledge audit --json` 基线（实测存量含 4 条 invalid-knowledge-ledger findings）→ 变更后无新增 findings |
| V11 | **（v2 新增）** 阻断门 | review_required 未裁决时：`promote --all` 跳过该候选（skipped_review_required）且显式 `promote --candidate` throw——**安全核心验收项** |

## 9. Phase 2+ 演进路线（v2 重排，采纳 gpt 建议）

- **Phase 2A — 候选生成与遥测**：事件采集 + 轨迹 hash 去重 + 证据引用 + stage 建议；默认 dry-run，**禁止自动 promote / skill mutation**。
- **Phase 2B — 治理硬化**：capability + approval receipt + **promotion 强制 reason/actor**；跨 Run candidate 事务索引（当前跨 Run 冲突检查在 SessionStore 锁外，`run/knowledge.ts:411`）；promotion generation fence（TOCTOU）；untrusted transcript redaction；并发/失败注入测试。
- **Phase 3 — 知识健康闭环（v2 补的核心缺口）**：建立统一 `knowledge-health.json` sidecar（覆盖 spec/knowhow）：`last_validated_at`、证据根数量、contradiction 状态、freshness；Session seal 聚合 validated/contradicted 信号 → 达阈值自动创建 **contest/revalidation queue** → 人工执行 supersede/deprecate；候选 TTL 分诊（过期未 corroborate → expired/suppressed，保留审计不物理删）。
- **Phase 4 — 受控自动化**：仅 exact duplicate 自动 suppress、低风险候选自动生成 promote 建议；**promotion 仍需用户请求或 confirmed governance step**（遵 `.pi/SYSTEM.md`）。
- **Phase 5 — 在线验证与 skill 演化**：高影响知识 canary/shadow 对照；skill 修改走独立 proposal（签名、静态检查、权限差异审查、快照、显式批准），不复用普通 knowhow promotion。

## 10. 风险与残余风险（v2 补强）

| 风险 | 护栏 | 残余风险 |
|---|---|---|
| 幻觉知识入库 | sealed runs + fresh receipts + evidence 锚点 + 人工 reason 裁决 | receipt 只验结构不验内容真伪；人工仍是最终防线 |
| 知识污染 | audit 软修剪带备份；supersede 保留不删除；deprecated 排除注入 | 错误条目在人工发现前仍命中检索 |
| 注入膨胀 | 卡内只注入元信息；全文需 load 显式消费 | search 结果膨胀靠相关性排序缓解 |
| 回滚不可逆 | knowhow snapshot（限迁移场景）；候选级 resolve 可逆 | **spec 已晋升内容回滚 = 手工**（MVP 已知限制） |
| 越权自动改写 | 写入点显式 CLI + 非空 reason；run 外直写依赖纪律 | 主 agent run 外调用绕过审计 |
| 评估成本失控 | DeliveryGate 只限投递**不限 LLM 调用** | Phase 2A 需 per-run budget / 最大候选数 / 超时 |
| 正反馈自强化 | 搜索曝光不影响基础排名；排除循环证据 | 需机器验证或独立 verifier（Phase 3） |
| 跨 Run 竞争 | 单 Run sidecar 全局锁 | 跨 Run 冲突检查在锁外 → Phase 2B 事务化 |

## 11. 里程碑（v2 修订）

- **M1（MVP 定稿）**：本设计 v2 + 验收脚本 V1-V11（含基线固化）；
- **M2（skill 封装）**：`self-evolve` skill 做**薄 router**（时序编排：何时 check→stage→seal→review→promote），命令面复用 maestro-knowledge 的 `maestro run skill --platform pi <step>` 模式，避免职责重叠双份维护；在目标 workflow 文档 frontmatter 注入 `finish:` 清单（`run/contract.ts:606-608` 从命令关联 workflow 文档提取）；
- **M3（Phase 2A/2B）**：扩展第二入口挂 agent_end/compact 事件（低频，复用 DeliveryGate + 自带预算控制）；dry-run 候选生成 + 治理硬化；
- **M4（Phase 3）**：知识健康闭环（health sidecar + contest queue + 候选 TTL）；
- **M5（Phase 4-5）**：受控自动化 + 在线验证 + skill proposal 流程。

## 附：评审记录（v2 依据）

### qwen 评审（落地可行性）要点
- 机制引用准确度约 90%；3 处关键语义高估：① finish checklist 非阻断（`runtime.ts:274`）→ 双层模型；② corroborated 非自动提权（`reconcile.ts:487-496`）；③ knowhow snapshot 为生命周期专用（`knowhow.ts:213-260`）非通用回滚；
- 修正 V2/V8/V9/V10 断言；新增 V11 阻断门验收；MVP 明示零自动化；
- self-evolve skill 应做薄 router，避免与 maestro-knowledge 重叠。

### gpt 评审（架构完备性）要点
- MVP 定位应收敛为 knowledge lifecycle coordinator；补「promoted→consumed→validated/contradicted→healthy/suspect→superseded/deprecated」健康闭环（Phase 3）；
- 护栏补漏：不可信数据封装、promotion 强制 reason、禁止自动改 `.pi/skills/`、跨 Run stage 事务化、freshness TOCTOU、评估成本预算、排除循环证据；
- knowledge_context 足够对账不足以引导行为 → Phase 2+ 有界 retrieval_hints；
- 边界结论：不新建第三套 evaluator/delivery，复用 SupervisionEvent + runSupervisedEvaluation + DeliveryGate。

## 附：实施记录（M1-M3 已完成，2026-08-06）

### M1 验收脚本 — ✅ 完成（最终 67 PASS / 0 FAIL，全绿）
- 交付：`scripts/self-evolve-acceptance.sh`（V1-V11，含基线固化）+ `scripts/self-evolve-acceptance-report.md`
- **V1-V11 全部 PASS**：闭环触发、自动草拟（seal 物化断言链成立）、stage、exact_duplicate 自动抑制、晋升门禁 throw、冲突拦截、supersede 谱系、反馈注入（不删缓存分支）、审计基线 diff、V11 阻断门（显式 throw + `--all` 跳过）、V8 snapshot create→seal→restore 完整链路
- **V8 阻塞根因已修复（2026-08-06）**：
  1. `scanKnowhow` 按 basename 映射 wiki id（`knowhowFileToWikiId`，`tools/knowhow-lifecycle.ts:621-644`），3 个 legacy `KNW-investigate-*/report.md` 与 `understanding.md` 全部撞名 → 任何生命周期操作 throw。修复：按目录前缀重命名（如 `KNW-investigate-login-api-config-report.md`），保留内容与目录引用（会话报告引用目录路径，不受影响）；
  2. `knowhow restore` 的 intent 账本为 snapshot 路径兄弟文件（`<path>.restore.intent.json`），重复运行需先清理，否则重放旧 intent 与当前 snapshot 不匹配；
  3. 验收脚本 V8 段落原硬编码判失败，已改为条件分支实测 seal+restore 全链路。
- 实测与设计偏差（已记录）：V6 冲突拦截在 promote 时点而非 reconcile；V4 suppressed 发生在跨 run reconciliation；V11 需先测显式 throw 再测 `--all`；`restore` 是顶层命令（`maestro knowhow restore`）而非 `snapshot restore`
- 测试残留每次运行后已清理（TIP + spec 测试条目 + 测试 session），corpus 保持基线（81/68/13/5 chains）

### M2 self-evolve skill — ✅ 完成（v3 增强）
- 交付：`.pi/skills/self-evolve/SKILL.md`（245 行薄 router）
- intent 分类表（review-run/review-signals/stage/seal/promote/health/full-cycle/**auto**）+ 阻断语义表 + 护栏 + `finish:` 注入示例 + 信号沉淀流水线（读取全局 suggestions/reviews → stage 候选构建）+ **事实型自动进化 T2**（seal 后 `promote --all` 自动晋升事实候选，T3 推断型留人工）；命令模板全部与 CLI 实跑对齐
- **v3 关键洞察（用户提出）**：skill/spec 进化条件源于**事实提取**（frontmatter 决策/约束、seal 事务、receipt、exact_duplicate）→ 事实型路径 T0-T2 可**全自动**（验收 V2 实证：frontmatter 候选被 `promote --all` 自动晋升）；推断型（T3 review_required）保持人工裁决为幻觉防线。早先「半自动」论断修正为**分层自动化**（见 §5 v3）

### M3 Phase 2A 扩展脚手架 — ✅ 完成（后续增强累计）
- 交付：`packages/pi-maestro-flow/src/self-evolve/{runtime,extension}.ts` + README.md + package.json 第三扩展入口（1 行）
- 默认禁用（`PI_SELF_EVOLVE=1` 或 `.pi/self-evolve.json`），未启用零副作用；agent_end（每源独立冷却）+ session_before_compact（仅观测）+ session_compact 事件 → dry-run 信号写全局 `~/.maestro/self-evolve/suggestions/<date>.jsonl`（**全局输出，git 干净**）；绝不自动 stage/promote；tsc 类型检查通过 + e2e 44 断言
- **增强（2026-08-06 累计）**：TUI 面板（`/self-evolve panel`）+ 状态栏 `EV● s·d·p` + 配置控制（`config <k>=<v>`，含 `model` provider/model 或 auto）+ `/self-evolve signals [N]` + **`/self-evolve review [N]`**（用配置模型经 teammate analyst 路由做 dry-run 评审，落盘全局 `reviews/<date>.jsonl`，测试接缝 `setSelfEvolveReviewRuntimeForTest`）

### M4 UI 提示层 + Phase 3 健康闭环 — ✅ 完成
- **UI 提示层**（`extension/index.ts` + `statusline/statusline.ts`）：状态栏 `KNOW r·p` 段（review_required 红色 danger / pending 绿色 phase），run/session seal 检测点更新 + 0→N 转变一次性 notify + `/maestro-knowledge` overlay 关闭后刷新；TSC 通过 + 标记渲染 6/6
- **Phase 3 健康 sidecar**（`scripts/self-evolve-health.mjs`）：聚合 `spec health` + `knowledge audit` → 全局 `~/.maestro/self-evolve/health.json`（可重建、git 干净），含 specHealth/audit/revalidation 队列（11 项：contested/ghost-reference/坏链→建议治理动作+命令）+ signals 聚合扩展点
- skill 增补：`review-signals`（全局信号→stage 候选）、`auto`（T2 事实型自动晋升）、`health`（消费 sidecar 治理循环）；结构校验标签配对（271 行）

### M5 信号聚合 + 治理硬化 + 真实 e2e — ✅ 完成（2026-08-06）
- **Phase 3 后半（信号聚合 + contest queue）**：`scripts/self-evolve-health.mjs` 聚合全部 run ledgers 的 validated/contradicted/cited 信号（实测：validated 13 · contradicted 1 · cited 7，14 条目）→ health.json `signals` 段（per-entry 计数 + lastRecordedAt）+ **contest queue**（contradicted>0 或 validated+contradicted 冲突 → P1 contest-review 建议）；另加**跨 run 候选索引**（按 title 聚合，多 run 重复候选提示）
- **Phase 2B 治理硬化（外围可实现部分）**：`scripts/self-evolve-approval.mjs record`（promote/supersede/deprecate/conflict-mark 的 actor+reason+timestamp+候选 审计回执 → 全局 `approvals/<date>.jsonl`）；skill promote 步骤加 **TOCTOU fence**（`knowledge review --refresh` 前置 + receipt 新鲜校验）+ approval receipt 收尾
- **skill 真实 run 端到端演练**：`scripts/self-evolve-skill-e2e.sh` **9/9 全绿**——create → frontmatter 事实 → check → seal（T1 自动草拟 2 候选）→ `--refresh` fence → **promote --all 自动晋升 2 个事实候选（T2 实证）** → approval receipt → search 命中 → health 重生成
- **实测踩坑（已写入 skill）**：report.md frontmatter 契约（`schemas.ts:565-584`）`verdict` 用 `ready|ready_with_concerns`（非 `done`）、decisions/constraints 必须带 `id`；CLI `session done --verdict` 则用 `done` 系——两套枚举，混用致 seal 校验失败零草拟

### 遗留跟进项
1. ~~V8 前置修复~~ **已完成**：legacy `KNW-investigate-*/report.md` 重复 id 冲突已通过按目录前缀重命名解决（`scanKnowhow` 不再撞名）；restore intent 账本清理逻辑已入验收脚本
2. M2 skill 需真实 run 端到端演练（当前仅签名级验证）——可由 V1-V11 验收脚本的 full-cycle 流程覆盖
3. M3 Phase 2B：capability/approval receipt/跨 Run 事务化/TOCTOU fence
4. ~~Phase 3~~ **健康闭环已起步**：sidecar 生成器完成；validated/contradicted 信号聚合（run ledger）与自动 contest queue 待接入 signals 扩展点

---
*本文档为设计草案 v2；所有机制均为实测命令/源码行为；M1-M4 实施记录如上，未改核心代码。*
