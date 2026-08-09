---
title: "Monitor 跨会话监督"
icon: "📊"
---

Monitor 用于持续监督**同一工作区中的其他 Pi 会话或窗口**。它按固定周期检查目标是否失败、等待用户输入、长时间停滞或偏离任务，并在满足条件时发送受控 `steer` 干预；监督记录持久写入 ledger，可在会话重载后恢复。

Monitor 适合长时间并行任务、多窗口开发、后台迁移和需要闭环纠偏的工作流。它不是普通状态查询工具：只想读取一次状态时使用 `observe`；需要持续判断并主动纠偏时使用 `/monitor`。

> **版本可用性：** 包含跨会话 Scheduler、Window Bar 交接和持久监督增强的 v0.17.0 已撤回。当前 npm 稳定版为 0.16.0；本页保留当前源码能力供修复版发布前审阅，请勿为使用这些增强安装 0.17.0。

---

## 1. 最短上手流程

先在同一工作区启动或打开至少一个其他 Pi 窗口，并为会话使用容易识别的名称。然后在负责监督的窗口中执行：

```text
# 打开 Monitor 控制窗口，不立即绑定目标
/monitor

# 绑定名为 backend 的窗口，使用自动监督
/monitor backend auto

# 查看当前绑定、最近输出和 ledger 状态
/monitor status

# 查看监督效果指标
/monitor metrics

# 停止监督并清除当前绑定
/monitor exit
```

输入 `/monitor ` 后可使用命令补全查看当前可绑定的窗口名称。直接执行 `/monitor` 会进入控制窗口；在 `#control` Tab 中输入监督指令，或选择一个 peer window 向目标发消息。

> Monitor 绑定的是工作区窗口端点。目标窗口关闭、切换工作区或端点已更新时，旧绑定不会被继续复用。

## 2. 绑定目标与监督模式

### 自动模式

```text
/monitor backend auto
/monitor backend frontend tests auto
```

`auto` 是默认模式。Monitor 结合确定性状态检查与 LLM 偏航分析：

- 目标失败或等待用户输入时通知监督窗口；
- 目标处于运行状态但空闲超过阈值时发送恢复工作或报告阻塞的建议；
- 目标仍在工作时分析目标、最近输出和趋势，判断是否出现 drift；
- 干预后继续观察结果，记录 recovered、repeated、escalated 或 failed；
- 重复问题达到阈值后升级到监督窗口，要求人工检查。

因此，`auto` 适合目标明确、可以由 Monitor 自行判断是否偏航的任务。

### 自定义模式

```text
/monitor backend custom:重点检查数据库迁移是否保持向后兼容
/monitor release custom:发现测试被跳过或发布步骤乱序时立即纠正
```

`custom:` 后面的整段文本作为监督要求。Monitor 仍会执行失败、等待交互和停滞检查，同时让偏航分析围绕自定义要求判断。

自定义提示应描述**需要持续守住的约束**，而不是复述完整任务。例如：

- “不得修改 public API；发现签名变化时提醒回退。”
- “每个实现阶段必须运行对应测试，不允许用 skip 或 suppression 掩盖失败。”
- “发布顺序必须是 settings-core、teammate、cockpit、flow。”

### 关联 Goal

```text
/monitor backend --goal goal-123 auto
/monitor release --goal goal-123 custom:阻塞验收项未解决前不得宣布完成
```

`--goal <id>` 把绑定关联到 pi-peer Goal board。Monitor 会把 Goal 的闭环标准加入分析上下文；重复停滞或偏航升级时，可在 Goal board 上追加阻塞 objection，作为完成验证的监督证据。

## 3. Cockpit 中使用 Monitor

安装 Pi Cockpit 后，可以从 Window Bar 操作跨会话监督：

1. 在 Cockpit 切换到 Window 视图并选中目标会话；
2. 按 `Alt+W` 开启监督；
3. 再按一次 `Alt+W` 解除该窗口的绑定；
4. 使用 `/monitor status` 查看完整绑定和 ledger 状态。

Monitor 控制窗口本身不能作为监督目标。`Alt+R` 可打开 teammate 会话列表，在窗口之间交接操作，并保留 routing、monitor 和 turns 上下文。

退出 Monitor 交互模式有两种方式：

- 执行 `/monitor exit`；
- 在 500ms 内连续按两次裸 `Esc`。

第一次 `Esc` 保留终端原有的取消或清空语义，第二次才退出 Monitor 模式。

## 4. 命令速查

| 命令 | 作用 |
|------|------|
| `/monitor` | 打开控制窗口，不自动绑定全部 peer window |
| `/monitor <targets...> [auto]` | 绑定一个或多个窗口并启动自动监督 |
| `/monitor <targets...> custom:<prompt>` | 用自定义持续约束监督目标 |
| `/monitor <targets...> --goal <id>` | 将绑定关联到 Goal board |
| `/monitor status` | 查看会话状态、绑定目标、最近输出和 ledger 摘要 |
| `/monitor metrics` | 查看干预解决率、恢复率、升级率、drift 率等派生指标 |
| `/monitor doctor` | 只读健康检查：配置、绑定数、ledger 路径、记录数和警告 |
| `/monitor resume` | 从持久 ledger 恢复仍然有效的绑定 |
| `/monitor exit` / `/monitor stop` | 停止 Monitor 会话并清除绑定 |
| `/monitor spawn <name> <objective>` | 启动一个受管理的 headless Pi 工作窗口 |
| `/monitor spawn status` | 查看当前受管理窗口 |
| `/monitor spawn stop <name>` | 停止指定受管理窗口 |
| `/monitor ui` | 旧版绑定 Overlay，仅为兼容保留 |

## 5. 启动受管理工作窗口

Monitor 可以直接创建一个 headless Pi 窗口，再把它纳入监督：

```text
/monitor spawn migration 完成数据库迁移并运行集成测试
/monitor spawn status
/monitor migration auto
```

窗口名必须以字母或数字开头，只能包含 `A-Z`、`a-z`、`0-9`、`.`、`_`、`-`，最长 64 个字符。目标文本使用命令中名称之后的全部内容。

停止窗口：

```text
/monitor spawn stop migration
```

受管理窗口附着于创建它的扩展生命周期。完成后应显式停止，避免遗留不再需要的后台 Pi 进程。

## 6. Monitor 如何判断和干预

每个 tick 对每个绑定使用开始时的端点快照；异步分析结束后会再次精确校验 owner 和 endpoint，防止窗口重启或端点轮换后把干预发给错误目标。

处理顺序如下：

1. **失败：** 目标有失败 Agent 时通知监督窗口，不向失败目标重复发送消息；
2. **等待交互：** 目标在等待用户输入时通知监督窗口，由用户完成交互；
3. **停滞：** 运行中但空闲超过当前内置的 60 秒 heuristic 时，发送 `steer`；若上下文压力超过阈值，优先建议先 compact；
4. **偏航：** 正常运行且未停滞时，分析任务目标、输出尾部和近期 verdict 趋势；
5. **闭环结果：** 干预后等待 `pendingOutcomeEvalMs`，记录恢复、重复、失败或升级；
6. **升级：** 重复未恢复达到 `escalationThreshold` 时通知监督窗口，并在有关联 Goal 时写入 objection。

每个目标都有冷却、去重和窗口内投递限制。发送失败会按配置重试；耗尽后写入 dead-letter，并通知监督窗口目标不可达。

## 7. 项目级配置

Monitor 从项目的 `.pi/settings.json` 读取 `monitor` 段：

```json
{
  "monitor": {
    "tickMs": 15000,
    "stallIdleSeconds": 60,
    "interventionCooldownMs": 60000,
    "maxRetries": 2,
    "retryBackoffMs": 1000,
    "maxInterventionLog": 20,
    "analysisTailLines": 20,
    "escalationThreshold": 2,
    "pendingOutcomeEvalMs": 30000,
    "contextCompactThresholdPercent": 80,
    "ledgerEnabled": true,
    "autoResume": true
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `tickMs` | `15000` | 两次监督 tick 的间隔（毫秒） |
| `stallIdleSeconds` | `60` | LLM 偏航分析的空闲分界；当前确定性 stall heuristic 仍固定为 60 秒 |
| `interventionCooldownMs` | `60000` | 同一目标两次干预之间的最短间隔 |
| `maxRetries` | `2` | 首次投递失败后的最大重试次数 |
| `retryBackoffMs` | `1000` | 线性重试退避基数（毫秒） |
| `maxInterventionLog` | `20` | 已接受的预留配置；当前每个绑定仍固定保留 20 条 |
| `analysisTailLines` | `20` | 已接受的预留配置；当前偏航分析仍固定读取最近 20 行 |
| `escalationThreshold` | `2` | 连续未恢复干预达到此值后升级 |
| `pendingOutcomeEvalMs` | `30000` | 评估一次干预结果前的最短等待时间 |
| `contextCompactThresholdPercent` | `80` | 停滞且上下文压力达到此比例时建议 compact |
| `ledgerEnabled` | `true` | 是否写入持久 Monitor ledger |
| `autoResume` | `true` | 会话启动时是否恢复有效的活动绑定 |

> **v0.17.0 当前限制：** `stallIdleSeconds` 会影响 LLM 分析分支，但确定性停滞检查当前仍使用内置 60 秒；`maxInterventionLog` 与 `analysisTailLines` 已被配置加载器接受，运行时仍固定为 20。`/monitor doctor` 会显示已加载配置，不代表这三个覆盖值已经全部作用于 heuristic。

数值必须是正整数。以下环境变量可覆盖对应配置：

| 环境变量 | 配置字段 |
|----------|----------|
| `PI_MONITOR_TICK_MS` | `tickMs` |
| `PI_MONITOR_STALL_IDLE_SECONDS` | `stallIdleSeconds` |
| `PI_MONITOR_COOLDOWN_MS` | `interventionCooldownMs` |
| `PI_MONITOR_MAX_RETRIES` | `maxRetries` |
| `PI_MONITOR_RETRY_BACKOFF_MS` | `retryBackoffMs` |
| `PI_MONITOR_ESCALATION_THRESHOLD` | `escalationThreshold` |
| `PI_MONITOR_LEDGER` | `ledgerEnabled` |
| `PI_MONITOR_AUTO_RESUME` | `autoResume` |

环境变量优先于 `.pi/settings.json`。布尔值支持 `1/true/on/yes/enabled` 与 `0/false/off/no/disabled`。

## 8. Ledger、状态与指标

持久记录位于：

```text
.pi/monitor-ledger.jsonl
```

每行是一条 JSON 记录，类型包括：

| 类型 | 内容 |
|------|------|
| `binding` | 绑定创建、移除、断开、退出或关闭 |
| `analysis` | `on-track` / `drift` verdict 变化 |
| `intervention` | 已发送的纠偏消息和 trace id |
| `outcome` | recovered、repeated、escalated、failed |
| `delivery` | 投递失败和 dead-letter |
| `review` | Advisor concern/blocker 判定 |
| `checkpoint` | Monitor 启动、停止和恢复边界 |

`/monitor status` 适合日常查看，`/monitor metrics` 用于评估监督效果，`/monitor doctor` 用于排障。Ledger 可能包含目标名称、监督提示和纠偏消息，不应提交到版本控制或写入凭据。

## 9. Monitor、Advisor 与 observe 的区别

| 能力 | 监督对象 | 是否持续 | 是否主动干预 | 推荐用途 |
|------|----------|----------|--------------|----------|
| Monitor | 同工作区的其他窗口/会话 | 是，周期 tick | 是，受控 `steer` | 多窗口任务、后台执行、长期监督 |
| Advisor | 当前主会话 | 按回合/工具检查点 | 只注入质量建议 | 检查当前 Agent 的方向和约束遵循 |
| `observe` | 指定 Agent、后台命令或工作区 | 否，单次或有界等待 | 否 | 状态查询、等待完成、读取 turns |
| Goal verifier | Goal 完成结果 | 完成时 | 否 | 验收 acceptance 和完成声明 |

Monitor 与 Advisor 可以同时启用：Monitor 关注其他窗口是否停滞或偏航，Advisor 关注当前主会话的推理质量。详见 [Advisor 逐轮监督](/guides/advisor)。

Agent 需要查看窗口时，应使用 `teammate-list({ view: "windows" })` 和 `observe`。旧的 `teammate-watch`、`teammate-wait` 及独立 legacy observation 工具默认隐藏，不应作为新工作流入口。

## 10. 排障

### 找不到目标窗口

1. 确认目标 Pi 窗口位于同一工作区；
2. 输入 `/monitor ` 检查补全中是否出现目标名称；
3. 在 Cockpit Window Bar 或 `teammate-list({ view: "windows" })` 中确认 endpoint；
4. 如果窗口刚重启，等待新 endpoint 发布后重新绑定。

### 重载后没有恢复

```text
/monitor doctor
/monitor resume
/monitor status
```

检查 `ledgerEnabled` 和 `autoResume` 是否开启。目标窗口必须仍然可发现；ledger 中的旧 owner 不会强行绑定到新端点。

### 干预没有送达

运行 `/monitor doctor` 查看 dead-letter 和警告，再确认目标窗口仍在运行。Monitor 会按 `maxRetries` 和 `retryBackoffMs` 重试；耗尽后不会无限发送。

### 通知过多

提高 `interventionCooldownMs` 或 `escalationThreshold`，并用更具体的 `custom:` 约束减少误判。v0.17.0 的确定性停滞检查固定为 60 秒，调整 `stallIdleSeconds` 不会改变该触发点。不要仅通过关闭 ledger 隐藏问题，ledger 不控制干预本身。

## 11. 相关指南

- [Advisor 逐轮监督](/guides/advisor) — 当前主会话的低频第二模型审查
- [Pi Cockpit 可视化](/guides/cockpit) — Window Bar、会话 Tab 与 `Alt+W`
- [并行多智能体调度](/guides/teammate-dispatch) — 派发、跨会话消息和 `observe`
- [Goal 目标 · Plan 计划 · todo 任务](/guides/goal-plan-todo) — Goal 关联与完成验证
- [Compaction 容量管理](/guides/compaction-config) — 高上下文压力时的 compact 行为
