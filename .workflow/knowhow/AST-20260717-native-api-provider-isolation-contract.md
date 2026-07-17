---
title: Pi 原生 API Provider 与跨 Provider 隔离契约
description: 记录 OpenAI Responses 和 Anthropic 必须使用原生 API 配置并隔离 DeepSeek 模型
type: asset
category: arch
assetType: config
codePaths:
  - packages/pi-maestro-flow/src/providers/api-provider-config.ts
  - packages/pi-maestro-flow/test/api-provider-config.test.ts
created: 2026-07-17T13:55:00+08:00
tags: [接口配置, 提供商隔离, 自定义地址, 推理强度, 模型目录]
status: active
---

# Pi 原生 API Provider 与跨 Provider 隔离契约

## 当前契约

OpenAI Responses 与 Anthropic 必须复用 Pi 内置 provider：

| Provider ID | 显示名 | API | 认证入口 |
|---|---|---|---|
| `maestro-openai` | `OpenAI Responses (Custom)` | `openai-responses` | `/login` → `Use an API key` |
| `maestro-anthropic` | `Anthropic (Custom)` | `anthropic-messages` | `/login` → `Use an API key` |

扩展为两个 custom provider 注册模型与 API 元数据，但不得注册 `oauth` 或 `modifyModels()`。Provider 通过 Pi Extension `apiKeyLogin` hook，在 `/login` 的 API-key 分组内依次采集 Base URL、model ID、reasoning capability 与 API key，不再注册额外的 `/api-provider` 命令。

## 自定义 API 配置

自定义 `Base URL`、model ID 与推理能力由同一 `/login` 流程原子写入 Pi 原生 `~/.pi/agent/models.json`：

```json
{
  "providers": {
    "maestro-openai": {
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-responses",
      "apiKey": "$OPENAI_API_KEY",
      "models": [{
        "id": "gpt-5.4",
        "reasoning": true,
        "thinkingLevelMap": { "off": null, "xhigh": "xhigh" }
      }]
    }
  }
}
```

两个 `maestro-*` provider 是 extension 注册的 custom provider。`apiKeyLogin` 返回的 credential 由 Pi 写入 `auth.json`；回调只把公开连接配置写入 `models.json`。保存后 extension 先注销默认模型注册，再以 name + `apiKeyLogin` 重新注册，使 Pi refresh 时从 `models.json` 重新加载 URL、model 与 reasoning。写入前必须保留其他 provider 与未知根字段；已有文件先生成旁路备份，再以临时文件 + rename 提交。

该单入口依赖 Pi Extension API 暴露 provider-specific `apiKeyLogin`。Pi 原生 `AuthInteraction` 已支持 text、secret 与 select，多步表单不得再通过 subscription OAuth 模拟。

## 隔离规则

Pi 0.74 的 OAuth `modifyModels()` 接收完整全局模型数组。任何未按 `model.provider` 过滤的 map 都会改写 DeepSeek 等其他 provider。通用 API provider 禁止借用 subscription OAuth 采集配置。

回归测试必须同时证明：

- OpenAI 内置模型使用 `openai-responses`，Anthropic 使用 `anthropic-messages`；
- 配置后的注册仅包含 name 与 `apiKeyLogin`，不含 OAuth 与模型替换；
- 单次 API-key login 必须按顺序采集 URL、model、reasoning 与 key，并由 Pi credential store 保存 key；
- `models.json` 自定义 OpenAI URL、model 与 reasoning 后，`deepseek-v4-pro` 的 ID 和名称保持不变。
