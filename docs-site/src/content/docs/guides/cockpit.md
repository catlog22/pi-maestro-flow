---
title: "Pi Cockpit 可视化"
icon: "🖥️"
---

pi-cockpit 提供编辑器上方实时状态堆栈 + Starship 风格 Footer，以及终端 Tab 标题、主题系统与 Quiet 模式。配置持久化于 `~/.pi/agent/cockpit.json`（首次运行自动创建）。

---

## 功能总览

- **状态堆栈**：实时呈现运行中的 teammate 与 todo 计划
- **Starship 风格 Footer**：当前模式、压缩状态、MCP 连接状态等
- **9 套主题**：内置主题切换，`/theme` 实时预览
- **Quiet 模式**：压缩内置工具输出、折叠思考块
- **终端标题**：Claude Code 风格 Tab 标题 + 可选 LLM 生成会话摘要
- **Sidebar Dock**：编辑器侧边停靠栏（模式/宽度/密度可配）
- **背景任务覆盖层**：`Alt+J` 查看 bash_bg 任务实时状态

## 配置文件

```json
{
  "enabled": true,
  "quietMode": false,
  "quietSymbols": "check",
  "agentsMode": "list",
  "todoMode": "list",
  "todoExpanded": false,
  "hideNativeAgents": true,
  "icons": { "mode": "auto" },
  "sidebar": {
    "mode": "off",
    "width": 40,
    "density": "comfortable"
  },
  "title": {
    "enabled": true,
    "showSession": true,
    "showCwd": false,
    "showModel": false,
    "showThinking": false,
    "showGit": false,
    "showMaestro": false,
    "maxLength": 80
  },
  "theme": ""
}
```

## 配置项详解

### 基础

| 键 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 总开关 |
| `quietMode` | `false` | `true` 时压缩内置工具渲染、折叠思考块 |
| `quietSymbols` | `"check"` | 工具行生命周期字形：`check`（✓/✗/⋯）或 `dot`（●/○/◌） |
| `agentsMode` / `todoMode` | `"list"` | 状态列表密度：`list` 或 `compact` |
| `todoExpanded` | `false` | 默认展开 todo 组件 |
| `hideNativeAgents` | `true` | 清除 teammate 扩展自带的 `teammate-agents` 组件，避免重复绘制 |
| `theme` | `""` | 命名主题覆盖；空字符串跟随 Pi 会话主题 |

### Sidebar Dock

| 键 | 默认 | 说明 |
|----|------|------|
| `sidebar.mode` | `"off"` | `auto`/`on` 在主列 ≥72 + 侧栏 ≥32 时启用停靠；`off` 始终用组件（默认） |
| `sidebar.width` | `40` | 停靠宽度，钳制在 `32..56` |
| `sidebar.density` | `"comfortable"` | `comfortable` 或 `compact` |

> 不要同时启用 pi-cockpit 的 dock 与 `pi-atelier@0.7.0` 的 sidebar（两者包装同一渲染器）。使用 Atelier 时设 `"sidebar": { "mode": "off" }`。

### 终端标题

标题格式：`frame + pi - <会话> - <工作状态>`。运行中显示 `⠂/⠐` 转轮，空闲 `✳`，失败 `✗`，退出时自动清空。

| 键 | 默认 | 说明 |
|----|------|------|
| `title.enabled` | `true` | 主开关 |
| `title.showSession` | `true` | 在 `pi` 后附加会话摘要 |
| `title.showCwd` | `false` | 附加工作目录 |
| `title.showModel` | `false` | 附加模型标签（`m:gpt-5.6-sol`） |
| `title.showThinking` | `false` | 附加思考级别标签（`t:high`） |
| `title.showGit` | `false` | 附加 git 分支标签（`git:main`），同步读取 `.git/HEAD` 零开销 |
| `title.showMaestro` | `false` | 附加工作流状态标签（`wf:running`） |
| `title.maxLength` | `80` | 标题长度上限，钳制 `20..200`，中间省略 |
| `title.generationModel` | `""` | LLM 生成标题的模型（`provider/model`，需在 `/api-manager` 注册）；空则用规则提取器 |

标题优先级：`/session name` > LLM 生成 > 规则提取 > 短会话 ID。LLM 生成于首个完整回合后进行，10 秒超时，`thinking` 关闭控成本；失败自动回退规则提取。

### 图标

| 键 | 默认 | 说明 |
|----|------|------|
| `icons.mode` | `"auto"` | `auto`（检测 Nerd Font）、`nerd`、`ascii` |

## 命令速查

| 命令 | 用途 |
|------|------|
| `/cockpit` | 打开设置覆盖层（TUI 按键见 [TUI 操作指南](/guides/tui-guide)） |
| `/maestro-settings` | 统一设置面板（Cockpit / Flow / Teammate / 集成） |
| `/cockpit quiet` | 切换 Quiet 模式 |
| `/cockpit sidebar auto\|on\|off` | 选择停靠行为 |
| `/cockpit sidebar resize` / `Ctrl+Shift+R` | 临时 Resize 模式（方向键调整，Enter 接受，Esc 回滚） |
| `/cockpit sidebar` | 报告当前侧栏模式/宽度/密度 |
| `/theme <name>` | 切换主题（带实时预览） |
| `Alt+J` | 打开后台 Bash 任务覆盖层 |
| `Alt+Shift+P` | 切换 Plan/Act 模式 |

## 下一步

- [Mailbox 消息队列与会话导出](/guides/mailbox-session) — 会话相关能力
- [设置系统总览](/guides/settings-overview) — 统一设置面板结构
- [环境变量速查](/guides/env-vars) — 主题与界面相关环境变量
