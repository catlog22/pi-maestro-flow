# Investigation Report: `/login` API Provider URL 配置

## Answer

`G:\github_lib\pi` 证明 custom provider 可以并且应该走 `/login` 的 `Use an API key` 渠道。条件是该 provider 已注册模型且没有 OAuth。原生 API-key dialog 本身只输入 key；`Base URL`、API 类型、model 与 reasoning capability 必须在 provider registration 或 `models.json` 中预先定义。

## Implementation Consequence

- 注册 `maestro-openai` 与 `maestro-anthropic` custom provider。
- 配置 `baseUrl`、`api`、`models` 与环境变量占位 `apiKey`。
- 禁止注册 `oauth` 与 `modifyModels()`。
- `/api-provider` 更新 `models.json` 后注销默认注册并以 name-only 重新注册，使 Pi 立即从原生配置重载。
- `/login` 的 API-key entry 保存真实 secret 到 `auth.json`。

## Verification

- Provider tests：5/5。
- TypeScript check：通过。
- Fresh Pi：`maestro-openai/gpt-5.4` 可见。
- DeepSeek：`deepseek-v4-flash`、`deepseek-v4-pro` 保持不变。
