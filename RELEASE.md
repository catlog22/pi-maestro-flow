# Release v0.4.4 — 2026-07-12

## 概述

v0.4.4 是 `pi-maestro-flow` 的 UI patch 版本，统一 Plan、Approval 与 Todo 的终端展示层级，并将 Plan 确认页收敛为类似 Agent viewer 的居中 overlay。

## 改进

### Plan 确认 overlay

- 从占满终端的 `100% × 100%` 页面调整为居中的 `100 × 28` overlay。
- 使用与 Agent viewer 一致的细边框、主体内容区和底部快捷键带。
- 操作列表改为 progressive disclosure：默认只显示当前选项及说明，保留 `↑↓` 切换全部 5 个动作。
- Plan Markdown 保持独立滚动，并继续支持 `PgUp/PgDn`、`Ctrl+Enter` 和窄终端 compact 降级。

### 多模式状态仲裁

- Plan 模式成为 `ACT / PLAN / READY` 的唯一状态所有者。
- Plan 激活时隐藏重复的 `APPROVAL plan`，退出后恢复实际 Approval 状态。
- 修复通过不同快捷键切换 Plan 时 Approval 状态可能残留或互相矛盾的问题。
- Todo 继续作为独立任务进度面板，可与 Plan 模式并存而不重复表达模式语义。

## 验证

- Plan、PlanStore、Plan editor 与 Statusline：40/40 通过。
- Todo 与 skill loader：20/20 通过。
- Approval mode focused tests：2/2 通过。
- 本次相关验证合计：62/62 通过。

## 版本

| 包 | 旧版本 | 新版本 |
|---|---:|---:|
| `pi-maestro-flow` | 0.4.3 | 0.4.4 |

`pi-maestro-teammate` 本次没有代码变更，继续保持现有版本。

## 安装

```bash
npm install pi-maestro-flow@0.4.4
```

## 升级说明

这是向后兼容的 patch 更新，无需迁移配置或持久化状态。Plan 的批准、修改、退出和不同执行上下文选项均保持原有语义，仅调整终端展示与模式状态仲裁。
