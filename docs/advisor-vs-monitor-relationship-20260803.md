---
kind: analysis
---

# oh-my-pi Advisor（逐轮监督）与当前插件 Monitor 的关系

> 背景：分析 oh-my-pi（`G:\github_lib\oh-my-pi`，fork 自 Pi）的功能时，`advisor` 逐轮监督被列为插件扩展候选。本文基于两边源码，澄清它与插件已有 `/monitor` 监督能力的**关系**：二者同属"监督"范畴，但维度正交、互不重叠、可以并存并互相借鉴。写此文档作为后续扩展决策的基准。
>
> 扩展阅读：三方（advisor/goal/monitor）统一性分析见 `docs/supervision-unification-analysis-20260803.md`。

## 1. 双方定位速览

| | oh-my-pi Advisor | pi-maestro-teammate Monitor |
|---|---|---|
| 实现 | `packages/coding-agent/src/advisor/*`（runtime/advise-tool/emission-guard/watchdog/transcript-recorder）+ `docs/advisor-watchdog.md` | `packages/pi-maestro-teammate/src/extension/monitor.ts`（引擎+模式态）+ `extension/index.ts:3808`（/monitor 命令）+ `extension/workspace-peers.ts`（跨会话）+ `tui/monitor-overlay.ts` |
| 一句话 | 挂在**主会话**上的第二模型，每轮结束后审查主 agent 的推理并注入建议 | 挂在**其它会话/窗口**上的监督引擎，定时检查子代理的存活与漂移并干预 |
| 监督对象 | 主 agent 自己（本会话每一轮） | 被绑定的会话/窗口（含跨 Pi 根会话的 peer window）内的 agent 舰队 |
| 触发 | 事件驱动：每次 primary turn 结束 | 时间驱动：引擎 tick（15s） |

## 2. oh-my-pi Advisor（逐轮监督）机制要点

- **形态**：独立的第二模型（`modelRoles.advisor`），拥有自己的 `Agent` 实例、`-advisor` 后缀的独立 `ToolSession` 与**跨轮 append-only 上下文**（独立 promote/compact/re-prime）。不看主会话的 file snapshot/seen-lines/conflict 状态。
- **看到什么**：每轮只收新 transcript **增量**（`includeThinking: true` + tool intent），`plan-mode-context` 等注入约束按原样展开（XML 转义防逃逸），字节相同的重复注入去重为 `(unchanged)`；已注入的 advisory 不再回喂（防递归自审）。
- **如何输出**：`advise` 工具按严重度三档：
  - `nit` — 不打断的旁注，在下一个 step boundary 批量入上下文
  - `concern` / `blocker` — 走 steering 通道打断，可在边界中止 in-flight 工具
  - 统一渲染为 `<advisory severity="…" guidance="weigh, don't blindly obey">` 元素（主 agent 系统提示从未提及 advisory，靠标签自解释）
- **守门（EmissionGuard）**：归一化去重（FIFO 4096）、空话过滤（`stop`/`lgtm` 等直接静默）、每轮最多 1 条、被压制的调用对模型不可见（仍回 `Recorded.`）。
- **频率控制**：`advisor.immuneTurns`（默认 3）——投递 concern/blocker 后，后续 N 轮降级为旁注；用户主动打断时不再自动 resume 运行。
- **追赶**：`advisor.syncBacklog`（off/1/3/5）——主 agent 最多等 30s 让 advisor 追平积压，连续 3 次失败丢弃积压放行。
- **配置**：`WATCHDOG.md`（审查优先级清单）+ `WATCHDOG.yml`（**多 advisor 名册**：每项可独立指定 model/tools/instructions，工具默认只读 read/grep/glob，可放宽到 edit/write/bash 等可变工具但绕过主审批链，需信任前提）。
- **可观测性**：`__advisor.jsonl` 逐轮转写（归入 stats 用量与 Agent Hub）、`/advisor on|off|status|dump`。
- **边界**：advisor **永远不是 peer**——从 `irc` 名册、广播、`history://` 与 collab 聊天中排除，不可寻址、不可复活。
- 参考：`docs/advisor-watchdog.md` 全文；`src/advisor/runtime.ts`（537 行）、`emission-guard.ts`（172 行）、`transcript-recorder.ts`（159 行）。

## 3. 当前插件 Monitor 机制要点

- **形态**：`/monitor` 是用户侧的"监督模式"（类似 Plan：enter/exit 生命周期、状态栏集成、默认紧凑输出）；`teammate-monitor` 工具只暴露 `status`/`wait` 两个 LLM 可调用动作，`observe` 负责统一观察。
- **绑定**：绑定目标是**窗口/会话**（1:1，`addBinding` 拒绝重复）：本窗口 + 经 `workspace-peers.ts` 文件协议发现的**同工作空间其它 Pi 根会话**（owner/agent 快照 + owner mailbox）。单 agent 不可直接绑定（`bindable: false`）。
- **引擎（monitor.ts `MonitorEngine`）**：tick 15s，每绑定一轮检查：
  1. **启发式快检**：`failed` / 等待用户交互 → 仅通知主会话（`notifyMain`，按 reason 去重防刷屏）；`running` 且 idle ≥ 60s → `steer` 干预（冷却 60s）。
  2. **LLM 漂移分析（Phase C）**：仅对通过启发式的 running agent 执行，喂 objective + 最近 20 行输出尾部 → `runSingleTeammate(analyst)` 单次无状态分析 → `on-track|drift` + 可选干预消息；分析失败不阻塞引擎。
  3. **模式**：`auto`（通用漂移提示词）/ `custom:<prompt>`（用户自定义监督标准）。
- **干预通道**：本地 agent 经 `deliverLocalAgentMessage`（steer/follow_up）；远端窗口经 `sendWorkspacePeerCommand`（命令文件 → owner mailbox → 窗口主会话，`WORKSPACE_MAIN_SESSION_MARKER`）。
- **可视**：状态栏 `MON x/y · Ns [▲ drift | ◆ n fixes]`、TUI overlay、`/monitor status`。
- **边界**：绑定与干预记录为内存态（无 `__jsonl` 式持久转写）；被监督对象是**可寻址 peer**（teammate-send / IRC / mailbox）。
- 参考：`extension/monitor.ts`（引擎/启发式/分析提示词/状态栏）、`extension/index.ts:2746-2830`（引擎装配与回调）、`extension/index.ts:3900-3980`（/monitor handler）、`extension/workspace-peers.ts`（跨会话协议）。

## 4. 核心差异对比

| 维度 | Advisor（逐轮监督） | Monitor（运行监督） |
|---|---|---|
| 监督对象 | **主 agent 自身**（单会话内） | **其它会话/窗口内的 agent 舰队**（跨会话） |
| 触发 | 每轮 turn 结束（事件驱动） | 15s tick（时间驱动） |
| 输入 | 完整 transcript 增量（含 thinking/tool intent/注入约束） | 运行时快照（status/idle/output tail 20 行/objective） |
| 模型 | 独立第二模型 + 跨轮记忆上下文 | 主会话内的单次无状态 LLM 分析（`runSingleTeammate`） |
| 监督维度 | **质量/正确性**：推理方向、约束遵循、幻觉、API 误用 | **活性/健康**：stalled、failed、等待交互、任务漂移 |
| 干预载体 | `<advisory>` 注入主 transcript；concern/blocker 走 steering（可中断工具） | steer/follow_up 消息；`notifyMain` 通知用户 |
| 频率控制 | immuneTurns（投递后降级 N 轮）+ EmissionGuard 去重/限流 | intervention cooldown 60s + lastNotifiedReason 状态去重 |
| 持久化 | `__advisor.jsonl` 逐轮转写 + `/advisor status/dump` | 内存 bindings/interventions + overlay + 状态栏 |
| 身份 | 永非 peer（不可寻址） | 被监督对象是可寻址 peer |
| 失败容忍 | 3 连败丢积压放行；syncBacklog 有界追赶 | 分析失败静默跳过，引擎不阻塞 |

## 5. 关系结论：互补而非重叠

**二者是监督的两个正交维度，不构成重复：**

- **Advisor = 纵向质量监督**：站在主 agent 头顶，看它"想得对不对"（推理与约束遵循），粒度是轮（turn），信息是全部推理轨迹。**对应插件中的空缺**：当前插件没有任何机制审查主 agent 自己的推理质量。
- **Monitor = 横向运行监督**：站在舰队侧面，看子代理们"活着没、跑偏没"，粒度是 tick，信息是运行快照。**当前插件已实现**，且已跨会话（peer windows）。

时间尺度（轮 vs tick）、信息深度（推理 vs 尾部）、对象（自身 vs 他者）三者都不同 → **两者可以同时启用且互不干扰**：Advisor 管主 agent 的"质"，Monitor 管 fleet 的"活"。

**与插件已有监督体系的关系**：插件另有 Goal 完成验证（verifier teammate 独立审计）、run-control（canonical Run 租约）、todo 状态跟踪——这些是"终点/里程碑"监督；Advisor 补齐的是"过程/逐轮"监督这一档。层次完整度：逐轮（空缺）→ 运行（monitor）→ 里程碑（goal/run-control）。

## 6. 对插件扩展决策的启示

若后续实现 Advisor 式逐轮监督（此前评分 Tier 3，建议从低频 agent_end 审查起步），应**复用而非另造**：

1. **干预通道直接复用 Monitor 已建成的**：steer/follow_up 投递、`notifyMain`（`sendMessage customType`）、状态栏（`ctx.ui.setStatus`）、overlay 模式——统一注入点，避免两套打断语义。
2. **频率控制逻辑同构**：Monitor 的 `INTERVENTION_COOLDOWN_MS`/`lastNotifiedReason` 与 Advisor 的 `immuneTurns`/EmissionGuard 解决同一问题（防骚扰），实现时可抽取共享策略（投递后冷却 + 归一化去重 + 空话过滤）。
3. **模型调用走 teammate 路由**：Monitor Phase C 已示范 `runSingleTeammate(analyst)` + `thinking: low`；Advisor 化实现应同样走模型路由 Profile（`teammate-models.json`），而不是新开一套 provider 调用。
4. **上下文管理借鉴 Advisor 的独立上下文 + 重置语义**：compaction / session switch 时清空去重历史与游标；这是 Monitor 目前没有、逐轮监督必须有的部分。
5. **不重叠确认**：实现逐轮监督时**不需要改动 Monitor**；二者绑定维度不同（会话自身 vs 其它会话），注册面（命令/工具/事件）也可平行。

## 7. 结论

- **关系定性**：Advisor（逐轮监督）= 主会话质量监督；Monitor = 跨会话运行监督。**互补、正交、可并存**。
- **缺口确认**：插件当前无"逐轮/过程"质量监督，Advisor 式功能是真实增量；但优先级低于 Tier 1/2 候选（价值 3/5，成本与延迟顾虑不变）。
- **落地建议**：若做，采用"低频 agent_end 审查 + Monitor 既有干预通道 + 共享频率控制策略"，而非全量移植 oh-my-pi 的 per-turn 同步模型。
