---
title: Pi 通用 Provider 登录与 teammate 模型路由配置
description: 记录 OpenAI/Anthropic 自定义 URL 登录与 teammate 角色模型映射的配置契约
type: asset
category: arch
assetType: config
codePaths:
  - packages/pi-maestro-flow/src/providers/login-provider-config.ts
  - packages/pi-maestro-teammate/src/models/model-routing.ts
  - packages/pi-maestro-teammate/src/tui/model-mapping-overlay.ts
created: 2026-07-13T00:00:00+08:00
tags: [提供商配置, 登录, 模型路由, 角色映射, 终端界面]
status: deprecated
supersededBy: AST-20260717-native-api-provider-isolation-contract
---

# Pi 通用 Provider 登录与 teammate 模型路由配置

> Deprecated：Provider 登录部分已由 `AST-20260717-native-api-provider-isolation-contract` 替代。teammate 模型路由章节仅保留为历史参考。

## Overview

Maestro 在 Pi 原生 `/login` 中注册两个通用 provider：`maestro-openai` 和 `maestro-anthropic`。用户可以在登录流程中指定 `Base URL`、`model ID` 与 `API key`，无需为每个 OpenAI-compatible 或 Anthropic-compatible 服务单独编写扩展。

Provider 认证与 teammate 路由保持职责分离：

- `/login` 管理 provider、URL、模型注册信息与凭证。
- `/teammate-models` 或 `Alt+M` 将当前已认证模型映射到 teammate 任务角色。
- 显式 task-level `model` 始终覆盖 top-level model 与自动映射。

## Structure

### Provider 登录配置

| Provider ID | API 格式 | 默认 URL | 登录字段 |
|---|---|---|---|
| `maestro-openai` | `openai-completions` | `https://api.openai.com/v1` | Base URL、model ID、API key |
| `maestro-anthropic` | `anthropic-messages` | `https://api.anthropic.com` | Base URL、model ID、API key |

Pi 的普通 API-key 登录只采集单个 key。为了在原生 `/login` 内完成多字段配置，Maestro 使用 extension OAuth hook 作为交互和持久化通道：

- `access` 保存 API key。
- `refresh` 保存版本化的 `format`、`baseUrl` 和 `modelId` JSON。
- `modifyModels()` 在认证后将占位模型替换为用户配置的模型和 URL。
- `refreshToken()` 对长期 API key 凭证保持原值。

因此这两个入口位于 `/login` 的 `Use a subscription` 分组，但实际语义是自定义 endpoint + API key 配置。

### Teammate 角色映射

| Task type | 角色提示 | 用途 |
|---|---|---|
| `explore` | `explorer` | 文件发现、定义和调用点定位 |
| `analysis` | `delegate / analyst` | 只读执行链追踪和技术分析 |
| `debug` | `debugger` | 根因诊断和运行时调试 |
| `planning` | `planner / architect` | 架构与执行规划 |
| `development` | `developer / worker` | 实现和重构 |
| `review` | `reviewer` | 正确性、质量和安全审查 |
| `testing` | `tester / qa` | 测试、覆盖率和回归验证 |

项目映射写入 `.pi/teammate-models.json`，并覆盖全局 `~/.pi/agent/teammate-models.json`。配置为 `auto` 时不强制指定模型，由 agent 默认值或自动路由决定。已配置但当前未认证的模型显示为 `unavailable`，运行时不会发起无效模型调用。

模型选择优先级为：

1. task-level `model`；
2. top-level `model`；
3. 显式 `taskType` 映射；
4. 推断出的 task type 映射；
5. agent 默认模型。

## Usage

1. 在 Pi 中执行 `/login`。
2. 选择 `Use a subscription`。
3. 选择 `Maestro Custom OpenAI (URL + API key)` 或 `Maestro Custom Anthropic (URL + API key)`。
4. 输入 endpoint URL、model ID 和 API key。
5. 执行 `/teammate-models` 或按 `Alt+M`。
6. 选择任务角色，再从当前已认证模型列表中选择映射。
7. 执行 `/reload` 或重启 Pi，使新 provider catalog 在所有扩展中重新加载。

## Verification

- `npm run test:providers --workspace packages/pi-maestro-flow`：3/3 通过。
- `npm test --workspace packages/pi-maestro-teammate`：41/41 通过。
- `npm run test:package --workspace packages/pi-maestro-flow`：3/3 通过。
- `git diff --check`：通过。
- 仓库级 `tsc` 仍存在既有 `.ts` import、`AgentToolResult<T>` 等基线错误，本次新增文件没有独立类型错误。

## Related Code Paths

- `packages/pi-maestro-flow/src/providers/login-provider-config.ts`
- `packages/pi-maestro-flow/src/extension/index.ts`
- `packages/pi-maestro-flow/test/login-provider-config.test.ts`
- `packages/pi-maestro-teammate/src/models/model-routing.ts`
- `packages/pi-maestro-teammate/src/tui/model-mapping-overlay.ts`
- `packages/pi-maestro-teammate/test/model-routing.test.ts`
