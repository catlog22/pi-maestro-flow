---
title: "API Provider 与模型故障转移"
icon: "🔑"
---

自定义 API Provider、模型注册、API 重试策略与电路断路器/故障转移配置。

---

## 1. API Provider 管理

`/api-manager` 是 Provider 管理中心（也可用 `maestro` CLI 的 api 操作）。

### 内置 Provider

| id | 名称 | API | 默认模型 |
|----|------|-----|---------|
| `maestro-openai` | OpenAI Responses | `openai-responses` | gpt-5.4（400K 上下文 / 128K 输出） |
| ... | 其他内置端点 | — | 以 `/api-manager` 列表为准 |

### 操作

```bash
/api-manager list          # 列出全部 Provider
/api-manager configure     # 配置/注册自定义 Provider
/api-manager enable|disable <id>
/api-manager toggle <id>
/api-manager retry         # 查看/调整 API 重试策略
/api-manager effort        # 默认思考级别
/api-manager vision <id>   # 关联 Vision 模型
/api-manager logout <id>   # 登出（清除凭证）
```

### 自定义 Provider

在 `/api-manager` 中注册自定义端点：`id`、`api`（协议）、`baseUrl`、`modelId`、`contextWindow`、`maxTokens`。注册后即可在 teammate 的 `model: "provider/model"` 中引用。

### API 重试策略

| 项 | 默认 | 说明 |
|----|------|------|
| `retry.enabled` | `true` | 是否启用 API 重试 |
| `retry.maxRetries` | `5` | 最大重试次数（CLI `/api-manager retry` 上限 5；设置面板上限 10） |

> 默认思考级别：`medium`。不同模型支持的级别范围不同（见[模型路由](/guides/model-routing)）。

### 敏感字段（secret）规则

留空并确认 = 保留当前值；输入后确认会清空旧值。

> `/api-manager` 与故障转移 TUI 的完整按键映射见 [TUI 操作指南](/guides/tui-guide)。

## 2. 模型故障转移

电路断路器保护 API 调用，失败自动切换到备用模型。

### 配置位置

| 作用域 | 路径 |
|--------|------|
| 全局 | `~/.pi/agent/model-failover.json` |
| 项目 | `<项目>/.pi/model-failover.json`（覆盖全局） |

### 配置结构

```json
{
  "enabled": true,
  "fallbackModels": {
    "provider/model-a": ["provider/model-b", "provider/model-c"]
  }
}
```

| 键 | 说明 |
|----|------|
| `enabled` | 熔断/故障转移总开关 |
| `fallbackModels` | 模型 → 备用模型链映射；主模型失败时按序回退 |

### 行为

- **电路断路器**：连续失败触发熔断，避免打爆配额；
- **自动故障转移**：熔断后按 `fallbackModels` 链切换；
- **图片触发切换**：附加图片时可按路由切到 Vision 模型，完成后恢复原模型（`imageTriggered` / `originalModel`）；
- **事件记录**：切换与结算事件写入 `model-failover-events.jsonl`，可用 `/model-failover status` 查看；
- **终态广播**：计划内回退交接彻底失败时发布 `maestro-failover-terminal` 事件。

### 恢复协议

故障转移支持恢复协议（`RECOVERY_PROTOCOL_VERSION` 版本化）：失败回合可在备用模型上从原请求**重头续跑**，注入明确的重试提示，避免半完成状态。

## 3. Vision 委托关联

通过 `/api-manager vision <id>` 关联 Vision 模型，或按[Vision 多模态委托](/guides/vision-config)配置独立委托。

## 下一步

- [模型路由与思考深度](/guides/model-routing) — 逐任务模型与 fallbackModels
- [设置系统总览](/guides/settings-overview) — 配置持久化与并发锁
- [环境变量速查](/guides/env-vars) — Provider 相关环境变量
