# Release v0.4.7 — 2026-07-13

## 概述

v0.4.7 调整 Plan Mode 的工具访问边界：进入 Plan Mode 后保留宿主已经启用的所有非编辑工具，不再依赖固定 allowlist；Shell guard 则聚焦阻止文件系统、包管理器、Git 和 Maestro 安装状态的写操作。与此同时，`pi-maestro-teammate` 改为明确的 runtime dependency，确保安装 `pi-maestro-flow` 后 teammate 能力可直接加载。

## 详细变更

### Plan Mode 工具可用性

- Plan Mode 从固定工具 allowlist 改为保留 Act snapshot 中的所有非编辑工具。
- 继续阻止 `Edit`、`Write`、`NotebookEdit` 及其小写别名，并隐藏 `plan-enter`。
- 自定义只读工具、测试命令、分析脚本和组合式只读 Shell 命令现在可以在 Plan Mode 中继续使用。
- `maestro delegate` 仍强制使用 `mode='analysis'`，避免通过委派进入写模式。

### Shell 写操作防护

- 新增面向 Bash 和 PowerShell 的命令边界检测，阻止文件创建、覆盖、复制、移动、删除和权限修改。
- 阻止 `npm`、`yarn`、`pnpm`、`bun`、`pip` 的安装、更新、发布和版本修改命令。
- 阻止 Git commit、push、merge、rebase、reset、restore、tag 等仓库状态变更。
- 阻止 `maestro install`、`maestro uninstall`、`maestro update` 以及 `sed -i`、`perl -i`、`find -exec` 等间接写入形式。
- 引号中的说明文字不会被误判为真实写命令，允许 `echo 'rm cp mv are write commands'` 等只读输出。

### 安装依赖

- 将 `pi-maestro-teammate` 从 optional peer dependency 调整为 `^0.4.3` runtime dependency。
- 同步更新 workspace lockfile 和 package resource contract 测试。
- npm tarball 排除 Python `__pycache__` 和 `*.pyc` 缓存文件。

## 版本

| 包 | 旧版本 | 新版本 |
|---|---:|---:|
| `pi-maestro-flow` | 0.4.6 | 0.4.7 |
| `pi-maestro-teammate` | 0.4.3 | 0.4.3 |

## 变更统计

- 6 个发布相关文件发生变化。
- Plan lifecycle suite：40/40 通过。
- Package resource suite：3/3 通过。
- `git diff --check` 通过。
- npm package dry-run 在正式发布前执行。

## 安装

```bash
pi install npm:pi-maestro-flow@0.4.7
```

也可以使用 npm：

```bash
npm install pi-maestro-flow@0.4.7
```

`pi-maestro-teammate@^0.4.3` 会作为 runtime dependency 自动安装。

## 升级说明

这是向后兼容的 patch 更新。升级后执行 `/reload` 或重启 Pi。Plan Mode 将继续阻止文件和仓库写操作，但不再隐藏第三方只读工具或常规分析命令。
