---
title: "Advisor 逐轮监督"
icon: "shield-check"
---

**Advisor** 是挂在主会话上的低频第二模型审查器。它在主 Agent 运行过程中检查最近的对话与工具结果，发现方向、约束或 API 使用风险时，把一条带严重度的建议送回主会话。

Advisor 默认关闭，适合在需要额外质量检查、但不希望每一步都人工复核的项目中启用。

## 1. 工作方式

Advisor 监督的是**当前主会话自己的工作质量**，不是一个可寻址的 teammate，也不会直接修改文件。

一次评估包含以下步骤：

1. **触发**：每轮 `agent_end` 后评估一次；执行过程中默认每 3 个工具结果评估一次，工具报错会立即触发检查；
2. **收集上下文**：读取最近的 transcript 或工具检查点，并限制消息数量与总字符数；
3. **脱敏**：发送给第二模型前，过滤 Bearer 凭据、私钥、API key、token、Cookie 和带认证信息的 URL 等常见敏感内容；
4. **模型评估**：通过 teammate 的共享监督评估器调用 `analyst`，输出结构化判定；
5. **结果投递**：只有发现 concern 或 blocker 时才把建议注入主会话；正常的 `on-track` 结果不会打扰当前任务。

评估只在后台运行。评估模型不可用、超时或输出无效时，Advisor 记录失败并保持主会话继续运行，不会因为监督器故障阻塞主 Agent。

## 2. 启用与命令

Advisor 通过独立扩展入口注册 `/advisor` 命令：

```text
/advisor status
/advisor on
/advisor off
/advisor model <provider/model>
/advisor model inherit
```

| 命令 | 作用 |
|------|------|
| `/advisor status` | 查看启用状态、模型、评估节奏、上下文限制、最近判定和统计信息 |
| `/advisor on` | 启用 Advisor，并保存到当前项目的 `.pi/advisor.json` |
| `/advisor off` | 停用 Advisor，并清理当前生命周期中的待评估项 |
| `/advisor model <provider/model>` | 为 Advisor 指定一个当前可用的专用模型 |
| `/advisor model inherit` | 清除专用模型设置，改为继承主会话当前模型 |

不带参数时，`/advisor` 等同于查看状态。启用后如果没有显式指定模型，Advisor 会使用主会话当前的 `provider/model`。

## 3. 项目级配置

配置文件路径为：

```text
.pi/advisor.json
```

可以通过命令生成和修改基础配置，也可以在确认字段格式后手动调整：

```json
{
  "enabled": true,
  "model": "provider/reviewer-model",
  "guide": "重点检查 API 契约、错误处理和 acceptance criteria",
  "cooldownMs": 300000,
  "maxTailMessages": 8,
  "maxTailChars": 4000,
  "reviewEveryToolResults": 3
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `false` | 是否启用 Advisor |
| `model` | 继承主会话模型 | 可选的专用 `provider/model`；模型必须在当前会话可用 |
| `guide` | 空字符串 | 追加到评估提示中的项目审查重点 |
| `cooldownMs` | `300000` | 两次干预建议之间的冷却时间，默认 5 分钟 |
| `maxTailMessages` | `8` | 每次评估最多包含的 transcript 消息数 |
| `maxTailChars` | `4000` | 序列化上下文的最大字符数 |
| `reviewEveryToolResults` | `3` | 执行过程中每多少个工具结果触发一次评估 |

修改配置后，建议重新执行 `/advisor on` 或 `/advisor status`，让当前会话重新加载项目配置。

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
