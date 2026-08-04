---
kind: analysis
---

# Advisor / Goal / Monitor 三方监督：共用与统一性分析

> 关联文档：`docs/advisor-vs-monitor-relationship-20260803.md`（Advisor 与 Monitor 二者关系，含逐项源码证据）。本文扩展到三方的统一性问题，回答：**adviser、goal、monitor 的功能是否可以共用统一？**

## 0. 结论（先行）

**可以统一，但统一的是"横切能力层"，不是"监督生命周期"。**

三者共享同一条"**评估 → 判定 → 投递**"管线形状，且**底层模型执行入口已经完全共用**；但它们的触发模型、状态模型、上下文与身份语义各不相同，强行统一生命周期会牺牲各自的关键能力。推荐架构：**共享监督基础设施层（delivery / evaluator / telemetry）+ 三个各自持有生命周期的监督器**。

## 1. 三方机制速览

| | Goal 验证器 | Monitor 引擎 | Advisor（逐轮监督） |
|---|---|---|---|
| 位置 | `packages/pi-maestro-flow/src/tools/goal-verification.ts` | `packages/pi-maestro-teammate/src/extension/monitor.ts` | oh-my-pi `coding-agent/src/advisor/*` |
| 触发 | 一次性：`goal complete` 时 | 周期：15s tick | 流式：每 turn 结束 |
| 评估 | `runTeammate(verifier)` + deadline(180s) + 重试(3) → 结构化 `VerifierVerdict`（pass/fail/inconclusive/error + reasoning/unmet/evidence） | 启发式（stalled/failed/interaction）+ `runSingleTeammate(analyst)` 单次 → `on-track/drift` | 独立第二模型 + 跨轮上下文审阅 transcript 增量 → severity（nit/concern/blocker） |
| 判定后 | `commitVerifiedCompletion` / `pauseGoal` + 状态栏/widget | `sendIntervention`(steer/follow_up) + `notifyMain` | `<advisory>` 注入主 transcript；concern/blocker 走 steering |
| 频率控制 | 不适用（一次性） | cooldown 60s + `lastNotifiedReason` 状态去重 | `immuneTurns` + EmissionGuard（归一化去重/空话过滤/每轮 1 条） |
| 状态 | 无状态单次判定（含证据收集） | bindings + cooldown + drift 标志 | 独立 append-only 上下文 + 去重历史 + 游标 + 重置语义 |
| 身份 | 独立 verifier 子进程（不可寻址） | 被监督对象是可寻址 peer | advisor 永非 peer |

## 2. 共同管线（三者形状相同）

```
触发(schedule) → 收集上下文(evidence/transcript) → 模型评估(evaluate)
  → 判定(verdict) → 投递(deliver: interrupt / batch / notify) → 遥测(telemetry)
```

Goal、Monitor、Advisor 只是这条管线的三个参数化实例：
- Goal：`goal complete` → 证据收集（session + canonical Workflow）→ verifier → verdict → 提交/暂停
- Monitor：`tick` → 快照（status/idle/output tail/objective）→ 启发式 + LLM 漂移 → steer/notify
- Advisor：`turn_end` → transcript delta → 第二模型 → severity → steering 注入

## 3. 可共用的横切能力（4 项，含现状证据）

### 3.1 模型评估调用（评估器）——底层已共用，仅需封装
- **现状**：Goal 用 `runTeammate`（`goal-verification.ts:41` lazy import `pi-maestro-teammate/v1/execution`），Monitor 用 `runSingleTeammate`（`runs/execution.ts:135`），moa/explore/delegate 同入口 → **模型路由 Profile、熔断、重试（`v1/retry`）已经是一套共享底座**。
- **可抽**：统一评估器封装四个参数——`runTeammateFn`、deadline（Goal 已有 `runTeammateVerifierWithDeadline` 可下沉为通用）、结构化输出 schema（Goal 的 `VerifierVerdict` / Advisor 的 severity / Monitor 的 `AnalysisResult`）、thinking 深度与失败容忍（Goal 3 次 / Monitor 静默跳过 / Advisor 3 连败丢积压）。

### 3.2 投递与限流策略（投递器）——两套同构实现，可合并
- **现状**：Monitor `INTERVENTION_COOLDOWN_MS`(60s) + `lastNotifiedReason` 去重；Advisor `immuneTurns`(3) + EmissionGuard（归一化去重 FIFO 4096 + 空话过滤 + 每轮 1 条）。**解决的是同一问题：防骚扰、防重复、失败降级**。
- **可抽**：统一 `DeliveryPolicy`——`severity → 投递方式（interrupt=steer 通道 / batch=下一边界 / notify=仅通知用户）` + `cooldown` + `归一化去重 key` + `投递后降级轮数`。Monitor 与 Advisor 各配一个实例，Goal 用默认策略（一次性，无冷却）。

### 3.3 遥测与可观测性（遥测器）——事件发布 + 日志可合并
- **现状**：Goal 状态栏/widget；Monitor `MON x/y` 状态栏 + overlay；Advisor `__advisor.jsonl` 转写 + `/advisor status/dump`。事件总线 `pi.events` 已承载 teammate lifecycle/cockpit 事件，但**尚无统一监督事件类型**。
- **可抽**：统一 `SupervisionEvent { source: goal|monitor|advisor; severity; verdict?; target; message; delivered }` 发布到 `pi.events`（cockpit 状态栈消费）；可选统一监督 jsonl 日志（Advisor 已有范式可推广）。

### 3.4 配置与注册（可选，v2）
统一监督器注册表（如 `/supervise` 或 settings 面板列出 goal/monitor/advisor 三类监督的启用状态与绑定），避免三套命令/面板。**低优先级**，等 3.1-3.3 落地后再评估。

## 4. 必须独立的部分（统一边界之外）

| 维度 | 差异 | 为什么不能统一 |
|---|---|---|
| **触发模型** | 一次性（Goal）/ 周期 tick（Monitor）/ 流式事件（Advisor） | 强行合一成统一调度器会引入样板且丢失语义（终态判定 vs 活性检查 vs 流式审查） |
| **状态模型** | Goal 无状态单次；Monitor bindings+cooldown；Advisor 跨轮上下文+去重历史+游标+compaction 重置 | 状态生命周期差异过大；共享状态层会是过度抽象 |
| **上下文** | Advisor 必须独立 append-only 上下文（增量审阅、重置语义）；Monitor/Goal 无状态单次调用 | 独立上下文是 Advisor 质量的核心；塞进共享层会拖累无状态路径 |
| **身份与边界** | Advisor 永非 peer（不可寻址）；Monitor 监督可寻址 peer；Goal verifier 是独立子进程 | peer 寻址、权限、复活语义不同，统一接口会掩盖安全边界 |

## 5. 推荐架构

```
包内共享层（新增 supervision/）:
  supervision/evaluator.ts   — 统一模型评估封装（deadline/结构化输出/thinking/失败容忍）
  supervision/delivery.ts    — 投递策略（severity→interrupt/batch/notify + cooldown + 去重 + 降级）
  supervision/telemetry.ts   — SupervisionEvent 发布 + 可选 jsonl 日志

三个监督器（各自持有生命周期，仅依赖共享层）:
  GoalVerifier   ← goal-verification.ts（verdict/证据/acceptance 保留；deadline 下沉到 evaluator）
  FleetMonitor   ← monitor.ts（启发式/漂移分析/workspace-peers 保留；投递/限流换 shared delivery）
  TurnAdvisor    ← 未来新增（评估/上下文逻辑自持；投递/限流/遥测全部复用 shared）
```

统一协议：`SupervisionEvent` 经 `pi.events` 发布 → cockpit 状态栈/overlay 统一展示三类监督。

## 6. 落地路径（三步，零破坏、向后兼容）

1. **Step 1 — 抽共享层**：从 `goal-verification.ts` 提取通用 evaluator（deadline + verdict 封装）；从 `monitor.ts` 提取 DeliveryPolicy（cooldown + 去重 + 降级）。两个现有模块改为消费共享层，行为不变（测试回归保障）。
2. **Step 2 — 统一遥测**：定义并发布 `SupervisionEvent` 到 `pi.events`，cockpit 消费；不破坏现有状态栏语义（事件是增量，状态栏继续直接读各自状态）。
3. **Step 3 — Advisor 接入**：落地逐轮监督时只写"评估/上下文"新逻辑（建议低频 agent_end 审查起步），投递/限流/遥测全部复用共享层——这正是"先统一、后接入"的最大收益：Advisor 不需要重造 Monitor 已建成的通道。

## 7. 反模式（避免过度统一）

- ❌ 把一次性/周期/流式三种触发统一成一个调度器——接口样板 + 丢失语义。
- ❌ 把 Advisor 的独立上下文（增量审阅、重置、去重历史）塞进共享状态层——只有 Advisor 用得到流式路径。
- ❌ 用统一接口抹平 peer 身份差异——advisor 永非 peer 的安全边界必须保留。
- ❌ 一次性大重构（统一后再迁移三个模块）——按 Step 1→3 渐进，每步独立可回退。

## 8. 一句话总结

**共用：评估调用（已共用，补封装）、投递与限流（两套同构，合并）、遥测（统一事件）；独立：触发、状态模型、上下文、身份。** 统一的价值在于：未来 Advisor 落地时复用 Monitor/Goal 已建成的通道与策略，而不是再造第四套机制。

---

## 9. 实施状态（2026-08-04，已按 `plans/current.md` 批准方案落地）

### S1 ✅ 共享层（teammate 包）
- 新增 `packages/pi-maestro-teammate/src/supervision/`：`types.ts`（`SupervisionEvent`/`SUPERVISION_EVENT`/`createSupervisionEvent`）、`evaluator.ts`（`runSupervisedEvaluation`：deadline 中止子进程树 + maxFailures 重试 + structured-first/text-fallback + beforeVerdict 门 + 父 signal 级联，失败不抛）、`delivery.ts`（`DeliveryGate`：cooldown/归一化去重(global|target scope)/空话过滤/perWindowLimit/interrupt→batch 降级/reset；被抑制投递不污染历史）。
- 导出：`public/v1/supervision.ts` + package.json `./v1/supervision` + v1 barrel re-export。
- 单测：`test/supervision-evaluator.test.ts`（9 项）+ `test/supervision-delivery.test.ts`（8 项）全绿。

### S2 ✅ Goal 验证器迁移（flow 包）
- `goal-verification.ts`：删除 `runTeammateVerifierWithDeadline`，`runVerifier` 改调 `runSupervisedEvaluation<VerifierVerdict>`（deadlineMs=180s、maxFailures=3、`VERIFIER_OUTPUT_SCHEMA`、`parseVerifierOutput` 为文本降级、`verifierExitStatusReason` 为 exit-code 门且诊断消息逐字符不变）。
- 兼容契约：结构化输出仍是 Goal 唯一 verdict 通道（无 structuredOutput → 保持 legacy inconclusive 语义，assistant-only JSON 永不成为完成 verdict）。
- 发布 `SupervisionEvent`（source:"goal", kind:"verdict"，best-effort）。

### S3 ✅ Monitor 引擎迁移（teammate 包）
- `monitor.ts`：每绑定 `DeliveryGate`（cooldown 60s + target 作用域去重 + perWindowLimit 1）、`ANALYSIS_RESULT_SCHEMA`、engineTick 窗口化、干预前 gate、`notifyMain` 增加可选 target 参数。
- `index.ts`：分析改 `runSupervisedEvaluation<AnalysisResult>`（structured-first + `parseAnalysisResult` 降级；ok:false ≡ 旧 undefined 语义），引擎 abortController 级联为父 signal；干预/通知发布 `SupervisionEvent`。

### S4 ✅ 验证
- flow：test:goal 87/87、test:plan 116 pass/1 skip（Windows 平台 skip）、test:todo 63/63、typecheck 0 错误。
- teammate：全量 866/868（2 平台 skip）、typecheck/build:declarations/check:declarations 全绿。
- 契约：packed-consumer-e2e 通过（v1/supervision 在打包包中可解析）；sdk-resolution-contract 的 1 个失败为**预存 SDK 版本钉定问题**（安装 0.83.0 vs 测试期望 0.82.1，知识库已知关注点，与本次改动无关）。
- 环境注记：仓库存在用户并发 WIP（transcript/history、attach-overlay、resource.ts 内部 URL scheme）；其中 resource.ts 的 `://` 正则语法错误曾阻断 teammate 子进程加载，已最小修复（转义 `\/\/`）；其余 WIP 未触碰。

### 遗留（规划外，后续）
- ~~Advisor 本体未实现~~ → **已实现（2026-08-04）**：`packages/pi-maestro-flow/src/advisor/`（独立扩展入口，`pi.extensions` 第二入口），低频 `agent_end` 触发 + 共享层 evaluator（analyst/low/60s/120s）+ DeliveryGate（5min 冷却/global 去重/downgrade 3）+ `<advisory>` 注入（interrupt→steer、batch→nextTurn、blocker+triggerTurn）+ SupervisionEvent(source:"advisor") + `/advisor status|on|off`（`.pi/advisor.json` 持久化，默认 off）。纯逻辑在 `runtime.ts`（9 项单测全绿）。
- ~~cockpit 未消费 SupervisionEvent~~ → **已实现（2026-08-04）**：`pi-cockpit/src/supervision-store.ts`（有界事件环 + 聚合计数 + `footerStatus`），footer 新增 `SUP I2·V1 ▲` 段（窄屏自动裁剪），`/supervision` 命令展示汇总与最近 10 条事件（`/supervision events`）；事件常量在 `public/v1/events.ts` 版本化导出（teammate 共享层同串 `supervision:event`）。store 单测 5 项 + cockpit 全量 388 全绿。
- monitor 的 `maxFailures` 使用共享层默认 3（vs 旧单发），受引擎 abort 信号约束，有界。
