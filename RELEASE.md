# Release v0.4.6 — 2026-07-13

## 概述

v0.4.6 为 Pi 增加通用的 OpenAI-compatible 与 Anthropic-compatible provider 登录配置，并把 teammate 的角色、任务类型和模型映射关系完整呈现在配置界面中。用户现在可以直接通过 `/login` 配置自定义 endpoint，再通过 `/teammate-models` 或 `Alt+M` 将已认证模型分配给不同工作角色。

## 详细变更

### 通用 Provider 登录配置

- 新增 `maestro-openai` provider，使用 `openai-completions` API 格式。
- 新增 `maestro-anthropic` provider，使用 `anthropic-messages` API 格式。
- 登录流程支持输入 `Base URL`、`model ID` 和 `API key`。
- 复用 Pi 原生 OAuth credential hook 保存多字段配置，并在认证后动态修改模型 ID 与 endpoint。
- URL 仅允许 `http` 或 `https`，自动清除末尾 `/`。
- 新增 provider 配置、凭证序列化、URL 校验和动态模型修改测试。

### Teammate 角色与模型映射

- 配置界面标题更新为 `Teammate Role & Model Routing`。
- 为 `explore`、`analysis`、`debug`、`planning`、`development`、`review` 和 `testing` 增加角色提示及用途描述。
- 第一层列表同时显示角色类别和当前生效模型或 `auto` 状态。
- 第二层模型选择界面显示对应角色提示，继续保留 `active`、`unavailable` 与 `auto / agent default` 状态。
- 项目级 `.pi/teammate-models.json` 与全局配置覆盖规则保持兼容。

### 文档与知识沉淀

- 新增 knowhow：`AST-20260713-pi-provider-login-teammate-model-routing.md`。
- 记录 provider credential 契约、teammate 映射优先级、操作步骤、限制和验证结果。

## 版本

| 包 | 旧版本 | 新版本 |
|---|---:|---:|
| `pi-maestro-flow` | 0.4.5 | 0.4.6 |
| `pi-maestro-teammate` | 0.4.2 | 0.4.3 |

## 验证

- Provider focused tests：3/3 通过。
- Teammate package tests：41/41 通过。
- Package resource runtime tests：3/3 通过。
- `git diff --check` 通过。
- npm package dry-run 在正式发布前执行。

## 安装

```bash
pi install npm:pi-maestro-flow@0.4.6
pi install npm:pi-maestro-teammate@0.4.3
```

也可以使用 npm：

```bash
npm install pi-maestro-flow@0.4.6 pi-maestro-teammate@0.4.3
```

## 升级说明

这是向后兼容的 patch 更新。升级后执行 `/reload` 或重启 Pi。随后通过 `/login` 添加通用 provider，并使用 `/teammate-models` 或 `Alt+M` 配置角色模型映射。
