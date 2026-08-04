---
title: "Hooks 自动化与快捷键"
icon: "🪝"
---

项目级钩子系统（Codex 兼容）+ 快捷键冲突检测与修复。

---

## 1. Hooks 自动化

项目级钩子系统，内置安装器与信任审查。

### 核心能力

| 能力 | 说明 |
|------|------|
| **项目级钩子** | 在项目目录配置，随项目分发 |
| **Codex 兼容** | 支持 Codex 风格的 hook 配置格式 |
| **内置安装器** | 引导式安装预设钩子集合 |
| **信任审查** | 钩子配置首次加载需信任确认，支持撤销信任 |
| **命令钩子** | 按命令匹配执行（`getMatchingCommandHooks` / `runMatchingCommandHooks`） |
| **开关管理** | 钩子启用/停用持久化（`setHookEnabled`） |

### 配置与信任

```bash
# 查看/安装预设钩子（TUI 引导）
/maestro-hooks

# 信任 / 撤销信任钩子配置
/maestro-hooks trust
/maestro-hooks revoke
```

钩子配置经过 Schema 校验（`validateCodexHooks`），非法配置直接报错（fail-closed），不会半启用。

> 安装器 TUI 的完整按键（`/` 筛选、`Space` 勾选、`A` 应用、`U` 卸载）见 [TUI 操作指南](/guides/tui-guide)。

### 安装器预设

内置安装器支持按预设合并钩子（`maestroHookDefinitions` / `hooksForPreset`），merge 后的定义可再次审查，避免盲装。

## 2. 快捷键冲突管理

自动检测并修复 **Shift+Tab** 等快捷键冲突（`~/.pi/agent/keybindings.json`）。

### 工作原理

- 安装时运行 `configure-keybindings.mjs` 扫描 Pi 默认键位；
- 检测到冲突时生成修复配置：
  - **思考强度** → `Ctrl+Shift+E`
  - **Maestro** → `Shift+Tab`（切换 approval mode）
- 冲突修复保存到 `keybindings.json`，执行 `/reload` 生效。

### 手动操作

| 命令 | 用途 |
|------|------|
| `/maestro-keybindings` | 查看/修复快捷键冲突 |
| 重启 Pi | 触发启动时冲突检测 |

> 修复策略是**最小干预**：仅当检测到实际冲突时才写入配置；未变化的配置不会重复写入（幂等）。

## 3. 与权限系统协同

钩子运行在父进程，拥有实时模式、会话规则与持久化；子进程的权限请求通过 IPC 中继（详见[权限系统](/guides/permissions)）。

## 下一步

- [权限系统](/guides/permissions) — 钩子与权限协同
- [环境变量速查](/guides/env-vars) — 钩子相关环境变量
- [设置系统总览](/guides/settings-overview) — keybindings.json 所在目录
