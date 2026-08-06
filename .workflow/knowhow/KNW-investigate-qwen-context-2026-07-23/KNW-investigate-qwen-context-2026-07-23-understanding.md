# Qwen 上下文配置理解

- 问题：Qwen 支持 1M，但本地为何显示约 400K。
- 已确认：源码默认值和本机 `models.json` 都是 `400000`。
- 已排除：compact TUI 不会把 1M 限幅为 400K。
- 数据链：API Manager 默认值 → `models.json` → Pi `ctx.model.contextWindow` → compact TUI。
