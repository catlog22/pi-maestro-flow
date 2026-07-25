# pi-maestro-flow

<p align="center">
  <strong>🎼 Pi 编码智能体的多智能体编排层</strong><br />
  <em>将一个编码智能体，变成一支协同工程团队。</em>
</p>

<p align="center">
  <strong>中文</strong> | <a href="README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-maestro-flow"><img alt="npm" src="https://img.shields.io/npm/v/pi-maestro-flow?color=cb3837&logo=npm&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/pi-maestro-teammate"><img alt="npm" src="https://img.shields.io/npm/v/pi-maestro-teammate?color=cb3837&logo=npm&logoColor=white&label=teammate" /></a>
  <a href="https://github.com/catlog22/pi-maestro-flow"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-repo-blue?logo=github" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

---

## 核心特性

Pi 是强大的编码智能体 — 但一个智能体一次只能做一件事。**pi-maestro-flow** 让 Pi 拥有：

### 🔀 并行多智能体调度
一次派出多个子进程智能体并行工作。支持 DAG 依赖图、RPC 消息、结构化 Prompt 模板，每个任务可独立控制模型和思考深度。

```javascript
teammate({
  tasks: [
    { name: "defs", agent: "explorer", task: "FIND: Auth 导出\nSCOPE: src/auth/" },
    { name: "calls", agent: "explorer", task: "FIND: Auth 导入\nSCOPE: src/" },
    { name: "report", agent: "delegate", task: "合并 {defs} + {calls} 生成缺口报告" }
  ]
})
```

### 🎯 Goal 模式 — 自主长时目标
设定一个目标和可选的 Token 预算，智能体跨多轮自主循环执行。完成后由**独立验证器**审计完成声明。

```javascript
goal({ action: "create", objective: "实现 JWT 认证模块", tokenBudget: "100k" })
```

```bash
/goal status                 # 查看进度（输入框上方实时面板）
/goal stop                   # 暂停（状态持久化）
/goal resume --tokens 200k   # 恢复并提高预算
```

**工作流程：** 创建 → 自主循环（规划→执行→自检）→ 独立验证 → `pass` 自动完成 / `fail` 携带未满足需求继续 / `inconclusive` 等待用户恢复

### 📝 Plan 模式 — 先批准再动手
进入只读规划状态：起草 Markdown 计划，获得用户明确批准后才恢复编辑工具。

```bash
/plan                        # 切换 Plan/Act 模式（或 Alt+P）
/plan approve                # 批准计划，恢复编辑工具
```

**工作流程：** 进入计划模式（编辑工具被阻止）→ 起草计划 → 用户审批 → 提交并恢复 / 放弃不提交。适合复杂或高风险的多步骤工作。

### 🧠 持久化知识系统
语义搜索、规范（Spec）管理、经验（Knowhow）沉淀，跨会话存活。支持替代/冲突生命周期。

```bash
maestro search "认证模式" --code     # 语义搜索（跨 spec + 代码）
/spec-add coding "Result 类型" "..."  # 沉淀编码约定
```

### 🔌 全协议连接
- **MCP 客户端** — 统一代理工具访问任意 MCP 服务器（OAuth、UI 会话、流式传输）
- **LSP 集成** — 诊断、定义跳转、引用查找、重命名
- **浏览器控制** — 通过 CDP 控制 Chromium（截图、JS 执行）
- **网络搜索** — 快速查询、深度研究、URL 内容提取

### 🔒 权限控制
5 种权限模式（default / acceptEdits / plan / dontAsk / bypassPermissions），细粒度 allow/ask/deny 规则，teammate 子进程权限中继。

### 👥 27 个专业 Agent 角色
explorer、reviewer、debugger、planner、verifier、roadmapper… 在结构化管线中协同工作。

### 💡 思考深度控制
每个任务独立控制推理深度：`off` → `minimal` → `low` → `medium` → `high` → `xhigh`

---

## 安装

pi-maestro-flow 是一个 **Pi 插件**（Pi extension），通过 `pi install` 安装到 Pi Coding Agent 中，而非普通的 npm 依赖。

### 1. 前置条件

| 组件 | 版本要求 | 说明 |
|------|---------|------|
| [Node.js](https://nodejs.org) | ≥ 22.19.0 | 运行时 |
| [Pi Coding Agent](https://github.com/earendil-works/pi) | ≥ 0.74.0 | 宿主运行时（必装） |
| [Maestro CLI](https://github.com/catlog22/maestro2) | ≥ 1.0.0 | 知识系统功能（可选） |

```bash
# 检查 Node.js 版本
node --version

# 全局安装 Pi Coding Agent（宿主运行时）
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# 全局安装 Maestro CLI（知识系统功能，可选）
npm install -g maestro-flow

# 认证 Pi（二选一）
export ANTHROPIC_API_KEY=sk-ant-...   # 方式 A：环境变量
pi                                     # 方式 B：启动后运行 /login 选择提供商
```

### 2. 安装插件

```bash
# 从 npm 安装（pi-maestro-teammate 作为依赖自动安装）
pi install npm:pi-maestro-flow

# 或从本地路径安装（开发模式）
pi install ./packages/pi-maestro-flow
```

### 3. 验证安装

```bash
pi list
# 预期输出: pi-maestro-flow@0.5.x, pi-maestro-teammate@0.4.x
```

安装后 Pi 即拥有 17 个注册工具、68 个技能、27 个 Agent、23 个 Prompt 模板和完整知识系统。

> **提示：** 完整的 LSP 功能需要对应语言服务器（如 `typescript-language-server`、`pyright` 等），详见 [packages/pi-maestro-flow/README.md](packages/pi-maestro-flow/README.md)。

---

## 快速开始

```bash
pi   # 启动 Pi（首次启动时按提示信任项目）
```

用自然语言描述任务即可。Maestro Flow 会自动分类意图、评估复杂度，并路由到最合适的执行通道：

- **简单任务** — 直接执行，最小化生命周期开销
- **多步工程** — 自动分解为链式计划，逐步执行并验证
- **长周期目标** — 设定目标和预算，跨多轮自主循环，独立验证完成度

也可以使用 `/maestro-help` 浏览所有可用命令和工作流推荐。

---

## 架构

```
┌───────────────────────────────────────────────────────────┐
│                      Pi Coding Agent                       │
├───────────────────────────────────────────────────────────┤
│                                                            │
│  pi-maestro-flow               pi-maestro-teammate         │
│  ┌────────────────────┐       ┌───────────────────────┐   │
│  │ maestro · goal      │◄────►│ teammate · send        │   │
│  │ todo · run-control  │       │ list · watch · wait    │   │
│  │ lsp · browser · mcp │       │ DAG 依赖图 · RPC       │   │
│  │ smart_search · fff  │       │ 思考深度 · 模型路由     │   │
│  │ permissions · plan  │       │                        │   │
│  └─────────┬──────────┘       └───────────┬───────────┘   │
│            │                               │               │
│  ┌─────────▼───────────────────────────────▼───────────┐   │
│  │  .pi/skills/ (68)    .pi/agents/ (27)   prompts (23) │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
│  运行时: 自动压缩 · GUI sidecar (UCL) · TUI 面板           │
└───────────────────────────────────────────────────────────┘
```

| 包 | 职责 |
|---|------|
| **pi-maestro-teammate** | 核心调度引擎 — `teammate` 工具、DAG 图、RPC 子进程、思考深度、模型路由 |
| **pi-maestro-flow** | Maestro 工具、Goal/Todo/Run 生命周期、MCP 客户端、LSP、浏览器、权限、知识系统 |

---

## 注册工具（17 个）

| 工具 | 来源 | 用途 |
|------|------|------|
| `teammate` | teammate | 多智能体调度（单任务 / 并行 / DAG / 后台） |
| `teammate-send` | teammate | 向运行中 Agent 发消息（follow_up / steer / abort） |
| `teammate-list` | teammate | 列出活跃 Agent |
| `teammate-watch` | teammate | 查看 Agent 输出 |
| `teammate-wait` | teammate | 事件驱动等待 Agent 完成 |
| `maestro` | flow | 知识感知调度（explore / delegate / moa） |
| `goal` | flow | 长时目标生命周期 + 独立验证 |
| `todo` | flow | 任务分解与跟踪（支持 Skill 绑定） |
| `run-control` | flow | 工作流 Run 生命周期（status / next / done / edit） |
| `mcp` | flow | 统一 MCP 客户端（连接 / 调用 / 搜索 / OAuth / UI） |
| `lsp` | flow | 语言服务器集成（诊断 / 定义 / 引用 / 重命名…） |
| `browser` | flow | Chromium 浏览器控制（CDP） |
| `smart_search` | flow | 网络搜索 / 深度研究 / URL 抓取 |
| `ffgrep` / `fffind` | flow | FFF 快速内容搜索 / 模糊文件搜索 |
| `search_tool_bm25` | flow | BM25 工具发现 |
| `ask-user-question` | flow | 结构化 TUI 用户输入 |
| `plan-enter` | flow | 进入持久化 Plan 模式 |

**运行时子系统：** 权限控制器（5 种模式）· 自动上下文压缩 · GUI sidecar（`PI_GUI=1`）· TUI 面板与覆盖层

---

## 技能与 Agent

68 个技能覆盖编排执行、代码质量、团队协作、UI 设计、学术写作、知识管理等领域。
完整技能列表和工作流定义请参阅 **[Maestro Flow](https://github.com/catlog22/maestro-flow)** 项目。

| 领域 | 能力 | 核心技能 |
|------|------|----------|
| 编排执行 | 意图分类与路由、轻量快速执行、多步链式编排、闭环自主执行 | `maestro-next`, `maestro-companion`, `maestro`, `maestro-ralph` |
| 代码质量 | 技术债务治理、OWASP/STRIDE 安全审计、多角色代码审查 | `quality-refactor`, `security-audit`, `team-review` |
| 迭代改进 | 长周期五模式迭代（debug / improve / planex / review / ui） | `odyssey` |
| 团队协作 | 多角色协调、生命周期管理、群体智能 | `team-coordinate`, `team-lifecycle-v4`, `team-swarm` |
| 学术写作 | 论文写作、同行评审模拟、引用验证 | `scholar-writing`, `scholar-review`, `scholar-citation-verify` |
| UI 设计 | 设计令牌管理、无障碍验证、视觉打磨 | `maestro-impeccable`, `team-uidesign`, `team-visual-a11y` |
| 知识管理 | 规范约束、经验沉淀、知识审计、项目状态 | `spec`, `manage`, `learn` |

27 个 Agent 角色：`explorer` · `delegate` · `workflow-planner` · `workflow-executor` · `workflow-reviewer` · `workflow-debugger` · `workflow-verifier` · `goal-verifier` · `ui-design-agent` · `impeccable-agent` 等。

---

## 📖 文档

| 文档 | 说明 |
|------|------|
| **[使用指南](docs/USAGE.md)** | 完整功能文档 — 全部 17 个工具、MCP、权限、思考深度、Agent、工作流 |
| **[Usage Guide（English）](docs/USAGE_EN.md)** | Complete feature documentation |
| **[用户手册](GUIDE.md)** | 深入教程，每个子系统附示例 |
| **[发布说明](RELEASE.md)** | 版本历史与变更日志 |

---

## 环境要求

| 组件 | 版本 |
|------|------|
| Node.js | ≥ 22.19.0 |
| [Pi Coding Agent](https://github.com/earendil-works/pi) | ≥ 0.74.0 |
| [Maestro CLI](https://github.com/catlog22/maestro2) | ≥ 1.0.0（知识系统功能） |

---

## 致谢

**框架与运行时**

- **[Maestro-Flow](https://github.com/catlog22/maestro-flow)** — 意图驱动工作流编排框架 by [@catlog22](https://github.com/catlog22)
- **[Pi Coding Agent](https://github.com/earendil-works/pi)** — 终端编码智能体（宿主运行时） by [@earendil-works](https://github.com/earendil-works)

**驱动内置工具的上游库**

- **[@modelcontextprotocol/sdk](https://modelcontextprotocol.io)** — Model Context Protocol 的 TypeScript 实现，驱动 `mcp` 工具
- **[Puppeteer](https://github.com/puppeteer/puppeteer)** — 通过 DevTools 协议控制 Chromium，驱动 `browser` 工具
- **[@ff-labs/fff-node](https://github.com/dmtrKovalenko/fff)** — 高性能模糊文件查找，驱动 `ffgrep` / `fffind` 工具
- **[@konbakuyomu/smart-search](https://www.npmjs.com/package/@konbakuyomu/smart-search)** — 多源网络搜索与深度研究，驱动 `smart_search` 工具（[GitHub](https://github.com/konbakuyomu/smartsearch)）

## 许可证

[MIT](LICENSE) © 2026 catlog22

---

## 友情链接

- **[Linux DO](https://linux.do/)** — Linux DO：学AI，上L站！
