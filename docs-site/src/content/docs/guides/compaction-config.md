---
title: "Compaction 容量管理"
icon: "🧮"
---

智能的上下文窗口管理：硬压缩阈值 + 软压缩多准则决策，防止长会话溢出。

---

## 工作原理

| 特性 | 说明 |
|------|------|
| **自动修剪** | 上下文达到阈值（~70%）时自动修剪大型工具结果（≥8000 字符） |
| **保留近期** | 始终保留最近 ~20K Token 的对话内容 |
| **预留空间** | 预留 ~16K Token 给模型响应 |
| **可重放工具** | `read`, `grep`, `glob`, `search`, `find` 的结果可安全修剪（需要时可重新执行） |
| **压缩续行** | 压缩后自动注入续行提示，Agent 从中断点继续 |
| **状态持久化** | 修剪状态持久化，跨会话保持 |

## 配置位置

| 作用域 | 路径 |
|--------|------|
| 用户级 | `~/.pi/agent/settings.json`（`PI_CODING_AGENT_DIR` 可覆盖） |
| 项目级 | `<项目>/.pi/settings.json`（覆盖用户级） |

## 配置项

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "model": "provider/compaction-model",
    "newContext": { "enabled": true },
    "soft": {
      "enabled": true,
      "nudgeRatio": 0.7,
      "pruneRatio": 0.8,
      "pruneTargetRatio": 0.7,
      "velocity": { "enabled": false, "epochsToCritical": 3, "minFullness": 0.7 },
      "cache": { "enabled": true, "minRatioRange": [0.1, 0.5] },
      "timeBased": { "enabled": false, "gapThresholdMinutes": 60 },
      "relevance": { "enabled": false, "mode": "bm25" },
      "crossTurnDedup": { "enabled": false, "minLines": 3, "minChars": 40 },
      "lossless": { "enabled": true }
    }
  }
}
```

### 硬压缩字段

| 键 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 压缩总开关 |
| `reserveTokens` | `16384` | 为模型响应预留的 Token |
| `keepRecentTokens` | `20000` | 始终保留的近期对话 Token |
| `model` | 跟随会话模型 | 压缩摘要模型（`provider/id`） |
| `newContext.enabled` | `true` | 启用显式、无模型摘要的同会话上下文重置 |

### 软压缩字段（多准则决策）

| 键 | 默认 | 说明 |
|----|------|------|
| `soft.enabled` | `true` | 软层开关 |
| `nudgeRatio` | `0.7` | 开始提示压缩的满度比 |
| `pruneRatio` | `0.8` | 开始修剪的满度比 |
| `pruneTargetRatio` | `0.7` | 修剪目标满度 |
| `velocity.enabled` | `false` | 速率感知加速（默认关闭，避免早于历史行为压缩） |
| `velocity.epochsToCritical` | `3` | 达到临界所需的连续快速填充回合 |
| `cache.enabled` | `true` | 缓存感知：仅当节省可覆盖失效成本时修剪 |
| `timeBased.enabled` | `false` | 时间感知：跨长间隙的缓存冷检测 |
| `relevance.enabled` | `false` | 相关度排序（bm25）：改变被修剪顺序；默认保持最新优先 |
| `crossTurnDedup.enabled` | `false` | 跨轮去重（`minLines` 3 / `minChars` 40） |
| `lossless.enabled` | `true` | 无损格式折叠（零风险） |

### 显式 New Context

`compaction.newContext.enabled` 默认开启，并按字段遵循 project-over-user 优先级。显式关闭时，`new_context` 与 `compact_history` 不注册到新进程的模型工具面；开启时在 Session 启动或下一 Agent turn 前注册并激活。Cockpit 的 `/maestro-settings` → Flow → New Context 会显示当前 scope 配置与 effective value，可用 `Space` 切换、`Ctrl+S` 保存。该开关只控制显式 reset 及其当前会话恢复工具与 Todo `advance transition=new_context`，不会改变 automatic/native compact 的阈值、修剪或溢出恢复。

只应在 Todo 或阶段已经完成、`Todo.context` 与必要 `resourceUris` 已持久化、下一阶段弱耦合且能从 recovery capsule 恢复时使用。Todo completion checkpoint 决定 reset 时机，pressure 只决定紧迫度：late auto-prune 提供普通建议，critical 则应在开始下一 Todo 前优先 reset。任务执行中不要因 token 压力中断当前 Todo，automatic compact 继续承担容量安全兜底；没有 Todo completion 时不产生动态提醒。完整流程、调用示例、capsule 内容与故障语义见 [New Context 确定性上下文重置](/guides/new-context)。

### 设计权衡

- `velocity` 默认关：它**提前**压缩，未显式配置时不得早于历史 token 比率行为；
- `cache` 默认开：只会在"节省的 Token 无法覆盖其失效的前缀"时**拒绝**修剪——失败模式是"保留了便宜前缀"而非"意外压缩"；
- `lossless` 默认开：零风险格式折叠。

## 阈值推导

启用后系统自动推导链接阈值：基于 `pruneTargetRatio` 与当前会话规模计算"何时修剪"与"修剪多少"，无需手工调参。

## 加固（v0.16.0+）

- **临界压力中止 → 收敛**：工具循环内临界压力下不再硬性中止，改为收敛；
- **瞬时错误重试**：摘要调用遇瞬时错误自动重试；
- **网关故障熔断降级**：网关故障时熔断器降级而非失败；
- **输出截断恢复**：不再受上下文压力门控，可直接恢复；
- **僵尸租约修复**：回合中段租约悬挂问题已修复。

## 验证与调试

```bash
/maestro-settings    # 在设置面板中查看 compaction 生效值（TUI 按键见 [TUI 操作指南](/guides/tui-guide)）
```

设置面板展示 effective 值（project/user/default 三来源合并后的结果）与来源标记（`source` 字段）。

## 下一步

- [New Context 确定性上下文重置](/guides/new-context) — 阶段边界的无模型摘要 reset
- [设置系统总览](/guides/settings-overview) — 配置作用域与持久化
- [Goal 目标 · Plan 计划 · todo 任务](/guides/goal-plan-todo) — 压缩存活的长时目标
- [环境变量速查](/guides/env-vars) — `PI_CODING_AGENT_DIR` 等
