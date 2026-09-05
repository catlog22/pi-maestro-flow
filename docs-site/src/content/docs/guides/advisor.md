---
title: "Advisor 逐轮监督"
icon: "shield-check"
---

**Advisor** 是挂在主会话上的低频第二模型审查器。它在主 Agent 运行过程中检查最近的对话与工具结果，发现方向、约束或 API 使用风险时，把一条带严重度的建议送回主会话。

Advisor 默认关闭，适合在需要额外质量检查、但不希望每一步都人工复核的项目中启用。

安装 `pi-maestro-flow` 时，Flow Advisor 是进程内唯一的 canonical owner；即使配置为关闭，也不会回退并同时运行 Teammate 的旧实现。只安装 `pi-maestro-teammate` 时，低优先级 standalone Advisor 仍可使用。两者共享一个动态 `/advisor` 命令 broker，因此加载顺序不会产生重复命令或双重评审。

## 1. 工作方式

Advisor 监督的是**当前主会话自己的工作质量**，不是一个可寻址的 teammate，也不会直接修改文件。

一次评估包含以下步骤：

1. **触发**：`automatic`/`hybrid` 模式在每轮 `agent_end` 后评估；执行过程中默认每 3 个工具结果评估一次，工具报错会立即触发检查。将 `reviewEveryToolResults` 设为 `0` 可关闭中途检查点；
2. **收集上下文**：自动评审读取有界 transcript tail 或工具检查点；手动咨询读取当前 resolved conversation，并排除正在执行的 `advisor` 调用；
3. **脱敏**：发送给第二模型前，过滤 Bearer 凭据、私钥、API key、token、Cookie 和带认证信息的 URL 等常见敏感内容；
4. **模型评估**：通过 teammate 的共享监督评估器调用 `analyst`，输出结构化判定；
5. **结果投递**：只有发现 concern 或 blocker 时才把建议注入主会话；正常的 `on-track` 结果不会打扰当前任务。

评估只在后台运行。评估模型不可用、超时或输出无效时，Advisor 记录失败并保持主会话继续运行，不会因为监督器故障阻塞主 Agent。

## 2. 启用与命令

统一 command broker 提供以下命令：

```text
/advisor status
/advisor on
/advisor off
/advisor mode <automatic|manual|hybrid>
/advisor model <provider/model|inherit>
/advisor thinking <minimal|low|medium|high|xhigh|max|default>
```

| 命令 | 作用 |
|------|------|
| `/advisor status` | 查看 owner、配置来源、模式、模型、自动预算、上下文限制和统计信息 |
| `/advisor on` | 启用 Advisor，并保存到当前项目的 `.pi/advisor.json` |
| `/advisor off` | 停用 Advisor，并取消当前生命周期中的待评估项 |
| `/advisor mode ...` | 选择后台自动评审、Agent 手动咨询工具，或两者同时启用 |
| `/advisor model ...` | 指定当前可用的专用模型，或改为继承主会话模型 |
| `/advisor thinking ...` | 设置手动咨询的 thinking；不支持该级别的模型会被拒绝 |

不带参数时，`/advisor` 等同于查看状态。`manual`/`hybrid` 模式会向主 Agent 暴露无参数的 `advisor` 工具；它返回第二意见而不自动注入消息，且不消耗自动评审预算。`disabledForModels` 命中的执行模型会隐藏该工具。

只安装 `pi-maestro-teammate` 时，`/advisor on|off|status` 控制 standalone 实现；on/off 是当前会话 override，项目 settings 和环境变量仍是下一会话的默认来源。

## 3. 项目级配置

配置文件路径为：

```text
.pi/advisor.json
```

可以通过命令生成和修改基础配置，也可以在确认字段格式后手动调整：

```json
{
  "enabled": true,
  "mode": "hybrid",
  "model": "provider/reviewer-model",
  "consultThinking": "high",
  "disabledForModels": [],
  "guide": "重点检查 API 契约、错误处理和 acceptance criteria",
  "cooldownMs": 300000,
  "automaticReviewCooldownMs": 0,
  "maxAutomaticReviewsPerSession": 0,
  "maxTailMessages": 8,
  "maxTailChars": 4000,
  "reviewEveryToolResults": 3
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `false` | 是否启用 Advisor |
| `mode` | `automatic` | `automatic`、`manual` 或 `hybrid` |
| `model` | 继承主会话模型 | 可选的专用 `provider/model`；模型必须在当前会话可用 |
| `consultThinking` | `high` | 手动咨询的 thinking level |
| `disabledForModels` | `[]` | 隐藏手动工具的执行模型，可选 `minThinking` 阈值 |
| `guide` | 空字符串 | 追加到评估提示中的项目审查重点 |
| `cooldownMs` | `300000` | 两次干预建议投递之间的冷却时间 |
| `automaticReviewCooldownMs` | `0` | 两次自动模型评审派发的最小间隔；`0` 表示不限制 |
| `maxAutomaticReviewsPerSession` | `0` | 每会话自动评审上限；`0` 表示不限制，手动咨询不计入 |
| `maxTailMessages` | `8` | 每次自动评估最多包含的 transcript 消息数 |
| `maxTailChars` | `4000` | 自动评估序列化上下文的最大字符数 |
| `reviewEveryToolResults` | `3` | 中途检查点间隔；`0` 表示仅在 `agent_end` 自动评审 |

配置整源优先级如下，命中上层后不再合并下层文件：

1. canonical `.pi/advisor.json`；
2. 若 canonical 不存在，读取 `.pi/settings.json` 的 `monitor.advisor`，否则读取顶层 `advisor`；
3. 若两者均不存在，使用 defaults；
4. 最后应用 `PI_ADVISOR`、`PI_ADVISOR_COOLDOWN_MS`、`PI_ADVISOR_MAX_REVIEWS` 环境覆盖。

legacy cooldown/budget 会映射为自动评审冷却与每会话预算；`tailMessages × maxMessageChars` 会转换为有界总字符预算，且 legacy 模式保持仅在 `agent_end` 评审。读取 legacy 不会自动写出 canonical 文件；通过 Flow `/advisor` 修改配置时才写 `.pi/advisor.json`。

canonical 文件若为空、JSON 损坏或不可读，Flow 会警告并安全关闭 Advisor，且不会回退 legacy 或用环境变量重新启用。修复文件后重新加载会话即可生效。

## 4. 判定与建议投递

Advisor 模型返回三种状态：

| 状态 | 含义 | 行为 |
|------|------|------|
| `on-track` | 当前方向和约束基本正常 | 只记录统计，不向主会话发送消息 |
| `concern` | 存在值得修正的风险、方向偏差、约束遗漏或 API 臆测 | 注入一条 concern 建议 |
| `blocker` | 继续执行很可能浪费工作或产生明显错误结果 | 注入 blocker 建议，并可触发新的主会话 turn |

建议使用 `<advisory>` 元素注入，并明确标记为需要权衡的建议：

```xml
<advisory severity="concern" guidance="weigh, don't blindly obey">
检查当前调用是否与项目实际导出的 API 一致。
</advisory>
```

Advisor 不会要求主 Agent 无条件服从建议。主 Agent 仍需结合用户目标、项目代码和已有约束判断是否采纳。

每条建议都会经过共享的 `DeliveryGate`：冷却窗口、归一化去重、窗口内数量限制，以及连续干预后的降级策略共同避免重复或过度打断。会话切换、压缩或关闭时，未完成的评估会被取消。

## 5. 监督体系

项目中的监督能力按监督对象和生命周期分为三类：

| 监督器 | 监督对象 | 触发方式 | 主要作用 |
|--------|----------|----------|----------|
| Advisor | 当前主会话的 Agent | `agent_end` 和工具检查点 | 检查推理方向、约束遵循和结果质量 |
| Monitor | 其他会话或窗口中的 Agent 舰队 | 周期性 tick | 检查存活状态、停滞、等待交互和任务漂移 |
| Goal verifier | 一个 Goal 的完成结果 | `goal complete` | 根据 acceptance 或独立 verifier 审计完成条件 |

三者共享 teammate 的监督基础设施：模型评估器负责超时、结构化输出和失败处理；`DeliveryGate` 负责建议投递的限流和去重；`SupervisionEvent` 负责把判定与干预事件发布给可观测性组件。

在安装了 Pi Cockpit 的情况下，可以使用：

```text
/supervision
/supervision events
```

查看监督事件汇总和最近事件。Cockpit footer 也会显示监督事件计数与严重度摘要。

Advisor 与 Monitor 的区别是：Advisor 关注主 Agent **想得是否正确**，Monitor 关注其他会话中的 Agent **是否仍在运行且没有跑偏**。两者可以同时启用。

## 6. 相关指南

- [Monitor 跨会话监督](/guides/monitor) — 监督其他窗口、检测停滞与偏航、自动干预和恢复
- [Agent 角色体系](/guides/agents) — `analyst`、`verifier` 和项目级审查角色
- [并行多智能体调度](/guides/teammate-dispatch) — 显式派发并行分析和审查任务
- [Goal 目标 · Plan 计划 · todo 任务](/guides/goal-plan-todo) — Goal 完成验证与任务生命周期
- [Pi Cockpit 可视化](/guides/cockpit) — 状态栏、监督事件和终端可观测性
- [模型路由与思考深度](/guides/model-routing) — Provider/model 选择与逐任务模型覆盖
