---
title: "安装与初始化"
icon: "📦"
---

pi-maestro-flow 是 **Pi 插件**，用 `pi install` 安装（不是普通 npm 依赖）。装一个即得全部三个插件：flow、teammate、cockpit。

> **v0.32.1 依赖修补待发布（UNRELEASED）：** 准备 Flow 0.32.1、Backends 0.1.7、Teammate 2.8.1、Cockpit 0.24.3；引擎要求 `maestro-flow >=0.5.91`（范围而非精确 pin）。四个 `@dyw1234` 修补 fork 及不变契约见[更新日志](/guides/changelog)。验证和发布仍待完成，不声称安全/兼容验收通过。
>
> 下方安装命令保留 npm 已发布 **0.32.0** 功能基线，不包含本次修补，正式发布收尾暂停。已安装旧版的用户直接覆盖安装，不要先运行 `pi remove`；不要把未发布的 0.32.1 当作当前可安装最新版。

---

## 前置条件

| 组件 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | ≥ 22.19.0 | 插件运行时 |
| [Pi Coding Agent](https://github.com/earendil-works/pi) | 0.99.0 验证基线 | 0.99+ 使用原生能力；0.87–0.98 仅走版本门控 legacy 兼容；optional peer `*` 不变，核心包由 Pi 提供 |

> [Maestro Flow](https://github.com/catlog22/maestro-flow)（知识系统 CLI）作为依赖随插件自动安装，无需单独前置安装。

## 安装

```bash
# 1. 安装宿主运行时（全局）
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# 2. 安装或升级插件（pi-maestro-teammate 作为依赖自动安装）
pi install npm:pi-maestro-flow@0.32.0

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

## 原生宿主与可选组件

Pi 0.99+ 使用宿主原生工具发现、模型/classifier、MCP 和键盘能力；原生 API 缺失时不会启动第二套 legacy runtime。MCP 用 `/mcp` 与 `/mcp login <name>`；旧配置须先禁用 `builtin:mcp`，再运行 `/maestro-mcp-migrate` 预览并批准迁移，完成后恢复原生管理器。

- **DSH**：SDK 为 optional peer，仅使用 DSH 时需手动安装 `@deepseek-ai/dsh-sdk-client`（开发验证基线 `0.1.0-rc.6`）。普通 Pi 后端无需安装。
- **OpenCodeReview**：`open-code-review` 需要单独安装 `ocr` CLI，安装指引见包内 `optional/OCR-SETUP.md`；模型配置入口为 `/api-manager open-code-review`。
- **Browser Bridge**：`/install browser-bridge` 加载可选 MV3 扩展；paired 默认需配对，显式 NONE 不需 token/pair。先用 live status 验证，再明确选择 extension；见[浏览器指南](/guides/lsp-browser)。

## 插件注册的工具总览

安装后，插件向 Pi 注册以下工具：

| 来源包 | 工具 | 用途 |
|--------|------|------|
| pi-maestro-teammate | `teammate` | 多智能体调度（单任务/并行/DAG） |
| pi-maestro-teammate | `teammate-send` / `teammate-list` | Agent 控制（`teammate-watch` / `teammate-wait` 为旧版，需 `PI_TEAMMATE_LEGACY_OBSERVATION_TOOLS=1`，新代码用 `observe`） |
| pi-maestro-flow | `maestro` | 知识感知调度（explore / delegate / moa） |
| pi-maestro-flow | `goal` | 长时目标生命周期管理 |
| pi-maestro-flow | `todo` | 任务分解、持久化 handoff 与跟踪 |
| pi-maestro-flow | `board` | 工作区共享 Gateway Board：任务、claim、依赖、Session/Plan/Todo 链接，见 [Gateway Board](/guides/gateway-board) |
| pi-maestro-flow | `run-control` | 工作流 Run 生命周期 |
| pi-maestro-flow | `ask-user-question` | 结构化用户输入收集 |
| pi-maestro-flow | `lsp` / `browser` / `smart_search` / `search` / `fffind` / `search_tool_bm25` | 智能工具 |
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
# 方式 A：同步到 0.32.0 的 companion 基线（不含未发布修补）
cd /mnt/c/Users/<用户名>          # Windows: cd C:\Users\<用户名>
npm install pi-maestro-teammate@2.8.0 pi-cockpit@0.24.2

# 方式 B：删除本地覆盖，交给 flow 统一管理
rm -rf node_modules/pi-maestro-teammate node_modules/pi-cockpit
pi install npm:pi-maestro-flow@0.32.0
```

升级的 companion 包与核心版本不匹配时同样会导致该崩溃（旧版扩展分离调用核心 `refresh()` 方法，`this` 绑定丢失）。确保 teammate ≥ 1.7.1 或直接使用最新版。

### 模型相关操作失败

插件升级后部分模型能力（如思考深度、Vision 委托）依赖运行时重新加载，请先重启。

## 下一步

- [快速开始](/guides/quick-start) — 最短路径上手
- [架构与核心概念](/guides/architecture) — 三插件分层
- [设置系统总览](/guides/settings-overview) — 配置文件的全局结构
