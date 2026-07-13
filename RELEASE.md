# Release v0.4.8 — 2026-07-14

## 概述

v0.4.8 简化 Maestro 内置 OpenAI 与 Anthropic provider 的注册方式：改用 Pi 原生 API key provider 配置，直接读取标准环境变量，并移除此前借用 OAuth 流程采集 endpoint、model ID 与 API key 的实现。OpenAI provider 同步切换到 `openai-responses` API，并声明 GPT-5 的 reasoning 与上下文能力。

## 详细变更

### Provider 注册

- `maestro-openai` 改用 `OPENAI_API_KEY`，默认连接 `https://api.openai.com/v1`。
- OpenAI API 从 `openai-completions` 切换为 `openai-responses`。
- 默认 GPT-5 模型启用 reasoning，声明 400K context window 与 128K max tokens。
- `maestro-anthropic` 改用 `ANTHROPIC_API_KEY`，继续使用 `anthropic-messages` API。
- 移除 OAuth credential 编解码、自定义 URL/model prompt 和 refresh token 逻辑，使 provider 与 Pi 原生 API key 登录机制保持一致。

### 测试与仓库维护

- 更新 provider contract test，验证 provider ID、API 类型、环境变量、模型能力与 OAuth 移除结果。
- 扩展 `.gitignore`，忽略 Maestro 运行时目录与 Python cache，避免生成物进入版本控制。

## 版本

| 包 | 旧版本 | 新版本 |
|---|---:|---:|
| `pi-maestro-flow` | 0.4.7 | 0.4.8 |
| `pi-maestro-teammate` | 0.4.3 | 0.4.3 |

## 变更统计

- 自 `v0.4.7` 起共 2 个功能/维护变更组。
- Provider suite：1/1 通过。
- Package resource suite：3/3 通过。
- `git diff --check` 通过。
- npm package dry-run 在版本更新后执行。

## 安装

```bash
pi install npm:pi-maestro-flow@0.4.8
```

也可以使用 npm：

```bash
npm install pi-maestro-flow@0.4.8
```

## 升级说明

这是 patch 更新。升级后执行 `/reload` 或重启 Pi。使用 OpenAI 时配置 `OPENAI_API_KEY`，使用 Anthropic 时配置 `ANTHROPIC_API_KEY`；此前通过 Maestro OAuth provider 保存的自定义 URL、model ID 与 API key 不再使用。
