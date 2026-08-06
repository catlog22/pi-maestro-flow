# Understanding: Pi `/login` API Provider 配置

## Question

如何让可配置 `Base URL`、model 与 reasoning 的 OpenAI Responses / Anthropic custom provider 进入 `/login` 的 API-key 渠道，而不污染 DeepSeek？

## Scope

- 上游：`G:\github_lib\pi`
- 当前插件：`D:\pi-maestro-flow`
- 版本：上游 `0.80.3`；当前开发依赖 `0.74.0`

## Hypotheses

| Hypothesis | Verdict | Evidence |
|---|---|---|
| 原生 API-key dialog 可直接输入 Base URL | Disproved | `interactive-mode.ts:5109-5142` 只采集 API key |
| custom provider 注册模型且不注册 OAuth 时会进入 API 渠道 | Confirmed | `interactive-mode.ts:4873-4896` |
| URL/model/reasoning 应由 `registerProvider()` 或 `models.json` 提供 | Confirmed | `extensions/types.ts:1398-1428`、`model-registry.ts:828-890` |
| 必须借 subscription OAuth 才能持久化自定义 URL | Disproved | API provider 配置与 auth credential 是独立边界 |

## Pattern

Custom API provider 使用两段式配置：provider registration/models.json 管理公开连接与模型能力；`/login` API-key branch 只管理 secret。不得用 OAuth `modifyModels()` 模拟 API 配置。

Convention status：candidate for architecture spec；证据已记录于 `evidence.ndjson`。
