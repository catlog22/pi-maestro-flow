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

### 设计权衡

- `velocity` 默认关：它**提前**压缩，未显式配置时不得早于历史 token 比率行为；
- `cache` 默认开：只会在"节省的 Token 无法覆盖其失效的前缀"时**拒绝**修剪——失败模式是"保留了便宜前缀"而非"意外压缩"；
- `lossless` 默认开：零风险格式折叠。

## 阈值推导

启用后系统自动推导链接阈值：基于 `pruneTargetRatio` 与当前会话规模计算"何时修剪"与"修剪多少"，无需手工调参。

## 验证与调试

```bash
/maestro-settings    # 在设置面板中查看 compaction 生效值（TUI 按键见 [TUI 操作指南](/guides/tui-guide)）
```

设置面板展示 effective 值（project/user/default 三来源合并后的结果）与来源标记（`source` 字段）。

## 下一步

- [设置系统总览](/guides/settings-overview) — 配置作用域与持久化
- [Goal 目标 · Plan 计划 · todo 任务](/guides/goal-plan-todo) — 压缩存活的长时目标
- [环境变量速查](/guides/env-vars) — `PI_CODING_AGENT_DIR` 等
