# 知识沉淀与 Run 解耦规划：Session 级知识治理（v2.1 修订稿）

> 状态：v2.1 —— v2 依据 GPT（gpt-5.6-sol）架构评审修订（4×P0/4×P1/2×P2 全采纳，附录 A）；v2.1 依据 qwen3.8-max-preview 独立**复杂度交叉审计**增补 **MVP-cut 精简实施路径（§6A，推荐执行路径）**——完整版 D1-D10/Phase 1-5 保留为目标态参照
> 关联：`docs/self-evolution-plugin-design.md`（v2/v3，evol 机制设计）、`docs/session-run-knowledge-target-architecture.md`（目标态总纲，最终态不因精简而变）
> 涉及仓库：`maestro2`（maestro-flow CLI，知识生命周期命令面）、`pi-maestro-flow`（Pi 插件，lease/UI/self-evolve 扩展）

---

## 1. 背景与问题

### 1.1 实测诊断（2026-08-06）

对当前 evol/self-evolve 机制的完整分析确认了三个事实：

1. **治理管道产量极低**：`maestro knowledge audit` → 81 条候选滞留 pending、0 corroborated、全库仅 2 条 promoted；`approvals/` 审批记录全部是 e2e 测试产物——上线以来真实"审核→晋升"完成次数为零。
2. **不受治理的旁路在自动批量入库**：compaction checkpoint（`pi-maestro-flow/src/compaction/maestro-compaction.ts:928` 附近）每次压缩以 `status: active` 直写 `.workflow/knowhow/KNW-*-session-compact-*.md`，不经 stage/review/promote。
3. **消费侧与沉淀侧绑定不对称**：系统提示词 Knowledge Gate 要求每次任务先 `maestro search`（锚定在任务/会话时刻）；`maestro load` 先写全局 KG 消费账本（`maestro2/src/graph/kg/knowledge-usage.ts:14`，与 run 无关），run 归因只是 best-effort 附加（无活跃 run 静默返回 null）。**消费已解耦，沉淀仍强绑 run。**

### 1.2 强绑 run 的直接后果

- 不走 run/session 的日常会话**零受治理沉淀**（stage/record fail-closed："No unique active Run found"）。
- 审核时机被 run 生命周期绑架（评审须在 run seal 前、晋升须在 seal 后），错过 seal 瞬间的一次性 notify 后几乎无感知通道。
- self-evolve 扩展采集的信号（任何 pi 会话都采）转化时必须 `stage --run`，无 run 连手动转化都做不到。

### 1.3 结论

Run 对知识治理的真实贡献只有两点：

| 贡献 | 可替代性 |
|---|---|
| 不可变性保证（sealed run = 证据冻结） | sealed 只冻结 delta，**不能替代 corpus reconciliation**；需要"不可变 + 新鲜 receipt"双重保证（评审 P0-3，见 D4） |
| 事实声明面（report.md frontmatter 由 run 执行者声明，T1 自动草拟） | **run 不可替代**，保留绑定 |

其余绑定（sidecar 存储位置、入口 fail-closed、run_ids eligibility）均为实现细节，可拆除。本规划把知识沉淀的锚点从 run 迁移到 session，run 降格为"候选来源之一"。

---

## 2. 现状绑定点地图（实测证据，行号以 maestro2 源码为准）

| # | 绑定点 | 位置 | 性质 | 处置 |
|---|---|---|---|---|
| B1 | stage/record 入口要求活跃 run，无则 throw | `maestro2/src/commands/knowledge.ts` | 行政门禁 | **改造**：双模 + 分级解析（D2） |
| B2 | 候选/归因物理存储在 run 目录：`sessions/<sid>/runs/<rid>/knowledge-delta.json`，经 `updateActiveRunSidecar` 写入（sealed run 拒写） | `maestro2/src/run/knowledge.ts:72`（`runKnowledgeDeltaPath`）、`store.ts:593` | 结构性，最深绑定 | **改造**：新增独立 session delta（D1） |
| B3 | evidence 自动嵌入 `run:<runId>`，`run_ids` 决定候选出身、receipt 签发、resolve 与 promote 写回 | `run/knowledge.ts`（summary :74 / promote 写回 :985,:1036）、`knowledge/reconcile.ts:827` | 溯源 + 事务模型 | **重构**：统一 source_refs（D10） |
| B4 | promote 门禁：所有 `run_ids` 必须 sealed + 每源 receipt + receipt 新鲜（三者同时） | `run/knowledge.ts:915`；CLI 入口先刷新 reconciliation（`commands/knowledge.ts:465`） | 治理门 | **扩展**：双源门禁，session 源等价双重保证（D4） |
| B5 | reconciliation receipt 按 source run 签发，冻结 candidate snapshot + corpus fingerprint | `maestro2/src/knowledge/reconcile.ts:611,628,739,805` | 治理门 | **扩展**：session 级 receipt |
| B6 | T1 自动草拟发生在 `session done <run-id>` seal 事务 | `maestro2/src/run/runtime.ts:2905` | run 本质属性 | **保留不动** |
| B7 | review/promote 命名空间 = session（`summarizeSessionKnowledge` 聚合 run delta） | `run/knowledge.ts` | 组织单位 | **扩展**：聚合层并入 session delta |
| B8 | `sealSession` 对知识零动作（只校验 run 全 sealed + 只读 summarize） | `run/runtime.ts:2341` | — | **增强**：seal 时刷新 session receipt，失败不阻断 seal 但阻断 promote（D5） |
| B9 | 旁路：compaction checkpoint 直写 active knowhow；load 全局账本 | 插件 `compaction/maestro-compaction.ts:928`；CLI `graph/kg/knowledge-usage.ts` | 治理盲区/解耦先例 | checkpoint 收编为 recovery-only + 治理候选（P4，评审 P1-8） |

**会话关联现状**：

- `findUniqueActiveRun()`（`maestro2/src/run/store.ts:719`）= 全盘扫描 `status==='running' && active_run_id` 的 session，恰好 1 个才返回；0/多 → null → throw。不读 `state.json`、不知道"当前是哪个窗口"。多 running session 仅一个有 run 时存在**错绑风险**；多 active run 时 load 归因**静默丢弃**。
- 插件已有精确绑定：`WorkflowLeaseStore`（`pi-maestro-flow/src/session/coordinator.ts:96,247,418`）`acquire(sessionId, hostSessionId)` + 10s 心跳 + 30s stale（落盘 `.workflow/tmp/hook/<sid>.lease/<epoch>.claim.json`）——但只服务 run-control 变更所有权，**知识管道未消费**。
- `--signal-ids` 是归因参数（既有知识 ID × consumed/cited/validated/contradicted），与会话关联正交；当前**无 ID 存在性校验**，typo/幻觉 ID 静默入账并污染 health contest queue。
- `self-evolve-health.mjs` 递归扫描全部 `knowledge-delta.json`（inputs 会被自动读到），但候选聚合把缺失 run_id 的来源记为 `"?"`（`self-evolve-health.mjs:134`）——session delta 接入时必须修复。

---

## 3. 设计目标与非目标

### 目标

1. **无 run 也能受治理地沉淀**：session-only 场景（日常对话、companion 轻任务、self-evolve 信号转化）可 stage/record/review/promote。治理 Session 的创建规则见 D1（synthetic knowledge session）。
2. **会话关联精确化**："当前宿主对话 attached 的 session"成为一等解析源；**写操作的归属只接受显式参数、fenced lease、宿主注入通道三类权威身份**（评审 P0-2）。
3. **审核时机解放**：review 不再等 run check 窗口；session 存续期内随时可审，并提供主动提醒。
4. **信号质量硬化**：signal-id 写入前校验存在性。
5. **向后兼容**：存量 run 源候选（81 pending）与既有门禁语义不变；**run delta schema 字节级不动**（评审 P1-5）；无数据迁移。

### 非目标

- 不改 T1 frontmatter 自动草拟（B6 保留 run 绑定）。
- 不引入全自动晋升策略变更（T2 `--all` 语义不变，只是覆盖双源）。
- 不改 knowledge store 本体（`.workflow/specs|knowhow` 写入仍只经 promote）。
- 不处理 global scope 条目（仍属不可自动改清单）。
- **谱系指纹不作为写操作的归属授权**（评审 P0-2，见 D3）。

---

## 4. 核心设计决策（v2）

| ID | 决策 | 理由 |
|---|---|---|
| D1 | **新增独立 schema `session-knowledge-delta/1.0`**：`sessions/<sid>/knowledge-delta.json`；run delta v1.0（strict schema）字节与语义完全不动。无治理 Session 的日常会话：由 CLI 在首次 stage/record 时**幂等创建 synthetic knowledge session**（固定 ID 规则 `ksyn-<hash(host+project+date)>` 或显式命名，定义 seal/abandon/恢复/清理与 host→session 映射）；不采用"pi hostSessionId 直接当 session 目录权威" | run delta strict() 且无 migration 先例（`store.ts:1137` 直接 parse），动它即破坏旧 CLI（评审 P0-1/P1-5） |
| D2 | stage/record 双模 + 分级解析：① 显式 `--run`/`--session`/`--channel`；② 权威身份解析（D3 三来源）→ lease/channel 映射；③ **扫描兜底仅在"全 workspace 恰好一个 running session 且无任何 live channel"时使用**；④ 否则 fail-closed，报错列出存活通道供 `--channel` 选择。load 归因在无法归属时成功返回但跳过归因并 warning | 评审 P0-2：唯一扫描在"A 有 run、B 闲聊且 B 身份获取失败"时仍会错绑 A，必须收窄 |
| D3 | **调用方身份三来源（跨平台），指纹仅限候选匹配**：① 显式注入——Pi 插件 `session_start` 写 `process.env.PI_HOST_SESSION_ID`；任意宿主可设 `MAESTRO_CHANNEL` env 或传 `--channel <name>`；② hook 注册——Claude Code/Codex/Agy 的 hook stdin 载荷携带 `session_id`（`maestro2/src/commands/hooks.ts:869` 已解析；coordinator-tracker 桥接文件先例 `hooks/coordinator-tracker.ts:489`），hook 层写通道并附 hook 进程谱系指纹；③ 进程谱系指纹——**只产生候选匹配，不单独授权写操作**；无唯一高置信匹配即 fail-closed | Pi 有插件；Claude/Codex/Agy 有 hook 协议（Codex 官方已核实载荷含 session_id）；纯终端靠指纹候选 + 显式确认 |
| D4 | **promote 双源门禁（等价双重保证）**：run 源 = sealed run + receipt + receipt 新鲜（不变）；session 源 = **session delta 不可变（sealed 或带 candidate snapshot revision 的显式 freeze）AND 新鲜 session corpus receipt**——receipt 始终必需，sealed 不能替代。`--evidence` 对 session 源强制非空 | 评审 P0-3：sealed 只冻结 delta，不能证明候选已对当前 corpus reconcile；"sealed 或 receipt"二选一弱于既有 run 门禁 |
| D5 | `sealSession` 增强：seal 事务尾部刷新 session receipt；**刷新失败不阻断 session seal，但留下 missing receipt，使 promote fail-closed 直到 `review --refresh` 补齐** | seal 是用户动作不应被 sidecar 卡死，但治理门必须闭合（评审 P0-3 配套） |
| D6 | signal-id 写入前按 wiki 索引校验存在性（含 canonical/alias resolver、scope 与索引陈旧处理）；未知 ID 默认拒收；`--allow-unknown` 逃生口写**独立 validation sidecar**（记录 actor/reason/原始 ID/resolver revision），不动既有 strict schema | 阻断幽灵 ID 污染 contest queue；兼容约束来自评审 P1-5/P2-9 |
| D7 | review_required（T3）裁决语义完全不变；`--all` 双源通用，skipped_review_required 语义不变 | 幻觉防线不放宽 |
| D8 | **发布兼容协议（评审建议新增）**：run delta 保持 `run-knowledge-delta/1.0` 不动；session delta 为全新文件族；发布前测试四象限（旧CLI×旧插件 / 旧CLI×新插件 / 新CLI×旧插件 / 新CLI×新插件）；插件注入 `--host-session`/env 前先 capability probe（旧 CLI 对未识别参数会报错，env 则被忽略） | 评审 P1-5：schema strict() 无 migration 先例，版本错配窗口必须显式管理 |
| D9 | **临时通道（双路建立，分宿主存活策略）**：通道文件 `.workflow/tmp/channels/<identity>.channel.json`，记录 `{identity, hostKind, context:{kind, sessionId, runId?}, fingerprint, workspaceId, revision, createdAt, expiresAt, lastSeenAt}`。建立路径 A：hook 宿主由 hook 事件（SessionStart/PreToolUse）携带 `session_id` 注册，存活依据心跳 + 进程启动标识；路径 B：无 hook 宿主由 `maestro search`/`load` 以谱系指纹自注册**候选通道**，存活依据祖先进程存活探测 + 较长 idle cap；manual channel 不参与唯一通道推断。写并发用 SessionStoreLock 或 append-only epoch claim + CAS；**通道失败只影响治理写的归属判定（fail-closed），绝不阻断 search/load 正文读取** | 评审 P1-6：固定 TTL 会误杀长任务；lease 的 pending+link 是不可变 epoch claim，heartbeat 用 pending+rename，语义不同不可照搬；同 identity 同路径时"物理不可能串写"不成立，需 revision/CAS |
| D10 | **统一来源模型 source_refs（评审 P0-4）**：候选来源从 `run_ids: string[]` 升级为 `source_refs: [{kind:'run'\|'session', id, evidence_root}]`（仅新 session delta 与聚合结果层使用；run delta 内部字段不动，聚合时派生）。receipt 签发、freshness 校验、resolve、promotion intent 与完成状态写回、恢复式 promotion 全部按 source ref 分派。corroboration 统计**独立证据根**，排除同一 Maestro Session 内 run/session 重复副本；run 与 session 出现同一 candidate ID 时按来源分账，不合并门禁 | 现 summary/reconcile/resolve/promote 全链以 run_ids 为事务模型（`knowledge.ts:74,985,1036`、`reconcile.ts:827`），仅加聚合不重写回事务会让 session-only 候选无法签 receipt/resolve/持久化 promoted 状态 |

### 4.1 反串会话设计（多平台 × 多会话并发）

串会话的根因是**调用方身份缺失**：每次 maestro CLI 调用都是新进程，`findUniqueActiveRun()` 只能靠全盘扫描猜。maestro-flow 是多平台 CLI（Pi 插件 / Claude Code hooks / Codex hooks / Agy hooks / 纯终端），身份机制必须跨平台。

**写授权分级（评审 P0-2 收敛）**：

| 级别 | 身份来源 | 可否授权写（stage/record） |
|---|---|---|
| A | 显式参数 `--run`/`--session`/`--channel` | ✅ |
| A | fenced lease（epoch token 校验 + 心跳未 stale） | ✅ |
| A | 宿主直接注入通道（Pi env / hook 注册 channel） | ✅ |
| B | 谱系指纹候选匹配（唯一且高置信） | ⚠️ 仅建议：写前需 channel 已存在或交互式确认；不得单独创建写通道 |
| C | 唯一扫描（恰一 running session 且零 live channel） | ⚠️ 兜底，附 warning |
| — | 其余情形 | ❌ fail-closed，列出存活通道 |

**身份来源与平台覆盖**：

| 平台 | 宿主会话 ID 来源 | 通道建立路径 |
|---|---|---|
| Pi | 插件注入 env `PI_HOST_SESSION_ID`（`ctx.sessionManager.getSessionId()`） | env → lease 反查（attached）/ 通道 |
| Claude Code | hook stdin 载荷 `session_id`（hooks.ts:869 已解析；coordinator-tracker 桥接文件先例） | hook 注册（SessionStart/PreToolUse）+ 谱系指纹候选 |
| Codex CLI | **官方已核实**：Codex hooks 同步调 shell 命令，stdin JSON 载荷含 `session_id`（uuid）、`transcript_path`、`cwd`、`hook_event_name`（源：developers.openai.com/codex/hooks + codex-rs `hooks/src/events/pre_tool_use.rs` `PreToolUseRequest.session_id: ThreadId`）；本机实测已安装 maestro Codex hooks（`~/.codex/hooks.json` + config.toml `hooks.state`） | 与 Claude Code 同构 |
| Agy | maestro 第三个 hook 宿主（`AGY_HOOK_DEFS`，hooks.ts:501） | 同上 |
| 其余宿主（Cursor/Windsurf/CI/纯终端等） | 无宿主侧 ID | 三级回退链（见下） |

**三家之外的回退链（零宿主支持也能工作）**：

1. **谱系指纹自注册（默认回退，零配置）**：CLI 懒计算谱系指纹，首次 `search`/`load` 自注册**候选**通道；后续治理写需按上表 B 级确认，不自动升格。
2. **显式声明（确定性需求）**：`--channel <name>` 或 `MAESTRO_CHANNEL` env——人工终端、shell profile、CI/wrapper；未来新宿主的一行式接入点。
3. **唯一扫描兜底（收窄后）**：仅"恰一 running session 且零 live channel"时使用，附 warning；否则 fail-closed。

任何一级失败都不阻断知识读取（search/load 正文），只影响治理写的归属判定。

**谱系指纹实现约束（评审 OQ-5 推荐）**：指纹取"最近稳定祖先的结构化元组"（pid+启动时间+可执行路径）而非整条链 hash；Windows 用一次性、超时受控的 PowerShell CIM 批量取 `ParentProcessId/CreationDate/ExecutablePath`（tasklist 信息不足）；Git Bash/tmux 场景同时采集 tty、`TMUX_PANE`、workspace ID；先做三平台双窗口并发原型实测再定稿。

| 场景 | 现状行为 | v2 机制行为 |
|---|---|---|
| 两 Pi 窗口各跑 run | 扫描非唯一 → throw | env→lease，各自精确绑定 ✅ |
| A 跑 run，B 闲聊 | B 的 stage **错绑到 A 的 run** | B 走自己的通道（session-only）；B 身份获取失败 → fail-closed，**不再回落错绑 A**（评审 P0-2）✅ |
| 两 Claude Code 窗口并发 | 同上扫描问题 | 各自 hook 注册独立通道（cc_session_id 隔离）✅ |
| Pi + Claude 混合并发 | 扫描问题 | 不同身份源各自通道；指纹仅候选 ✅ |
| 纯终端人工操作 | 唯一扫描 | 指纹候选通道 + 显式确认，或 `--channel` 声明 ✅ |
| 两窗口同一 maestro session | 第二窗口抢 lease | delta 写入有 `SessionStoreLock`（`store.ts:241`，workspace 级锁 + Windows 重试）保护 ✅ |
| teammate 子代理知识操作 | 同主扫描逻辑 | 继承根进程 env/谱系 → 归因自动落主会话 ✅ |
| load 归因多 run 场景 | **静默丢弃** | 通道路由；无法归属时跳过归因 + warning，不静默 ✅ |

### 4.2 现有消费方影响回归矩阵（评审 P1-7）

session delta 与 source_refs 引入后，以下消费方必须逐一回归并明确语义：

| 消费方 | 位置 | 影响与处置 |
|---|---|---|
| `summarizeSessionKnowledge` | `run/knowledge.ts` | 双源聚合；对外派生 origin/source_refs |
| reconcile / receipt / resolve / promote 写回 | `knowledge/reconcile.ts`、`run/knowledge.ts` | 按 source ref 分派（D10）；补混合来源、崩溃恢复、重复 candidate ID 测试 |
| `knowledge audit`（ledger/corroboration 统计） | `maestro2/src/knowledge/audit.ts:262` | session 源 ledger 计入方式需定义；corroboration 排除同 session 副本 |
| run brief `knowledge_context` 卡 | `run/runtime.ts:3670` | 明确 session 信号是否计入 run 卡（建议不计入，避免伪造 run 关联） |
| skill-context backlog 注入 | `hooks/skill-context.ts:303` | backlog 计数含 session 源候选 |
| 插件 run/session seal 通知 | 插件 `extension/index.ts:1796`（按 `run_ids.includes` 过滤） | session-only 候选无 run_id → 通知过滤与展示需适配，UI 不得伪造 run ID |
| `KnowledgeCliAdapter` 结果 DTO | 插件 `knowledge/cli-adapter.ts:151`（要求 run_id/run_ids） | DTO 放宽为可选 + origin 字段 |
| `/maestro-knowledge` overlay | 插件 tui | 按源分组展示；无绑定时不再回退"最近修改的 Session"（评审 P0-1 指出的 `index.ts:1977` 行为需收紧） |
| `self-evolve-health.mjs` | 本仓 scripts（`:134` 缺失 run_id 记 `"?"`） | 修复来源归属；session inputs 已能被递归扫描读到 |
| search/load 归因、wiki cache、索引器 | CLI + dashboard wiki-indexer | promote 落盘路径不变，回归确认无行为漂移 |

---

## 5. 变更后数据流

```
任何 pi/claude/codex/agy/纯终端 会话（无需 run）
   │  身份三来源（D3）：Pi env / hook 注册（载荷 session_id）/ 谱系指纹候选
   │  写授权分级：显式参数 / fenced lease / 宿主注入通道 = A 级
   │              指纹候选 = B 级（需确认）；收窄扫描 = C 级；其余 fail-closed
   ▼
sessions/<sid>/knowledge-delta.json（session-knowledge-delta/1.0，新）
sessions/<sid>/runs/<rid>/knowledge-delta.json（v1.0 字节不动，T1 草拟仍在此）
   │  summarizeSessionKnowledge 双源聚合 → source_refs（D10）
   ▼
maestro knowledge review <sid>            ← 时机解放：session 存续期内随时
   ▼
maestro knowledge promote <sid>           ← 双源门禁（D4，均为双重保证）：
   │     run 源：sealed run + receipt + 新鲜（不变）
   │     session 源：delta 不可变 AND 新鲜 session corpus receipt + evidence 强制
   ▼
.workflow/specs|knowhow → 索引器 mtime → 未来 search 命中（反馈通道不变）
```

---

## 6. 分阶段实施计划（v2）

### Phase 1 — CLI：session delta + 双模入口 + 身份/通道 + signal-id 校验（maestro2）

**改动**
- `src/run/store.ts`：session 级 sidecar 更新函数（镜像 `updateActiveRunSidecar`，校验 session 未 sealed）；lease 读取工具（`.workflow/tmp/hook/*.lease/`，epoch claim + 30s stale）；channel 读写工具（SessionStoreLock/CAS、revision、修剪；失败不阻断读取）；谱系指纹工具（懒计算、单调用缓存、PowerShell CIM、失败降级）。
- `src/run/knowledge.ts`：新增 `session-knowledge-delta/1.0` schema 与 `stageSessionKnowledgeCandidate`/`recordSessionKnowledgeInputs`（origin=session，evidence 强制）；source_refs 派生（run delta 内部不动）；synthetic knowledge session 幂等创建（ID 规则/seal/abandon/清理）。
- `src/commands/knowledge.ts`：双模参数面 + 写授权分级解析（D2）；signal-id 校验 + validation sidecar（D6）。
- `src/commands/search|load`：命中宿主身份时建立/刷新通道（D9）；load 归因改「env→channel→lease」路由，无法归属时 warning 不静默。
- `src/hooks/`：通道注册 hook（SessionStart/PreToolUse 载荷 session_id + hook 谱系指纹），沿用 coordinator-tracker 命名先例。

**验收**
- [ ] 无 run 会话：首次 stage 幂等创建 synthetic session 并落 session delta；sealed session 拒写
- [ ] 写授权矩阵测试：A 级直通；B 级无确认不落盘；"A 有 run + B 闲聊 + B 身份失败"→ B fail-closed 不触碰 A（串会话关键用例）
- [ ] 未知 knowledge-id 默认拒收；`--allow-unknown` 落 validation sidecar
- [ ] 显式 `--run` 行为与现状逐字节一致（run delta v1.0 回归）
- [ ] 指纹原型：Pi/Claude/纯终端三平台各两并发窗口实测报告

### Phase 2 — CLI：promote 双源门禁 + session receipt + source_refs 事务（maestro2）

**改动**
- `src/knowledge/reconcile.ts`：reconciliation 覆盖 session 源（冻结 candidate snapshot + corpus fingerprint，与 run receipt 同构）；session 级 receipt 路径。
- `src/run/knowledge.ts`（promoteSessionKnowledge）：双源门禁（D4 双重保证）；resolve/promotion intent/完成状态写回按 source ref 分派（D10）；恢复式 promotion 双源适配。
- `src/run/runtime.ts`（sealSession）：seal 尾部刷新 session receipt；失败留 missing receipt → promote fail-closed（D5）。

**验收**
- [ ] session 源候选：仅 sealed 无 receipt → promote throw；仅 receipt 未 freeze → throw；双满足 → 成功（与 run 源等强度）
- [ ] receipt stale → throw；review_required 未裁决 → fail-closed（不变）
- [ ] 混合来源（同 candidate ID 出现在 run 与 session）分账正确，corroboration 排除同 session 副本
- [ ] run 源全链回归：`scripts/self-evolve-acceptance.sh` V1-V11 保持全绿

### Phase 3 — 插件：env 注入 + 感知增强（pi-maestro-flow）

**改动**
- `src/extension/index.ts`：`session_start`（含 session 替换路径）写 `process.env.PI_HOST_SESSION_ID` 并预建通道（先 capability probe，D8）；`session_start`/attach 调用 `refreshKnowledgePendingStatus`；插件发起的知识 CLI 调用显式带 `--host-session`（双保险）。
- `src/knowledge/cli-adapter.ts`：DTO 放宽 run_id 可选 + origin 字段。
- `src/tui/self-evolve-overlay.ts` + `/self-evolve` panel：聚合"待进化 inbox"（review_required + 未消费 stage 信号 + health P1）；`/maestro-knowledge` 无绑定时不再回退最近修改 Session。

**验收**
- [ ] 两 Pi 窗口各 attached 不同 session：A 窗口 stage 落 A（lease），B 无 run 落 B 的 synthetic session
- [ ] session_start 有积压时一次性 notify（去重）；无积压静默
- [ ] panel inbox 三段渲染正确；session-only 候选展示不伪造 run ID

### Phase 4 — compaction checkpoint 治理收编（评审 P1-8，纳入本轮）

**方案**：checkpoint 原件迁入 **recovery-only 存储**（compaction 恢复语义不变），不再以 `status: active` 直写 `.workflow/knowhow`；同时向治理面 stage session 源候选，promote 后才生成 active knowhow。**不采用"先 active 入库再 stage"**——入库后 reconciliation 判 exact duplicate 自动 suppress，治理门永久关闭。

**验收**
- [ ] 压缩/恢复全链不变（现有 compaction 测试全绿）
- [ ] 新 checkpoint 在 `/maestro-knowledge` 可见为待审候选；corpus 中不再新增未治理 active 条目

### Phase 5 — 治理层同步 + 消费方回归（跨仓库）

- `.pi/skills/self-evolve/SKILL.md`：dispatch 表（session-only stage/review-signals）、时序铁律修订、signal-id 校验入护栏。
- `scripts/self-evolve-health.mjs`：修复 `:134` 来源 `"?"` 归属；contest queue 语义核对。
- `docs/self-evolution-plugin-design.md`：追加落地记录。
- `scripts/self-evolve-skill-e2e.sh`：新增 session-only full-cycle 用例（synthetic session → stage → review → seal → promote → search 命中）。
- 按 §4.2 回归矩阵逐项勾验（audit/brief 卡/skill-context/通知/overlay/wiki cache）。

**验收**
- [ ] e2e session-only 全链绿；run-based 全链回归绿；§4.2 矩阵全勾

---

## 6A. MVP-cut 精简实施路径（v2.1 新增，交叉审计推荐）

> **独立成文版：`docs/knowledge-session-decoupling-mvp.md`（自包含实施方案，开工以该文档为准）**；本节保留审计摘要供源文档留痕。

> 来源：qwen3.8-max-preview 独立复杂度审计（只读，8 处代码验证）。结论：**本质复杂度 ≈40%，偶然/防御性 ≈60%**；机制数 19→11（压缩 ~42%），Phase 5→3，全部 4 个 P0 安全语义在列。

### 6A.1 砍 / 并 / 延后

**砍（推测性问题或已有替代）**：谱系指纹全套（含 Windows CIM、三平台原型）；通道指纹自注册路径 B；capability probe（改 env-only 注入，旧 CLI 忽略 env 无害）；`--host-session` 标志注入；synthetic session 的 abandon/恢复/清理（日期分区 ID 天然轮换）；D4 freeze 分支（seal-only 更严格）；`evidence_root`/corroboration 独立证据根重统计；四象限中两个旧 CLI 象限。

**并（复用既有机制，审计代码实证）**：通道注册 → 既有 coordinator-tracker 桥接写点（`hooks.ts:1242` 已按 host session_id 写桥接文件）；session receipt 刷新 → sealSession 事务仿 run seal 写法（`runtime.ts:2905-2913` 同构先例）；session sidecar 写 → 既有 `updateKnowledgeLifecycle` 原语（`store.ts:573-585`，~20 行镜像）。

**延后（二期，纯增量升级）**：Phase 4 的 staging 半边（存储隔离本轮照做）；Phase 5 消费方增强（overlay 分组/DTO 放宽/通知适配——审计验证⑦：现状不崩不伪造，属展示增强）；OQ-3 分级门禁；通道 CAS/分 hostKind 存活；唯一随行回归项 = health.mjs `"?"` 归属修复（`self-evolve-health.mjs:137`，1 行）。

**永久否决**：虚拟 run 替代 source 分派（伪造 run.json 污染 sealSession 枚举/summary 计数/通知过滤，`runtime.ts:2345-2351`、`knowledge.ts:505-521`）；"复用最近 running session"捷径（复活 P0-2 串写）。

### 6A.2 机制清单（K1-K11）

| # | 机制 | 对应 |
|---|---|---|
| K1 | `session-knowledge-delta/1.0` 独立 schema + session sidecar 写（sealed session 拒写） | D1 核心 |
| K2 | synthetic session 幂等创建：`ksyn-<hash(host+project+date)>` + host→session 映射；seal 复用 `sealSession` | D1 缩小 |
| K3 | 写授权：显式参数 / fenced lease 反查 / hook 通道 = A 级；收窄扫描（恰一 running + 零 live channel，warning）= C 级；其余 fail-closed 列出存活通道 | D2/D3 缩小 |
| K4 | 通道：hook 注册（并入桥接写点）+ manual `--channel`/`MAESTRO_CHANNEL`；统一 lastSeenAt TTL（取宽，建议 24h）+ hook 事件刷新 | D9 缩小 |
| K5 | 双源门禁：run 源三重不变；session 源 = **sealed + 新鲜 session receipt + evidence 非空**（单分支，比完整版更严格） | D4 缩小 |
| K6 | sealSession 尾部刷 session receipt；失败留 missing → promote fail-closed | D5 原样 |
| K7 | 来源分派：聚合层 `origin` 标签（存储文件即来源）；receipt/resolve/promote 写回按 origin 分派；跨源同 ID 按 `origin+candidate_id` 分账 | D10 缩小 |
| K8 | signal-id 存在性校验（含 alias）+ `--allow-unknown` JSONL 留痕（最小字段集 actor/reason/raw_id/timestamp） | D6 缩小 |
| K9 | 插件 env 注入 `PI_HOST_SESSION_ID`（session_start/替换时重设，env-only，无 probe） | D8 缩小 |
| K10 | compaction 存储隔离：checkpoint 根目录迁 recovery-only（仅翻 status 不够——`spec-loader.ts:331` 只过滤 deprecated，必须物理迁路径，`buildKnowhowPath` ~10 行） | Phase 4 前半 |
| K11 | 兼容回归：新CLI×旧插件 / 新CLI×新插件 两组合 + run 源字节级回归（V1-V11） | D8 缩小 |

### 6A.3 三阶段实施

**P1 — CLI 基础面**（K1 K2 K3 K4 K8 + health.mjs 一行修复）：
- [ ] 串会话关键用例：A 有 run + B 闲聊 + B 身份失败 → B fail-closed 不触碰 A
- [ ] 无 run 会话首次 stage 幂等创建 synthetic session；sealed session 拒写
- [ ] 显式 `--run` 逐字节回归；未知 signal-id 默认拒收
- [ ] 两并发窗口 lease 各绑各的；纯终端收窄扫描/`--channel` 用例

**P2 — 治理闭环**（K5 K6 K7）：
- [ ] session 源门禁矩阵：未 seal → throw；sealed 无 receipt → throw；receipt stale → throw；双满足 → 成功（与 run 源等强度）
- [ ] 混合来源同 candidate ID → 分账不合并门禁
- [ ] run 源全链 V1-V11 全绿（零迁移）

**P3 — 接入与止血**（K9 K10 K11）：
- [ ] 两 Pi 窗口各 attached 不同 session：lease/env 正确归属
- [ ] 新 compaction checkpoint 不再出现在 corpus；压缩/恢复全链绿
- [ ] 新CLI×旧插件：env 被忽略，行为退化为现状（收窄扫描兜底可用）

### 6A.4 升级路径（全部纯增量，无二次迁移）

| 延后项 | 重新引入条件 | 增量方式 |
|---|---|---|
| 谱系指纹 B 级 | 二期，三平台原型实测证据先行 | 新增候选通道类型，不动 A/C 级 |
| freeze 分支 | 实证"长开 synthetic session 不便 seal"后 | D4 门禁加 OR 分支（放宽方向需再评审） |
| source_refs 完整数组 + evidence_root | OQ-3 分级门禁采纳时 | session delta 独立 schema 族，加字段无存量迁移 |
| Phase 4 staging 半边 | P2 完成后 | 隔离存储已在，stage 只是多一个生产者 |
| Phase 5 消费方矩阵 | 二期统一做 | 现状不崩，属展示增强 |
| 通道 CAS/分 hostKind 存活 | 出现实际并发事故证据后 | 通道文件预留 revision 字段（MVP 恒写 1） |

### 6A.5 明示接受的剩余风险

1. 纯终端零配置体验消失：多 session 并发裸终端需 `--channel`/显式参数；单 session 有收窄扫描兜底（摩擦，非安全问题）。
2. 无 freeze 分支：长开 synthetic session 晋升需先 seal；日期分区 ID 缓解。
3. 统一 TTL 误杀：hook 宿主长 idle 后通道过期 → 下次 hook 事件自动重建；空窗期写操作 fail-closed（安全方向）。
4. 存量 KNW-*-session-compact active 条目仍在 corpus：K10 只止新增，存量并入 OQ-4 上线前基线分诊。

---

## 7. 数据与兼容性（v2 强化）

- **run delta 字节级不动**：`run-knowledge-delta/1.0`（strict schema，无 migration 先例）保持原样；session delta 为独立 schema 族，互不污染。
- **四象限版本测试（D8）**：旧CLI×旧插件、旧CLI×新插件（env 被忽略无害 / `--host-session` 会报错 → 插件先 capability probe）、新CLI×旧插件、新CLI×新插件。
- **零迁移**：存量 run delta 与 81 pending 候选原样保留；review 展示按 origin 分组。
- **存量积压分诊（OQ-4 推荐）**：上线前冻结 81 条清单做基线分区（origin/age/disposition），先处理 review_required/conflict；禁止无证据批量 resolve/deprecate；`--all` 仅作用于明确选定批次。

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| promote 双源门禁复杂度上升 | 门禁分叉集中在 promoteSessionKnowledge；双源独立测试矩阵 + source_refs 事务测试（混合来源/崩溃恢复/重复 ID） |
| session 源候选证据偏弱 | D4 双重保证 + `--evidence` 强制 + corroboration 分级（OQ-3 推荐） |
| 身份获取失败 | 写授权分级 fail-closed（绝不猜测）；读取路径完全不受影响 |
| 谱系指纹不稳（shell 包装/PID 复用/平台差异） | 指纹仅 B 级候选；结构化元组 + 启动时间；PowerShell CIM；原型先行（OQ-5） |
| session 替换导致 env 过期 | session_start 重设 env + 重建通道；TTL/心跳自然失效旧通道 |
| sealSession 内 receipt 刷新失败 | 不阻断 seal；missing receipt 使 promote fail-closed，`review --refresh` 补齐 |
| 全局 CLI 与插件版本错配 | D8 协议：capability probe + 四象限测试；CLI 先行发布 |
| checkpoint 收编影响恢复 | recovery-only 存储与治理面分离；compaction 测试全绿才切换 |

回滚：各 Phase 独立可回滚；session delta 与通道文件删除即恢复原状（run 路径从未改动）；checkpoint 收编保留旧写点开关一个发布周期。

## 9. 开放问题（v2 状态）

- ~~**OQ-1**：无参隐式解析顺序~~ → 已收敛（D2 写授权分级），channel TTL 改为按 hostKind 的存活策略（D9）。
- **OQ-2**：checkpoint 收编 → **评审推荐：纳入本轮，recovery-only + 治理候选**（已采纳为 Phase 4 方案，待最终确认）。
- **OQ-3**：跨 session corroboration → **评审推荐：分级门禁**——机器验证的单 session 事实可显式晋升；LLM/人工提炼的 session-only 候选进 T2 自动路径需跨 session 独立证据根或机器 verifier；单 session 手动 promote 需确认 + reason（待确认采纳）。
- **OQ-4**：存量积压 → **评审推荐：不阻断切换，上线前基线分区 + 一次性分诊**（已写入 §7，待确认采纳）。
- **OQ-5**：指纹算法 → v2 曾采纳为 D3/§4.1 约束；**v2.1 复杂度审计后降级：指纹全套砍出 MVP，延后二期且需三平台原型实证后再议**（MVP 用显式/lease/hook 通道 + 收窄扫描已覆盖全部已证实平台；纯终端多会话并发接受 `--channel` 手动摩擦）。

---

## 附录 A：GPT 架构评审留痕（2026-08-06，gpt-5.6-sol，只读评审）

**总体结论：需修订（4×P0 / 4×P1 / 2×P2）→ v2 全部采纳。**

| # | 严重级 | 问题 | v2 处置 |
|---|---|---|---|
| 1 | P0 | 日常会话缺少治理 Session 的创建规则（pi hostSessionId 不能当 session 权威；`/maestro-knowledge` 无绑定回退最近修改 Session） | D1 synthetic knowledge session 幂等创建；P3 收紧 overlay 回退 |
| 2 | P0 | 唯一扫描兜底仍可串写（A 有 run、B 闲聊且指纹失败 → 绑 A）；谱系共同祖先假设无实证 | D2 扫描收窄至"恰一 running session 且零 live channel"；D3 指纹降为 B 级候选，不作写授权 |
| 3 | P0 | session 门禁 "sealed 或 receipt" 弱于 run 双重门禁；sealed 不能证明 corpus reconcile；seal receipt 写失败后 sealed 分支绕过 freshness | D4 改为 "delta 不可变 AND 新鲜 receipt"；D5 刷新失败留 missing receipt 阻断 promote |
| 4 | P0 | summary/reconcile/resolve/promote 写回全链以 run_ids 为事务模型，session-only 候选无法签 receipt/resolve/持久化 promoted；同 candidate ID 跨源会错误合并 | D10 统一 source_refs；corroboration 统计独立证据根排除同 session 副本 |
| 5 | P1 | run delta strict() 无 migration 先例，"增字段版本递增"不成立；插件 DTO 硬要求 run_id | D1 run delta 字节不动 + 独立 session schema；D8 四象限测试 + capability probe |
| 6 | P1 | 固定 30min TTL 误杀长任务；lease pending+link 语义不可照搬；同 identity 同路径"物理不可能串写"不成立 | D9 分 hostKind 存活策略 + revision/CAS + 通道失败不阻断读取 |
| 7 | P1 | 消费方影响矩阵不完整（audit/brief 卡/skill-context/通知/overlay/health `"?"` 归属） | §4.2 回归矩阵 |
| 8 | P1 | checkpoint "先 active 入库再 stage" 会被 exact_duplicate suppress，治理门永久关闭 | Phase 4 改 recovery-only + 治理候选 |
| 9 | P2 | unknown ID 逃生口审计格式未定义，strict schema 加字段触发兼容问题 | D6 独立 validation sidecar |
| 10 | P2 | 决策表 D8 缺失 | 新增 D8 发布兼容协议 |

**引用核实**（评审抽查 12 处）：10 处属实（其中 4 处行号过时，v2 已按 maestro2 源码更新：findUniqueActiveRun→store.ts:719、sealSession→runtime.ts:2341、compaction 写点→maestro-compaction.ts:928、pending 刷新点含 run seal/overlay 关闭）；1 处改述（health.mjs 实际递归扫描全部 knowledge-delta.json，真问题是候选来源记 `"?"`）；1 处补充（hooks session_id 解析位置 hooks.ts:869）。

**评审确认的优点**：session sidecar 低侵入方向正确；保留 T1 frontmatter 尊重 run 事实声明价值；D7 不放宽 T3 符合幻觉防线；显式参数与 lease 优先方向正确；signal-id 校验直击 contest queue 污染源；分 Phase + run 全链回归策略合理。

---

*v1 基于 2026-08-06 实测；v2 依据 GPT 独立评审修订。源码路径以 `D:/maestro2`（maestro-flow CLI）与 `D:/pi-maestro-flow`（Pi 插件）为准。*
