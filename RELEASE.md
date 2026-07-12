# Release v0.4.5 — 2026-07-13

## 概述

v0.4.5 统一了 `pi-maestro-flow` 的安装包资源边界：Pi workflow skills 现在作为插件自身的标准 package resources 发布，不再扫描 `maestro-flow` 依赖包中的兼容镜像；Pi 专用 `AGENTS.md` 也随插件发布并由扩展稳定注入。同时改进 Plan 确认浮层，使全部执行选项保持可见。

## 改进

### 标准 Pi skill package resources

- 将 113 个 canonical skills 迁移到 `packages/pi-maestro-flow/.pi/skills/`。
- 在 package manifest 中通过 `pi.skills` 声明 `./.pi/skills`，用户执行 `pi install npm:pi-maestro-flow` 后由 Pi 标准 package loader 自动发现。
- 删除对 `node_modules/maestro-flow/.agents/skills` 的 `resources_discover` 注册，避免依赖包兼容副本进入候选列表并显示 `(skipped)`。
- 根目录 `.pi/settings.json` 指向 package 内的同一 skill source，开发环境和发布包不再维护两套副本。

### Pi 专用项目说明

- 将根目录 `AGENTS.md` 移入 `packages/pi-maestro-flow/AGENTS.md`，避免其他 coding agent 按根目录约定自动注入 Pi 专用规则。
- npm package 明确包含 `AGENTS.md`。
- 插件通过 `before_agent_start` 读取安装包内文档，并以 `<project_instructions>` 形式追加到 Pi system prompt。

### Plan 确认浮层

- Plan confirmation 底部由单一当前动作改为完整动作列表。
- 保留当前选中项、不可用状态和宽终端说明文本，使执行选择更直观。
- 补充对应渲染与交互测试。

## 验证

- Package resource tests：3/3 通过。
- Plan、PlanStore、Plan editor 与 Statusline：40/40 通过。
- `npm pack --dry-run` 已确认包含 `AGENTS.md`、`.pi/skills/workflow-skill-designer/SKILL.md` 等 package resources。
- 模拟 Pi `before_agent_start` 已确认 bundled `AGENTS.md` 正确进入 system prompt。

## 版本

| 包 | 旧版本 | 新版本 |
|---|---:|---:|
| `pi-maestro-flow` | 0.4.4 | 0.4.5 |

`pi-maestro-teammate` 本次没有代码变更，继续保持 `0.4.2`。

## 安装

```bash
pi install npm:pi-maestro-flow@0.4.5
```

也可以通过 npm 安装：

```bash
npm install pi-maestro-flow@0.4.5
```

## 升级说明

这是向后兼容的 patch 更新。升级后建议在 Pi 中执行 `/reload` 或重启会话，使新的 package skills 和 bundled instructions 生效。项目无需再从 `maestro-flow/.agents/skills` 获取 workflow skills。
