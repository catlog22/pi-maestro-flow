# Maestro Flow × 知识治理：期望最终架构（Target Architecture）

> **执行平面已被部分取代（2026-08-12）**：本文关于 `Session/Execution/Run`、长期 lease、heartbeat、handoff 和单 owner 的设计不再是目标态；新的执行平面采用 `docs/session-run-minimal-state-architecture-20260812.md` 的方案 B（Session + Run、participant ID、细粒度 revision/CAS、无 Execution/长期 lease/operation drain）。身份平面中的 fenced lease 写授权级别同样被取代，替代为 participant identity + revision CAS。知识治理部分的 "session seal" 语义迁移为方案 B 的 "session complete receipt"（方案 B 中只有 Run 保留 seal，Session 终态为 completed）。本文的知识治理、evol、来源、证据和晋升设计继续有效，但引用应迁移为 Session/Run ID。

> 状态：目标态架构文档（综合稿）
> 上游依据：
> - `docs/self-evolution-plugin-design.md`（v2/v3，evol 机制与 T0-T3 分层自动化）
> - `docs/knowledge-session-decoupling-plan.md`（v2.1，GPT 架构评审 + qwen 复杂度交叉审计双轮修订，含实施 Phase 与 **MVP-cut 精简路径 §6A**）
> 仓库：`maestro2`（maestro-flow CLI）· `pi-maestro-flow`（Pi 插件）
> 本文描述**期望的最终态**；实施推荐走 MVP-cut 精简路径（机制 19→11、Phase 5→3），最终态不变、全部升级为纯增量（见解耦规划 §6A）；现状与目标态的差异集中在 §8 差距表。

---

## 1. 架构总览

最终架构由五个平面组成：**执行平面**（Session/Run）是治理骨架，**知识平面**是沉淀与晋升管道，**身份平面**解决多平台多会话的归属，**evol 自动化平面**承担事实型自进化与健康闭环，**感知平面**保证人对进化过程可见、可审、可控。

```
┌────────────────────────────────────────────────────────────────────┐
│ 身份平面（多平台：Pi / Claude / Codex / Agy / 纯终端）                 │
│  A级写授权：显式参数 · fenced lease · 宿主注入通道（env/hook channel）  │
│  B级候选：谱系指纹匹配（需确认）    C级兜底：收窄唯一扫描（附warning）   │
└──────────────────────────────┬─────────────────────────────────────┘
                               ▼ 归属判定
┌──────────────────────────────┐    ┌────────────────────────────────┐
│ 执行平面（治理骨架）            │    │ 知识平面（沉淀管道）              │
│ Session = 治理/审核/晋升单位    │◄──►│ session delta（新，双源之一）     │
│  ├─ Run = 事实源（T1 草拟保留） │    │ run delta（v1.0 不动，T1 在此）  │
│  ├─ chain/continuation（next） │    │ source_refs 统一来源模型         │
│  ├─ gates（run/session 两级）  │    │ reconcile → review → promote    │
│  └─ lease（宿主所有权+心跳）    │    │ receipt 双源等强度门禁            │
└──────────────┬───────────────┘    └──────────────┬─────────────────┘
               │ seal 事件                          │ promote 落盘
┌──────────────┴───────────────┐    ┌──────────────▼─────────────────┐
│ evol 自动化平面               │    │ 语料 + 反馈注入                  │
│ T0 自动抑制 · T1 自动草拟      │    │ .workflow/specs|knowhow         │
│ T2 事实型自动晋升（--all）     │    │ → wiki 索引（mtime 增量）        │
│ T3 推断型人工裁决              │    │ → search 命中 / Knowledge Gate  │
│ 信号采集 · health 闭环         │    │ → knowledge_context 卡          │
│ canary 在线验证 · skill 提案   │    │ → load 归因（全局 KG 账本）      │
└──────────────────────────────┘    └────────────────────────────────┘
                               ▲
┌──────────────────────────────┴─────────────────────────────────────┐
│ 感知平面：session_start 积压 notify · 状态栏 KNOW/EVOL ·               │
│ /maestro-knowledge 审核台 · /self-evolve 统一 inbox · seal 消息       │
└─────────────────────────────────────────────────────────────────────┘
```

注：图中 fenced lease / lease（宿主所有权+心跳）为现状机制，方案 B 目标态由 participant identity + revision CAS 取代。

**一句话概括目标态**：*Session 是知识治理的第一公民；Run 是受尊重的事实源之一；任何平台的任何会话都能在不依赖 run 的前提下完成"沉淀→审核→晋升→注入"的完整治理闭环，且全程对人可见。*

---

## 2. 执行平面：Session/Run 生命周期（现状记录；目标态见方案 B）

以下为现状架构事实（实测确认；目标态调整见 §2.3 及方案 B）：

### 2.1 实体与状态机

| 实体 | 状态 | 关键语义 |
|---|---|---|
| **Session**（`schemas.ts:166`） | `running / paused / sealed / archived / failed` | 治理与晋升的命名空间；seal 要求全部 run 已 sealed、无 claimed requests、session 级 gates 全过（`runtime.ts:2341` sealSession） |
| **Run**（`schemas.ts:433`） | `created / running / blocked / failed / completed / sealed` | 一次命令执行；`session done <run-id>` 完成 seal 事务；sealed 后 sidecar 拒写（不可变） |
| **Gate** | `pending/running/passed/failed/blocked/waived/skipped` | run 级与 session 级两层注册表（`gates.json`） |

### 2.2 存储模型（SessionBundle，`store.ts:513`）

```
.workflow/sessions/<sid>/
├── session.json      # 状态机（含 active_run_id、identity_revision）
├── gates.json        # gate 注册表
├── artifacts.json    # 工件注册表
├── evidence.json     # 证据存储
└── runs/<rid>/
    ├── run.json · report.md · outputs/
    └── （sidecar：knowledge-delta.json、knowledge-reconciliation.json …）
```

- 项目级投影：`.workflow/state.json`（`sessions[]` + `active_session_id`，`runtime.ts:580`）。
- 并发写保护：`SessionStoreLock` workspace 级锁（`store.ts:241`，Windows 重试）。
- 链式推进：continuation/`next` 分配下一 Run；host 所有权由 **lease** 管理（`pi-maestro-flow/src/session/coordinator.ts:96,247,418`：epoch claim 文件 + 10s 心跳 + 30s stale，落 `.workflow/tmp/hook/<sid>.lease/`）（现状机制；方案 B 目标态删除长期 lease，改为 participant + 细粒度 revision CAS）。

### 2.3 执行平面迁移决策（2026-08）

> 本节记录的是 2026-08 第一次架构修订（Session/Execution/Generation + core lease 路线），该修订已被方案 B 二次取代（见顶部提示）；保留本节仅为演进留痕。migration-plan 引用为历史引用，不再执行。

原“Session 生命周期、状态机与 lease 语义不动”的假设已被后续架构评审取代。长期 topic/intent Session 不能以一次执行结束作为永久封存时机；目标模型改为：

- **Session**：长期身份与索引，不以 `running/paused/sealed/failed` 作为最终权威；
- **Execution/Generation**：一次有界 Workflow，承载 chain、gates、active Run、lease、pause/resume/seal；
- **Run**：一次不可变执行尝试，sealed 后拒绝修改；
- **Lease**：由 Maestro core 按 `(session_id, execution_id)` 提供唯一单写者权威，Pi 插件只做宿主 acquire/heartbeat/handoff adapter；
- **知识与 recall**：以 sealed Run、sealed Execution snapshot 和 revision/hash receipt 证明输入不可变，不要求长期 Session 永久 sealed。

迁移必须按 `docs/session-execution-generation-migration-plan.md` 分阶段执行：先增加 Execution identity、versioned wire schema、core lease 与兼容投影，再迁移知识/recall，最后在 CLI/插件 capability 门全部满足后删除 Session status 权威。兼容期继续读取 `session/1.0-1.3`、`command-run/1.0-1.3` 和 `run-response/1.0`，禁止在 strict 旧 schema 中直接注入新字段。

`sealSession` 的现有 session reconciliation receipt 行为在兼容期保留；方案 B 目标态由 Session complete receipt 作为 reconciliation 权威边界，session-source candidate 使用 candidate version + evidence/revision/corpus receipt 门禁。promotion 仍是独立治理动作，不因任何 seal 自动执行。

---

## 3. 知识平面：目标态生命周期

### 3.1 全链路

```
采集        沉淀                 对账           裁决            晋升          注入
search/load ─► stage ──────────► reconcile ──► review ───────► promote ────► corpus
(归因 inputs)  (候选 candidates)  (receipt)     (T3 人工)       (双源门禁)     (specs|knowhow)
     ▲             │                                                  │
     │             ├─ run 源：run delta（T1 seal 草拟 + 手动 stage）      │
     │             └─ session 源：session delta（synthetic/既有 session） │
     └─────────────────────── 未来 search 命中 / Knowledge Gate ◄─────────┘
```

### 3.2 统一来源模型 source_refs（目标态核心重构）

候选来源从 `run_ids: string[]` 升级为：

```ts
source_refs: [{ kind: 'run' | 'session', id: string, evidence_root: string }]
```

- **run delta 内部字段不动**（v1.0 strict schema 字节级保留）；source_refs 在聚合结果层派生，session delta 原生携带。
- receipt 签发、freshness 校验、resolve、promotion intent、完成状态写回、恢复式 promotion **全部按 source ref 分派**。
- corroboration 统计**独立证据根**：同一 Maestro Session 内 run/session 的重复副本不计为独立佐证。
- 同一 candidate ID 跨源出现时按来源分账，不合并门禁。

### 3.3 分层自动化（T0-T3，最终态语义）

| 层 | 覆盖 | 机制 | 双源适配 |
|---|---|---|---|
| T0 自动抑制 | exact_duplicate | reconciliation 自动 suppressed | 双源通用 |
| T1 自动草拟 | run report.md frontmatter 的 accepted decisions / locked constraints | run seal 事务自动 stage（`runtime.ts:2905`） | **run 专属**（事实声明面） |
| T2 事实型自动晋升 | unique/eligible 候选 | `promote --all`（一次性用户确认） | 双源通用；session 源需双重门禁满足 |
| T3 推断型人工 | semantic_duplicate / conflict / supersede | `review --resolve --as --reason`（必填）；promote fail-closed | 双源通用，幻觉防线不放宽 |

### 3.4 promote 双源门禁（等强度）

| 源 | 门禁 |
|---|---|
| run 源 | 所有源 run sealed **AND** 每源有 receipt **AND** receipt 新鲜（corpus fingerprint 比对）——现状不变 |
| session 源 | session delta 不可变（**MVP 为 seal-only 单分支**（此处 seal 为 Session 级，方案 B 下对应 session complete receipt）；显式 freeze 分支按 §6A.4 条件性回归——仅在实证"长开 synthetic session 不便 seal"后重新引入）**AND** 新鲜 session corpus receipt **AND** stage 时 `--evidence` 非空 |

两源门禁强度等价："不可变"只保证候选内容冻结，"新鲜 receipt"证明候选已对当前 corpus 完成对账——缺一不可。

### 3.5 Synthetic Knowledge Session（日常会话的治理入口）

无 Maestro Session 的日常会话（闲聊、轻任务、未挂 workflow）：

- 首次 stage/record 时 CLI **幂等创建 synthetic knowledge session**（确定性 ID 规则，区分于 workflow session）。
- 完整支持 stage → review → seal → promote 闭环（此处 seal 为 Session 级，方案 B 下对应 session complete receipt）；seal/abandon/恢复/清理均有定义。
- **宿主会话 ID（pi hostSessionId / claude session_id）永不直接充当 session 目录权威**——它只是身份平面的映射键。

### 3.6 归因账本（inputs）

- run 归因：run delta inputs（现状保留）。
- session 归因：session delta inputs（新增，同 schema 族）。
- 全局消费账本：`maestro load` → KG usage ledger（与 run 无关，现状保留）+ best-effort run/session 路由（目标态改为身份路由，无法归属时 warning 不静默）。
- **signal-id 写入前校验存在性**（canonical/alias resolver）；`--allow-unknown` 落独立 validation sidecar 留痕。

---

## 4. 身份平面：多平台 × 多会话归属（目标态）

### 4.1 写授权分级

| 级别 | 身份来源 | 授权范围 |
|---|---|---|
| **A** | 显式参数 `--run/--session/--channel` | 直接授权写 |
| **A** | fenced lease（epoch token 校验 + 心跳未 stale） | 直接授权写（现状；方案 B 下由 participant identity + target revision CAS 取代） |
| **A** | 宿主注入通道（Pi env `PI_HOST_SESSION_ID` / hook 注册 channel） | 直接授权写 |
| **B** | 谱系指纹候选匹配（唯一且高置信） | 仅建议：需既有 channel 或交互确认，不单独创建写通道 |
| **C** | 收窄唯一扫描（恰一 running session 且零 live channel） | 兜底 + warning |
| — | 其余 | fail-closed，列出存活通道 |

**读操作（search/load 正文）永不被身份失败阻断**；身份只影响治理写的归属与归因。

### 4.2 平台覆盖

| 平台 | 宿主会话 ID 来源 | 通道建立 |
|---|---|---|
| Pi | 插件 `session_start` 注入 env | env → lease 反查（现状；方案 B 下为 participant identity） / channel |
| Claude Code | hook stdin 载荷 `session_id`（`hooks.ts:869` 已解析） | hook 注册 + 指纹候选 |
| Codex CLI | 官方 hooks 载荷 `session_id`（developers.openai.com/codex/hooks；本机已装 maestro Codex hooks） | 同 Claude |
| Agy | `AGY_HOOK_DEFS`（`hooks.ts:501`）同协议 | 同上 |
| 其余宿主 | 无 | 指纹自注册候选通道 → `--channel`/`MAESTRO_CHANNEL` → 收窄扫描 |

### 4.3 临时通道（channel）

- 位置：`.workflow/tmp/channels/<identity>.channel.json`；记录 `{identity, hostKind, context, fingerprint, workspaceId, revision, createdAt, expiresAt, lastSeenAt}`。
- 双路建立：hook 宿主由 hook 事件注册（心跳 + 进程启动标识定存活）；无 hook 宿主由 search/load 以指纹自注册候选通道（祖先存活探测 + idle cap）。
- 并发：SessionStoreLock / append-only epoch claim + CAS；manual channel 不参与唯一通道推断。
- Knowledge Gate 保证 search 是每会话最早操作 → 通道建立时机天然最早。

---

## 5. evol 自动化平面（最终态）

### 5.1 事实型自进化流水线

```
run/session 执行轨迹
  ├─ 扩展信号采集（agent_end/compact → dry-run 信号 → ~/.maestro/self-evolve/suggestions/）
  ├─ T1 seal 自动草拟（run frontmatter 事实）
  ├─ session-only stage（日常会话沉淀）
  ▼
reconcile（T0 自动抑制 + receipt）→ review（T3 人工）→ promote --all（T2 事实型批量）
  ▼
语料生效 → 未来 run search 命中 → consumed/validated/contradicted 归因回流
  ▼
health sidecar 聚合（specHealth/audit/revalidation/signals/contest queue）
  ▼
治理循环：stale 重审 · contested 处置 · ghost 退役 · supersede 谱系修复（人工确认）
```

### 5.2 受控自动化（Phase 5 能力，最终态保留）

- **canary/shadow**：高影响知识在线验证窗口；validated+cited≥1 → PROMOTE 建议，contradicted/无佐证 → ROLLBACK 建议；只出建议，晋升仍走 fail-closed 门。
- **skill proposal**：`.pi/skills/` 修改独立治理链（快照+diff+权限审查+静态检查+apply 需非空 reason+自动回滚），不与 knowhow promotion 混用。
- **approval receipt**：每次 promote/supersede/deprecate/conflict-mark 落 `~/.maestro/self-evolve/approvals/`（actor+reason+候选），独立审计轨迹。

### 5.3 compaction checkpoint 收编（目标态）

checkpoint 原件迁入 **recovery-only 存储**（恢复语义不变），治理面 stage session 源候选，promote 后才生成 active knowhow。语料中不再出现未治理的自动 active 条目。

---

## 6. 感知平面（解决"感知不强"）

目标态下用户回答"什么时候进化、怎么审核"的全部通道：

| 时机 | 通道 | 内容 |
|---|---|---|
| session_start / attach | 主动 notify（新增） | 待审积压计数 + `/maestro-knowledge` 入口 |
| run seal | `run-knowledge` 消息 | consumed/cited/validated/contradicted + staged 数 + review 命令 |
| session seal（方案 B 下对应 session complete receipt） | `session-knowledge` 消息 | pending/review_required 计数 + review 命令 |
| 常驻 | 状态栏 `KNOW n review·m pending`（红/绿）+ `EVOL ● s·d·p` | 积压与信号计数 |
| 随时 | `/maestro-knowledge` 审核台 | 按源分组（run/session）resolve + promote；session-only 候选不伪造 run ID |
| 随时 | `/self-evolve` 统一 inbox | review_required 候选 + 未消费 stage 信号 + health P1 队列，每项附下一步命令 |
| 晋升后 | approval receipt | 全量审计可回溯 |

---

## 7. 目标态数据布局

```
.workflow/
├── state.json                          # 投影：sessions[] + active_session_id
├── specs/  knowhow/                    # 语料（仅 promote 写入）
├── sessions/<sid>/
│   ├── session.json · gates.json · artifacts.json · evidence.json
│   ├── knowledge-delta.json            # [新] session-knowledge-delta/1.0（候选+归因，origin=session）
│   ├── knowledge-reconciliation.json   # [新] session receipt（candidate snapshot + corpus fingerprint）
│   └── runs/<rid>/
│       ├── run.json · report.md · outputs/
│       ├── knowledge-delta.json        # run-knowledge-delta/1.0 字节不动（T1 草拟 + 手动 stage）
│       └── knowledge-reconciliation.json  # run receipt（现状）
├── tmp/
│   ├── hook/<sid>.lease/<epoch>.claim.json   # lease（迁移期存在；方案 B v3 删除）
│   └── channels/<identity>.channel.json      # [新] 身份通道
└── recovery/compaction-checkpoints/    # [新] recovery-only（原 KNW-*-session-compact 迁此）

~/.maestro/self-evolve/                 # 全局 evol 输出（跨项目，git 干净）
├── suggestions/<date>.jsonl            # dry-run 信号
├── reviews/<date>.jsonl                # dry-run 评审
├── health.json                         # 健康 sidecar（可重建）
└── approvals/<date>.jsonl              # 审批回执
```

---

## 8. 不变量与铁律（目标态汇总）

1. **时序铁律**：评审（stage/resolve 前置对账）在 seal 之前可行、promote 在源 seal 之后（源为 Session 级时，方案 B 下对应 session complete receipt）；sealed 实体拒写 sidecar。
2. **双源等强度**：任何源的 promote 都必须同时满足"内容不可变 + 新鲜 corpus receipt"，不得以单一条件替代。
3. **写授权分级**：指纹与扫描永不单独授权写操作；歧义 fail-closed 并列出存活通道。
4. **T3 人工裁决不放宽**：review_required 未裁决 → promote fail-closed；`--reason` 非空。
5. **语料写入唯一通道**：`.workflow/specs|knowhow` 只经 promote（compaction checkpoint 目标态同样收编）。
6. **不可变边界**：global scope、已晋升 active spec、conflict/contested 标记条目不在任何自动化范围内。
7. **身份隔离**：宿主会话 ID（pi/claude/codex session id）只是映射键，永不充当 `.workflow/sessions/` 目录权威。
8. **读不被身份阻断**：search/load 正文读取与身份解析失败解耦。
9. **兼容铁律**：run delta v1.0 字节级不动；新能力一律走新 schema 族 + capability probe + 四象限版本测试。
10. **不可信数据**：transcript/advisor/工具输出按 untrusted 处理；advisor 结论只能生成线索候选。

---

## 9. 现状 → 目标态差距表

| 维度 | 现状 | 目标态 | 落地 |
|---|---|---|---|
| 沉淀入口 | 仅 run 内可 stage（fail-closed） | session-only 可沉淀 + synthetic session | 解耦规划 P1 |
| 候选存储 | run sidecar 单源 | run + session 双源（独立 schema） | P1 |
| 事务模型 | run_ids 全链 | source_refs 分派 | P2 |
| promote 门禁 | run 单源三重 | 双源等强度双重保证 | P2 |
| 会话归属 | findUniqueActiveRun 全盘扫描 | 写授权分级（participant identity/channel/指纹候选） | P1 |
| 多平台 | Pi 有插件；Claude/Codex/Agy 有 hooks 但知识管道未消费 | 三来源身份 + 通道 + 回退链 | P1 |
| signal-id | 零校验 | 存在性校验 + validation sidecar | P1 |
| 审核时机 | 绑 run check/seal 窗口 | session 存续期随时 + seal 刷 receipt | P2 |
| 感知 | 仅 seal 瞬间 notify + 状态栏 | session_start notify + 统一 inbox | P3 |
| compaction | active 直写旁路 | recovery-only + 治理候选 | P4 |
| 消费方 | 未适配 session 源 | §4.2 回归矩阵全勾（audit/health/brief 卡/overlay/通知） | P5 |

---

## 10. 术语表

| 术语 | 定义 |
|---|---|
| Session / Run | maestro 治理实体：Session = 治理命名空间，Run = 一次命令执行（`schemas.ts:166/433`） |
| Synthetic Knowledge Session | 为无 workflow 日常会话幂等创建的治理 Session |
| source_refs | 候选来源统一模型（run/session + evidence_root） |
| receipt | reconciliation 回执：candidate snapshot + corpus fingerprint，promote 新鲜度依据 |
| lease | 宿主对 Session 的变更所有权（epoch claim + 心跳）——已被方案 B 取代（仅历史/迁移期概念） |
| participantId / actorId | 方案 B core mutation 身份：participantId 标识请求来源客户端/窗口，actorId 标识决策/执行主体，均不表示独占所有权 |
| identity/orchestration/activity revision | 方案 B Session 三分细粒度版本：身份元数据 / chain·decision·status·gates / 全局事件序号，各自独立 CAS |
| request receipt | 方案 B 幂等请求回执：同 requestId + 相同 canonical payload 返回原 receipt，不同 payload 返回 REQUEST_CONFLICT |
| channel | 身份平面临时通道（hostKind 分策略存活） |
| T0-T3 | 分层自动化：自动抑制/自动草拟/事实型自动晋升/推断型人工 |
| fail-closed | 条件不满足时拒绝并给出恢复指引，绝不猜测放行 |
| exposure vs consumption | search/注入曝光是 exposure；load 才是 consumed 归因 |

---

*本文档为目标态总纲；实施细节、验收标准与评审留痕见 `knowledge-session-decoupling-plan.md`（v2.1，附录 A 含 GPT 评审全部 10 条处置）。*
