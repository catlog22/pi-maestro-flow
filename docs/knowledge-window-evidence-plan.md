# 知识沉淀证据层窗口化：窗口原始记录证据锚点方案（v3）

> 状态：v3 修订稿（双模型评审收敛版）
> 上游依据：
> - `docs/session-run-knowledge-target-architecture.md`（目标态总纲，铁律 10）
> - `docs/knowledge-session-decoupling-plan.md`（v2.1，K1-K11 机制体系）
> - `docs/knowledge-session-decoupling-mvp.md`（MVP 实施依据）
> - `docs/self-evolution-plugin-design.md`（evol 机制，redaction 排期 Phase 2B）
> 评审留痕：gpt-5.6-sol 架构评审（结论 `revise`）+ qwen3.8-max-preview 复杂度交叉审计（结论「40% 本质 / 60% 偶然」），双模型并行独立评审，本稿为收敛结果
> 仓库：`maestro2`（maestro-flow CLI）· `pi-maestro-flow`（Pi 插件）
> 关联：本文档是「知识沉淀锚点」决策链的第三步——① Session 为治理第一公民（不变）；② 容器不迁移到窗口/通道（门禁不可解耦，freeze 分支按 §6A.4 条件回归）；③ 本提案：**证据层锚定窗口会话原始记录**。

---

## 1. 背景与诉求

### 1.1 决策链

1. **锚点讨论**：Session 是知识治理第一公民，Run 是事实源之一（目标态总纲）；宿主会话 ID 只是身份映射键，永不充当目录权威（铁律 7）。
2. **容器讨论**：知识容器不迁移到窗口/通道（生命周期短、不可治理、无 seal/receipt）；`--channel`/`MAESTRO_CHANNEL` 保留为 A 级写授权身份；长开 synthetic session 不便 seal 时回归 freeze 分支（§6A.4 已预留）。
3. **本提案**：Session 保留为治理挂载点（治理骨架不变）；但**证据层需要更灵活**——evidence 应能锚定【窗口会话原始记录（transcript/对话原文）】，使沉淀出的 knowhow/spec 每条都有原始证据可回溯。

### 1.2 核心诉求

- 日常会话（无 run）中产生的 insight 可受治理地沉淀，且证据 = 对话原文（非 file:line）。
- knowhow/spec 从对话提炼时有据可查——**可回溯审计**。
- 跨窗口同一结论可互为佐证（独立证据根），corroboration 语义延续。

### 1.3 非目标

- 不改 Session 治理骨架、双源门禁的资格判定逻辑。
- 不让宿主会话 ID 成为目录权威（铁律 7 不动）。
- 不放宽铁律 10（transcript 按 untrusted 处理）。
- 不做全量 transcript 会话归档/持续事件日志。

---

## 2. 现状锚定（代码验证，2026-08 实测）

| # | 事实 | 位置 |
|---|---|---|
| E1 | `evidence_refs: z.array(nonEmptyString)`——run delta v1.0 与 session delta 共用的严格字符串数组 | `maestro2/src/run/knowledge.ts:45` |
| E2 | run delta v1.0 字节级冻结；promote 对 evidence 执行 `join(', ')` | `knowledge.ts:71-87`、`:906`、`:934` |
| E3 | session delta 已实现：`sessions/<sid>/knowledge-delta.json`，`SESSION_RECONCILIATION_RUN_ID='session'` 哨兵 | `knowledge.ts:229,254` |
| E4 | stage 时 evidence 非空强制（空 evidence 直接 throw）；sealed session 拒写 sidecar（S8） | `maestro2/src/run/session-knowledge.ts:139`、`:47-70` |
| E5 | **`sessionKnowledgeSnapshotHash` 与 run 侧 `knowledgeCandidateSnapshotHash` 均不含 `evidence_refs`**（字段仅 candidate_id/target/action/title/content/category/source_kind）→ receipt 不为证据集背书（明示接受项，见 §8） | `knowledge.ts:270-287`、`reconcile.ts:278-291` |
| E6 | 双源门禁 = sealed 不可变 + 新鲜 receipt（candidate_snapshot_hash + corpus_fingerprint）+ session 源另需 evidence 非空；promote 前 TOCTOU fence 重签 receipt | `reconcile.ts:752-761,895-903` |
| E7 | 铁律 10：transcript/advisor/工具输出按 untrusted；advisor 结论只能生成线索候选 | `session-run-knowledge-target-architecture.md:268` |
| E8 | Pi 插件进程内已有 `ctx.sessionManager.getBranch()/getSessionId()`（append-only JSONL、entry id/parentId/timestamp 稳定） | `pi-maestro-flow/.../extension/index.ts:572,1710` |
| E9 | Codex hooks 官方载荷含 `session_id` + `transcript_path`（已核实）；Claude hook 载荷待验证 | `docs/knowledge-session-decoupling-plan.md` D3 |
| E10 | `maestro2/src` 中 `transcript` 零出现——greenfield，无存量冲突 | 全仓 grep |
| E11 | **K9 已实现**：`session_start` 时自动注入 `process.env.PI_HOST_SESSION_ID = hostSessionId`（取不到则 delete），env-only、best-effort 降级，代码注释直接标注 K9 | `pi-maestro-flow/packages/pi-maestro-flow/src/extension/index.ts:2346-2360` |
| E12 | 注入为**进程级 env** → 插件发起的每个 maestro CLI 子进程自动继承，无需逐次传参 | 同上（`process.env` 语义） |
| E13 | **hook payload 已携带 `session_id` + `transcript_path`**（K13 的天然接入点；CLI 侧尚未消费） | `pi-maestro-flow/packages/pi-maestro-flow/src/hooks/pi-adapter.ts:644-645` |
| E14 | **CLI 身份解析模块完整**：`resolveWriteAuthority`（S3 写授权分级，489 行）A 级三支——① 显式 `--run/--session`；② `--channel`/`MAESTRO_CHANNEL` env → 通道 → 未绑定则幂等创建 synthetic session（`ensureSyntheticKnowledgeSession`）+ touchChannel；③ `PI_HOST_SESSION_ID` env → `findLeaseForHost` lease 反查 → run/session 绑定——外加 hook 注册通道唯一推断（`host_kind !== 'manual'`）、C 级收窄扫描、fail-closed | `maestro2/src/run/knowledge-identity.ts:296`（通道分支 `:315-333`、lease 分支 `:340-354`、hook 推断 `:356-380`） |
| E15 | **stage/record 双模入口已接线**：`knowledge.ts:438`（stage）/ `:581`（record）调 `resolveWriteAuthority`；load 归因已接线 `findSessionAttributionTarget` | `maestro2/src/commands/knowledge.ts:438,581`、`src/commands/load.ts` |
| E16 | **hook 事件注册通道已接线**（`touchChannel` 调用点：`hooks.ts` + 身份模块内部）；`search` 不建通道 ≠ 缺口，是 **K4 路径 B（search/load 指纹自注册候选通道）被 MVP 砍掉**后的设计使然 | 全仓 `touchChannel` 调用点 |
| E17 | 身份链路测试覆盖（通道/lease/synthetic session/串会话场景） | `maestro2/src/run/knowledge-identity.test.ts` |

**身份链路就绪度结论**（2026-08 核查）：

```
✅ 已就绪（零新代码）: 窗口会话 →(K9 env 注入)→ CLI resolveWriteAuthority →(lease/通道)→ 治理 Session → stage/record/load 归因
❌ 待实现（K12-K17）:  transcript 证据层——hook payload 已带 transcript_path（E13）但 CLI 零消费（E10）
```

- 用户关注的「自动会话窗口 id 注入关联知识沉淀管线」**已实现且接线完整**：窗口打开 → 身份自动注入 → 知识操作自动归属正确的治理 Session/synthetic session，串会话防护（A run + B 闲聊）有测试覆盖（E17）。
- v3 方案的身份层/治理层**零改动**，P1/P2 可直接从证据层开工。
- **P2 启动条件已全部就绪**：`transcript_path` 已在 hook payload（E13，K13 接入点）、`sessionManager.getBranch()` 可提取 entry+quote（E8，K14 原料）、stage 双模入口已带 `--evidence` 面（E15，K12/K13 挂载点）。落地仅需 CLI 加「片段输入 + 内容寻址快照 + URI」三个增量 + 插件侧一个提取器函数。

---

## 3. 双模型评审留痕

### 3.1 GPT（gpt-5.6-sol）架构评审：**revise**

**结论**：保留 Session 治理骨架和 stage-time transcript 快照方向，但必须用新证据胶囊/schema 将快照完整性纳入 receipt，并为 transcript-only 候选增加可信度裁决——否则现有门禁无法防证据篡改和「不可信原话自动晋升」。

**三个 P0 风险**：

1. **完整性缺口**：现有候选快照哈希不覆盖 `evidence_refs`，按初步方案实现会出现证据被替换/删除但 receipt 仍 fresh。
2. **可信度混淆**：现有 reconciliation 只判重复/关系/corpus 新鲜度，不判事实真假；transcript-only 候选走 unique/eligible + `--all` 会把「可追溯」误当「可信」。
3. **隐私与秘密**：对话可能含凭据/cookie/私钥/用户路径/PII；默认原样快照会把短生命周期敏感信息转成长期治理资产；正则脱敏漏报，必须有预览、策略版本、权限与删除路径。

**evidence 模型建议**：`knowledge-evidence/1.0` 证据胶囊——候选仍存短串 `ev:EVR-...`；结构化 locator（ref_id/kind/host_kind/host_session_key(HMAC)/adapter_version/native_entry_id/parent_entry_id/role/selection 字节偏移/canonicalization/source_hmac/trust_class/snapshot(相对路径+sha256)/redaction）落独立 sidecar；`evidence_root = SHA-256(canonical JSON(sorted refs + snapshot hashes))`；快照默认 32 KiB / 上限 64 KiB、每候选 ≤8 refs、脱敏快照 ≤256 KiB、每治理 Session 默认 10 MiB；pending 不因年龄删证据，rejected 后 30 天，promoted 保留至 superseded/deprecated 后再 180 天；隐私删除必须留不含原文的 tombstone 并把关联 active 知识标 `provenance_incomplete/review_required`。

**门禁兼容**：不可变门扩展为「candidate ledger + evidence manifest + snapshot blobs 全不可变且可解析」（走同一 sealed 检查，不借 `updateKnowledgeLifecycle` 绕过）；新鲜 receipt 需 `knowledge-reconciliation/1.1` 增加 `evidence_snapshot_hash`（仅 ref 字符串附 hash 不足）；promote 最低层复验集中到唯一 corpus-write preflight；铁律 10 不改不放宽，强化为可执行 trust policy；新增「可信度门」：仅由 assistant/tool/advisor/transcript 支撑的候选默认 `review_required`，不得被 `promote --all` 自动晋升，须人工 `--reason` 或独立验证器升级为 `human_attested|machine_verified`；快照不是 corpus——新增 promote-only 的 `knowledge-provenance/1.0` sidecar，search/load 默认不索引不注入，`knowledge evidence show <EVR>` 才展示已转义内容。

### 3.2 qwen（qwen3.8-max-preview）复杂度审计：**约 40% 本质 / 60% 偶然**

**结论**：值得做，但只做砍到最小核的版本——本质价值只有「stage 时刻把对话片段内容寻址快照 + 一个能穿透现有 string[] evidence_refs 的锚点 URI」，其余是偶然复杂度（evidence 层在现有体系里只是不可信数据 + 展示物，不是门禁参与者）。

**砍**：结构化 evidence_refs 对象（违反 S1，用 URI 字符串替代）；promote 门禁新增 transcript 分支（S2 等强度，file:line 今天也不校验质量）；CLI 跨平台拉取适配层（CLI 宿主无关，拉取是宿主集成方的事）；全量 transcript 快照/归档（只快照被引用片段）；promote 时回读宿主 transcript 复核（快照即权威副本）。

**并**（复用既有机制）：快照写 → K1 sidecar 写原语 + S8 sealed 拒写（`updateSessionKnowledgeSidecar`/`updateKnowledgeLifecycle`）；host_session_id 身份 → K2/K4（已是 ksyn 哈希输入与通道 identity）；stage 入口 → 现有 `maestro knowledge stage --evidence` 面（`commands/knowledge.ts:389`）；review 展示 → 现有 evidence_refs 渲染（`:245-246`）；Pi 适配器 → 现有 sessionManager API（沿 K9 env-only 传统，无 capability probe）。

**延后**：Codex `transcript_path`/Claude 适配器、secret redaction（Phase 2B）、快照 GC/保留策略、evidence 入 receipt 指纹、宿主侧密码学来源证明链（永久观察项）。

**门禁论证（关键）**：
- 主张 A「快照替代 receipt」——**反驳成立**：receipt 是新鲜性证明（candidate_snapshot_hash + corpus_fingerprint），快照只是证据内容冻结，守的是「锚点失效」窗口，对语料状态与候选变更零发言权；替代即拆掉唯一新鲜性栅栏，违反 S2 等强度。
- 主张 B「transcript 锚点能通过双源门禁」——**成立且平凡成立**：门禁从不评估证据质量（铁律 10），信任由 sealed + receipt + 人工 review `--reason` 承担；E5 事实（快照哈希不含 evidence_refs）意味着追加锚点不使 receipt 失效——对资格判定无害，属明示接受项。

### 3.3 分歧裁决（主 agent 收敛）

| 分歧 | GPT | qwen | 裁决 |
|---|---|---|---|
| 证据集是否纳入 receipt 指纹 | P0 必需（reconciliation v1.1 加 `evidence_snapshot_hash`） | 明示接受项，延后二期 | **MVP 不入**（不参与资格判定，qwen 论证成立）；**二期硬化**入指纹 + provenance 汇总（GPT 防「promote 后证据被换」的审计完整性问题，非资格问题） |
| 锚点格式 | 胶囊 `ev:EVR-...` + sidecar | URI 字符串进 string[] | **统一**：`evidence_refs` 存 URI 字符串（零 schema 改动、run delta 字节不动），快照明细落 sidecar |
| transcript 可信度 | P0：默认 review_required | 隐含接受（门禁不管证据质量） | **采纳 GPT**：新增可信度门，明确写在机制里 |

---

## 4. 收敛方案 v3

### 4.1 三层架构

```
治理骨架（不变）：Session = 治理挂载点；sealed + 新鲜 receipt + evidence 非空 双源门禁原样
身份层（复用） ：窗口会话 → ksyn/通道（K2/K3/K4 现成）；host_session_id 仅映射键
证据层（新增） ：锚点 URI + stage 快照 + untrusted 隔离边界（K12-K16）
```

### 4.2 机制清单（K12-K16，全部加性、零迁移）

| # | 机制 | 职责 | 复用点 |
|---|---|---|---|
| K12 | **transcript 锚点 URI 字符串** | `transcript:<hostKind>:<hostSessionId>:<entryId>:<sha256片段[:16]>` 追加进现有 `evidence_refs: string[]`；零 schema 改动，解析仅用于展示 | E1 原样，run delta v1.0 字节不动 |
| K13 | **stage 时片段快照** | stage 新增片段 descriptor 文件输入（JSON：host_session_id/entry_id/quote；原始片段不得进进程列表）；CLI 对 quote 原始字节 sha256、按 `quote-sha256 + locator-sha16` 写 `sessions/<sid>/transcript-evidence/<quote-sha256>-<locator-sha16>.json`（单片段 32 KiB 上限/硬上限 64 KiB；规范化 UTF-8-LF-NFC 后验 hash）；同 quote+locator 幂等、同 quote 不同窗口分别保存；K12 URI 追加进 evidence_refs | K1 事务 + S8 sealed 拒写（`updateSessionKnowledgeSidecar`/`updateKnowledgeLifecycle`） |
| K14 | **Pi 宿主提取器（插件侧）** | 进程内从 `ctx.sessionManager.getBranch()` 取 entry id + 文本、截断至上限、组装 K13 输入并经既有 knowledge stage 面提交；CLI 无宿主代码 | E8，沿 K9 env-only/进程内极简传统 |
| K15 | **铁律 10 约束（以不构建为主）** | 快照 = 只读不透明展示物：不进注入、不进 search/index、不被 LLM 消费；review 展示一律 untrusted 标记；负向测试钉死边界 | 铁律 10 |
| K16 | **review 锚点解析展示** | `evidence_refs` 中 transcript URI 只渲染「快照在/失」+ entry_id + untrusted 标记；**不输出 quote 内容**，避免普通 review stdout 进入 LLM 工具上下文 | E10 复用现有渲染位（`commands/knowledge.ts:245-246`） |

### 4.3 数据流

```
Pi 窗口会话（进程内提取 entry+quote）        Codex/Claude（二期适配器）
        │ K14                                      │（同 stage 输入 JSON）
        ▼                                          ▼
maestro knowledge stage --evidence transcript:...（片段经私有临时 descriptor 文件）
        │ K13：快照 sessions/<sid>/transcript-evidence/<quote-sha256>-<locator-sha16>.json（K1 事务 + sealed 拒写）
        ▼
session delta knowledge-delta.json（evidence_refs 追加 URI）
        ▼
review（K16 展示快照在/失 + untrusted）→ 可信度门（K17，见 §5）→ promote（双源门禁不变）
        ▼
.workflow/specs|knowhow（正文带 transcript URI 溯源；快照不进 corpus/index）
```

### 4.4 可信度门（K17，采纳 GPT 补强）

- 仅由 assistant/tool/advisor/transcript 支撑的候选默认 `review_required`。
- 不得被 `promote --all`（unique/eligible 自动路径）晋升。
- 升级路径：显式人工 `--reason`，或独立机器工件/验证器把 `verification` 升为 `human_attested|machine_verified`。
- 语义澄清：sealed + fresh receipt 证明「候选对语料对账过」，**不证明候选为真**——可信度门补的就是这一环。

### 4.5 铁律 10 强化（K15 执行语义）

- transcript 哈希只能证明「快照自 capture 后未变」，不证明宿主文件在 capture 前真实、陈述正确或上下文完整。
- transcript/advisor/tool/hook 片段保持 untrusted：禁止进 system prompt、自动索引、模型指令上下文。
- 显式 `knowledge evidence show <EVR>` 才展示已转义（escape）内容；UI 来源标记。
- advisor 结论仍只能生成线索候选。

---

## 5. MVP 三阶段实施（qwen 切法 + GPT 安全补强）

### P1 — CLI 证据底座（K12 + K13 + K16 最小版）

**改动**：stage 片段输入选项 + 内容寻址快照 + URI 追加 + review URI 解析展示。

**验收**：
- [ ] session 源带 transcript 锚点 stage 成功，快照文件存在且文件名 sha256 与 URI 尾段一致
- [ ] 同 quote 二次 stage 幂等复用（同一快照文件、evidence 去重）
- [ ] sealed session 拒写快照与 delta（S8）
- [ ] run delta v1.0 字节级回归绿（含 `--run` 显式路径逐字节一致）
- [ ] 超上限片段拒收（无静默截断）
- [ ] review 输出渲染快照在/失 + untrusted 标记

### P2 — Pi 闭环（K14 + 可信度门）

**改动**：插件从 sessionManager 提取 entry+quote、组装 stage 输入、走既有 knowledge 面；transcript-only 候选默认 review_required。

**验收**：
- [ ] Pi 窗口会话 → transcript 锚点 stage → session seal → review --refresh → promote 全链绿
- [ ] 被 promote 条目语料 description 携带 transcript URI（沿用 `knowledge.ts:906` 现成路径）
- [ ] transcript-only unique 候选不被 `--all` 自动晋升；显式人工 `--reason` 或独立验证升级后才可 promote
- [ ] 新CLI×旧插件退化：无 transcript 证据、行为同现状（K9 env-only 模式）
- [ ] 串会话用例：A run + B 闲聊 stage transcript 锚点，归属各绑各的（K3 回归）

### P3 — 硬化与回归（K15 + 兼容矩阵）

**改动**：铁律 10 边界负向测试 + 双组合回归 + 二期入口条件落文档。

**验收**：
- [ ] 负向测试：快照内容不出现在注入/search/index/任何 LLM 上下文路径（grep 级 + 单测断言 review 展示带 untrusted 标记）
- [ ] 敏感词搜索零命中（只存在于 transcript 片段的敏感/指令词不能命中）
- [ ] run 源 V1-V11 全绿零迁移；新×新 session-only full-cycle 绿；新×旧退化不崩
- [ ] 崩溃恢复：blob/manifest/candidate 三个写点注入崩溃，重试后零晋升或 exact-once 晋升且 provenance 完整
- [ ] 文档更新：K12-K17 追加进 decoupling-mvp 机制清单与升级路径表

---

## 6. 明示接受的风险（不新增防御）

| # | 风险 | 接受理由 |
|---|---|---|
| 1 | 快照≠宿主真相：哈希只绑定 quote 字节，不证明宿主真说过 | Pi 直读 sessionManager 有界；手工 quote 本就 untrusted，晋升靠可信度门 + 人工 review 兜底 |
| 2 | 隐私驻留：quote 可能含 secret，快照持久在 .workflow | stage 是显式动作（用户自选片段）+ 32 KiB 上限；redaction 二期（Phase 2B） |
| 3 | receipt 不为证据集背书（MVP） | evidence 不参与 disposition/资格判定；二期指纹化（reconciliation v1.1）补上 |
| 4 | 存储增长无上限计数 | 内容寻址幂等去重 + 片段上限缓解；GC 延后（随 session 归档顺带清理） |
| 5 | 宿主文件演化：被引用消息离开活跃上下文 | 快照在 stage 时已完成，锚点价值恰在于此 |

---

## 7. 二期入口条件（触发才做，纯增量）

| 延后项 | 重新引入条件 | 增量方式 |
|---|---|---|
| Codex `transcript_path` / Claude 适配器 | P2 闭环验证后 | 同一 stage 输入 JSON 的新生产者；逐 adapter 出统一 envelope + capability 声明（native ID/branch/timestamp/path stability/compact 行为） |
| secret redaction 管线 | 快照进入任何注入/索引/LLM 消费路径（self-evolution-plugin-design.md Phase 2B） | 预览 + 策略版本 + 权限 + 删除路径（tombstone 不静默断链） |
| evidence 入 receipt 指纹 | MVP 数据量出现证据链审计诉求 | `knowledge-reconciliation/1.1` 加 `evidence_snapshot_hash`（排序 EVR 清单 + manifest/blob digest）；任何增删改/脱敏重写令 receipt stale 并失效人工 resolution |
| 跨源 provenance 汇总 | 同 candidate ID 跨 run/session 时证据丢失 | promote-only `knowledge-provenance/1.0` sidecar 汇总全部已过门禁的 evidence roots（现 `knowledge.ts:1065` 只保留代表副本） |
| 快照 GC/保留策略 | 存储增长实证 | 引用生命周期 + 显式策略：rejected 30 天、promoted 至 superseded 后再 180 天、零引用 mark-and-sweep 7 天 grace；不以低使用量修剪知识 |
| 宿主侧密码学来源证明链 | 永久观察项（与已砍谱系指纹同类） | 不引入 |

---

## 8. 兼容性与回滚

- **run delta v1.0 字节级不动**（S1 保持）：URI 是普通字符串，run 源候选可携带但不要求；无存量迁移、无门禁分支变化。
- **旧 CLI 防线**：MVP 用 env-only 注入（K9 传统），旧 CLI 忽略 env 无害；后续若加 run-origin transcript 需新 schema/capability probe，不得让旧 CLI 忽略证据门后继续 promote。
- **身份铁律保持**：`host_session_id` 只作 locator/mapping，任何值都不能成为 `.workflow/sessions/<sid>` 目录名；A/B/C 写授权与 channel TTL 行为不变。
- **语料唯一写通道保持**：`.workflow/specs|knowhow` 仍只经 promote；快照/胶囊不是 corpus。
- **回滚**：删除 `transcript-evidence/` 目录与 URI 引用即恢复原状（run/session 路径从未改动）。

---

## 9. 术语表

| 术语 | 定义 |
|---|---|
| transcript 锚点 URI | `transcript:<hostKind>:<hostSid>:<entryId>:<sha256片段[:16]>`——穿透现有 string[] 的轻量引用 |
| 证据快照 | stage 时对选中对话片段的 quote-hash + locator-hash 副本（`sessions/<sid>/transcript-evidence/<quote-sha256>-<locator-sha16>.json`），宿主文件失效后的权威副本 |
| 可信度门（K17） | transcript-only 候选默认 `review_required`，禁 `--all` 自动晋升；人工 `--reason` 或独立验证升级 |
| 证据胶囊（二期） | `knowledge-evidence/1.0` sidecar：结构化 locator/trust/redaction 明细，URI 的解析端 |
| provenance sidecar（二期） | promote-only `knowledge-provenance/1.0`：跨源 evidence roots 汇总，search/load 默认不索引不注入 |

---

## 10. 实施落地记录（2026-08 多 agent 实施）

### 10.1 已实现与验证（P1/P2 完成，P3 核心边界完成）

| 机制 | 实现位置 | 验证 |
|---|---|---|
| K12 anchor URI | `maestro2/src/run/transcript-evidence.ts`（buildTranscriptUri/parseTranscriptUri；host/entry 字段拒绝冒号与控制字符；sha256 严格校验） | 新测试 21 绿（含往返/非法字段） |
| K13 片段快照 | 同上（storeTranscriptEvidence：SessionStore 事务 + S8 sealed 拒写 + 32KiB/64KiB 上限 + 幂等去重 + 内容寻址 + 复用时完整性复验） | 超限拒收/幂等/拒写/完整性测试绿 |
| K16 review 渲染 | `maestro2/src/commands/knowledge.ts` printKnowledgeReview（快照在/失 + entry_id + [untrusted]；**不输出 quote 正文**） | render 无 quote 泄漏测试绿 |
| K17 可信度门 | `maestro2/src/run/knowledge.ts`（isTranscriptOnlyEvidenceRefs/hasConfirmedHumanResolution）+ `src/knowledge/reconcile.ts`（disposition 降级）+ `commands/knowledge.ts`（--transcript-quote） | eligible+null receipt 伪造被拦；不完整 confirmed 被 schema 拒绝；V11 阻断门语义保持 |
| K14 提取器与生产入口 | `pi-maestro-flow/.../knowledge/extractor.ts`（最新原始 message 优先、compaction/branch_summary 仅回退 + 去重 + 32KiB 截断 + bindTranscriptEvidence 正文/证据分离）+ `cli-adapter.ts` 临时文件透传 + `/maestro-knowledge-from-window` 生产命令 | 插件侧 47 测试绿 + tsc 通过 |
| K15 铁律 10 边界 | `maestro2/src/run/transcript-evidence.test.ts` 负向断言（注入正则/搜索 scope 排除）+ K16 无 quote stdout | 21 绿 |

### 10.2 回归结论

- **V1-V11 全链回归**：PASS=61 FAIL=5 —— 与基线（stash 后）完全一致；5 个失败为既有环境问题（V8 legacy 撞名 BLOCKED 自标注、V7 谱系、Windows NATIVE_ERROR），**与 K12-K17 零相关**。
- **知识相关测试**（knowledge/pi-knowledge-absolute/knowhow-lifecycle/relevance-evaluator/spec-injector/wiki-live/store-durability 7 文件单线程）：改动后 2 失败/140 通过 = 基线一致，零回归。
- **加固后聚焦测试**：maestro2 73/73；插件 47/47；双仓 typecheck 通过。

### 10.3 生产挂接与二期状态

- K14 已经通过独立生产命令 `/maestro-knowledge-from-window <spec|knowhow> <title> <content>` 接线：用户显式提供提炼后的 candidate content；当前 Pi 窗口 `sessionManager.getBranch()` → extractTranscriptQuote → bindTranscriptEvidence（正文/quote 分离）→ adapter 临时文件 → CLI `--transcript-quote` → session/run 知识管线。raw quote 仅进入 evidence snapshot，不进入 candidate content、普通 review 或 corpus。现有 `/maestro-knowledge-stage` 三参数契约未修改。
- 二期入口条件不变：Codex/Claude 适配器、redaction（Phase 2B）、evidence 入 receipt 指纹（reconciliation v1.1）、跨源 provenance 汇总、快照 GC。
- 明示接受风险保持（§6）：快照≠宿主真相、隐私驻留、receipt 不为证据背书（MVP）。

### 10.4 GPT 最终 review 裁决与残余项

- **已修复**：K14 生产挂接与 candidate content / raw quote 分离；普通 review 不再输出 quote（铁律 10）；URI host/entry 严格校验；snapshot 幂等复用增加 normalized hash/host 元数据复验；confirmed resolution 增加结构完整性检查。
- **MVP 信任边界（明确接受）**：本地 actor 若能直接改写 reconciliation receipt，可伪造完整 `confirmed` resolution；该 actor 同样可直接改 `.workflow/specs|knowhow`，属于 corpus 文件写权限边界外。测试固定该行为，未来 receipt v1.1 以 actor/attestation/evidence hash 绑定收紧。
- **K17 当前范围**：仅对 transcript-only evidence 自动降级；只要候选附加任意非 transcript ref（包括未验证的 file:line 字符串）就会退出该分类，这是 string[] MVP 的明确接受风险。staging 方本就控制候选正文与 refs，本门只防自动化误晋升，不防恶意 stager；普通 file:line 证据质量仍沿用现有人工 review 语义。assistant/tool/advisor 的结构化 trust class 与证据真实性门禁属于二期 `knowledge-evidence/1.0` 胶囊。
- **P3 尚未全部完成**：snapshot 与 candidate 仍为两个事务，崩溃中点可能留下无引用 orphan blob（无活跃知识污染，交由二期 GC）；尚未执行真实旧 CLI×新插件矩阵；`knowledge-session-decoupling-mvp.md` 的 K12-K17 同步待治理确认后再做。

*本文档为 v3 收敛稿；机制编号 K12-K17 承接 `knowledge-session-decoupling-mvp.md` 的 K1-K11；双模型评审原始输出（structured_output）可回溯至 2026-08 双模型并行评审记录。*
