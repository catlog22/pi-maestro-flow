# Qwen 1M 与本地 400K 差异

## 结论

本地 Qwen 注册元数据明确配置为 `contextWindow: 400000`。Pi 将该值加载到当前模型，compact TUI 仅原样显示。模型服务端是否支持 1M，不会自动更新本地注册元数据。

## 假设检验

| 假设 | 结果 | 证据 |
|---|---|---|
| 源码默认值是 400K | 确认 | `api-provider-config.ts:86` |
| 本机模型配置覆盖为 400K | 确认 | `models.json:59` |
| compact TUI 自行限制为 400K | 排除 | `compaction-settings.ts:495` |
