---
title: "安装与初始化"
icon: "📦"
---

pi-maestro-flow 是 **Pi 插件**，用 `pi install` 安装（不是普通 npm 依赖）。装一个即得全部三个插件：flow、teammate、cockpit。

> **v0.18.0 已发布：** 修复 v0.17.0 的 Skill 发现回归（v0.17.0 已撤回）。npm `latest` 与下方固定版本均为 `0.18.0`；已安装 0.17.0 的用户直接覆盖安装即可，不要先运行 `pi remove`。

---

## 前置条件

| 组件 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | ≥ 22.19.0 | 插件运行时 |
| [Pi Coding Agent](https://github.com/earendil-works/pi) | ≥ 0.83.0 | 验证基线 0.83.0；0.84（dynamic TUI）已验证兼容。核心包由 Pi 提供 |

> [Maestro Flow](https://github.com/catlog22/maestro-flow)（知识系统 CLI）作为依赖随插件自动安装，无需单独前置安装。

## 安装

```bash
# 1. 安装宿主运行时（全局）
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# 2. 安装或升级插件（pi-maestro-teammate 作为依赖自动安装）
pi install npm:pi-maestro-flow@0.21.6

# 3. 验证 Flow、Teammate 和 Cockpit 均已列出
pi list
```

安装 `pi-maestro-flow` 会自动拉取并注册 `pi-maestro-teammate` 与 `pi-cockpit`。

> 安装或升级前请先关闭正在运行的 Pi。完成安装后重新启动 Pi，再进行模型、Teammate 或 Cockpit 操作，确保 companion 注册与内存设置均从磁盘重新加载。

## 升级与迁移

升级会迁移由 Flow 管理的旧 companion 注册路径；同名的**本地开发覆盖会被保留**，并在启动日志中提示，需由用户自行升级或移除。

```bash
pi install npm:pi-maestro-flow@<新版本>   # 升级到指定版本
```

## 插件注册的工具总览

安装后，插件向 Pi 注册以下工具：

| 来源包 | 工具 | 用途 |
|--------|------|------|
| pi-maestro-teammate | `teammate` | 多智能体调度（单任务/并行/DAG） |
| pi-maestro-teammate | `teammate-send` / `teammate-list` | Agent 控制（`teammate-watch` / `teammate-wait` 为旧版，需 `PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS=1`，新代码用 `observe`） |
| pi-maestro-flow | `maestro` | 知识感知调度（explore / delegate / moa） |
| pi-maestro-flow | `goal` | 长时目标生命周期管理 |
| pi-maestro-flow | `todo` | 任务分解与跟踪 |
| pi-maestro-flow | `run-control` | 工作流 Run 生命周期 |
| pi-maestro-flow | `ask-user-question` | 结构化用户输入收集 |
| pi-maestro-flow | `lsp` / `browser` / `smart_search` / `ffgrep` / `fffind` / `search_tool_bm25` | 智能工具 |
| pi-maestro-flow | `plan-enter` 等 `plan-*` | 计划模式 |

## 验证安装

```bash
pi list                # 三个插件均已列出
/maestro-help          # 命令帮助系统可用
```

也可在会话中直接调用任一工具（如 `todo({ action: "list" })`）验证注册。

## 常见问题

### 工具未生效

- 重启 Pi 或执行 reload extensions；
- 确认 `pi list` 中三个包均已注册；
- 升级后旧 companion 路径冲突时，按启动日志提示移除或升级本地覆盖。

### 更新后启动即崩溃（companion 版本错配）

更新核心 `pi-coding-agent` 后启动时若报 `TypeError: Cannot read properties of undefined (reading 'runtime')`（`model-registry.js` 的 `refresh` 中），多半是**本地旧版 teammate 覆盖被保留**：启动日志会出现 `Preserved local companion override for pi-maestro-teammate: ...`。修复：

```bash
# 方式 A：升级本地覆盖到最新
cd /mnt/c/Users/<用户名>          # Windows: cd C:\Users\<用户名>
npm install pi-maestro-teammate@1.9.0 pi-cockpit@0.11.0

# 方式 B：删除本地覆盖，交给 flow 统一管理
rm -rf node_modules/pi-maestro-teammate node_modules/pi-cockpit
pi install npm:pi-maestro-flow@0.21.6
```

升级的 companion 包与核心版本不匹配时同样会导致该崩溃（旧版扩展分离调用核心 `refresh()` 方法，`this` 绑定丢失）。确保 teammate ≥ 1.7.1 或直接使用最新版。

### 模型相关操作失败

插件升级后部分模型能力（如思考深度、Vision 委托）依赖运行时重新加载，请先重启。

## 下一步

- [快速开始](/guides/quick-start) — 最短路径上手
- [架构与核心概念](/guides/architecture) — 三插件分层
- [设置系统总览](/guides/settings-overview) — 配置文件的全局结构
