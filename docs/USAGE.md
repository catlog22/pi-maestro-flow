# pi-maestro-flow 功能使用说明

<p align="center">
  <strong>中文</strong> | <a href="USAGE_EN.md">English</a>
</p>

> 本文档详细介绍 pi-maestro-flow 插件为 Pi Coding Agent 注册的所有工具、能力和使用方法。
> Skills 为简要索引，完整定义请参阅 [Maestro Flow](https://github.com/catlog22/maestro-flow) 项目。

---

## 目录

1. [安装与配置](#1-安装与配置)
2. [核心工具](#2-核心工具)
   - [teammate — 多智能体调度](#21-teammate--多智能体调度)
   - [maestro — 知识感知调度](#22-maestro--知识感知调度)
   - [goal — 长时目标生命周期](#23-goal--长时目标生命周期)
   - [todo — 任务管理](#24-todo--任务管理)
   - [run-control — 工作流运行控制](#25-run-control--工作流运行控制)
3. [智能工具](#3-智能工具)
   - [lsp — 语言服务器集成](#31-lsp--语言服务器集成)
   - [browser — 浏览器控制](#32-browser--浏览器控制)
   - [smart_search — 网络搜索与研究](#33-smart_search--网络搜索与研究)
   - [ffgrep / fffind — 快速搜索](#34-ffgrep--fffind--快速搜索)
   - [search_tool_bm25 — 工具发现](#35-search_tool_bm25--工具发现)
4. [MCP 集成](#4-mcp-集成)
5. [权限系统](#5-权限系统)
6. [思考深度控制](#6-思考深度控制)
7. [交互工具](#7-交互工具)
   - [ask-user-question — 结构化用户输入](#71-ask-user-question--结构化用户输入)
   - [plan-enter — 计划模式](#72-plan-enter--计划模式)
8. [Agent 控制工具](#8-agent-控制工具)
9. [运行时子系统](#9-运行时子系统)
   - [自动压缩](#91-自动压缩)
   - [GUI 子系统（UCL）](#92-gui-子系统ucl)
   - [TUI 界面组件](#93-tui-界面组件)
10. [Agent 角色（27 个）](#10-agent-角色27-个)
11. [Prompt 模板（20 个）](#11-prompt-模板20-个)
12. [Skills 索引（68 个）](#12-skills-索引68-个)
13. [知识系统](#13-知识系统)
14. [工作流模式](#14-工作流模式)
15. [配置参考](#15-配置参考)
16. [故障排除](#16-故障排除)

---

## 1. 安装与配置

### 前置条件

| 组件 | 版本要求 |
|------|---------|
| Node.js | ≥ 22.19.0 |
| [Pi Coding Agent](https://github.com/earendil-works/pi) | ≥ 0.74.0 |
| [Maestro CLI](https://github.com/catlog22/maestro2) | ≥ 1.0.0（知识系统功能） |

### 安装

```bash
# 安装（pi-maestro-teammate 作为依赖自动安装）
pi install npm:pi-maestro-flow

# 验证
pi list
# 预期输出: pi-maestro-flow@0.4.x, pi-maestro-teammate@0.4.x
```

### 插件注册的工具总览

安装后，插件向 Pi 注册以下工具：

| 来源包 | 工具 | 用途 |
|--------|------|------|
| pi-maestro-teammate | `teammate` | 多智能体调度（单任务/并行/DAG） |
| pi-maestro-teammate | `teammate-send` | 向运行中的 Agent 发送消息 |
| pi-maestro-teammate | `teammate-list` | 列出活跃 Agent |
| pi-maestro-teammate | `teammate-watch` | 查看 Agent 输出 |
| pi-maestro-teammate | `teammate-wait` | 等待 Agent 完成 |
| pi-maestro-flow | `maestro` | 知识感知调度（explore/delegate/moa） |
| pi-maestro-flow | `goal` | 长时目标生命周期管理 |
| pi-maestro-flow | `todo` | 任务分解与跟踪 |
| pi-maestro-flow | `run-control` | 工作流 Run 生命周期 |
| pi-maestro-flow | `ask-user-question` | 结构化用户输入收集 |
| pi-maestro-flow | `lsp` | 语言服务器协议集成 |
| pi-maestro-flow | `browser` | Chromium 浏览器控制 |
| pi-maestro-flow | `smart_search` | 网络搜索/深度研究/URL 抓取 |
| pi-maestro-flow | `ffgrep` | FFF 快速字面内容搜索 |
| pi-maestro-flow | `fffind` | FFF 快速模糊文件搜索 |
| pi-maestro-flow | `search_tool_bm25` | BM25 工具发现 |
| pi-maestro-flow | `plan-enter` | 进入计划模式 |

---

## 2. 核心工具

### 2.1 teammate — 多智能体调度

插件的核心能力。将独立的 Pi 子进程作为 Agent 启动，每个 Agent 拥有独立的工具集和上下文。

#### 单任务（前台阻塞）

```javascript
teammate({
  agent: "delegate",
  taskType: "analysis",
  task: "PURPOSE: 分析认证流程的安全隐患\nTASK: 追踪入口 | 追踪验证逻辑 | 汇总发现\nMODE: analysis\nCONTEXT: @src/auth/**/*.ts\nEXPECTED: file:line 证据 + 结论\nCONSTRAINTS: 只读，不修改文件",
  background: false
})
```

#### 并行任务

```javascript
teammate({
  taskType: "explore",
  background: false,
  tasks: [
    {
      name: "definitions",
      agent: "explorer",
      task: "FIND: 所有导出的认证函数\nSCOPE: src/auth/\nEXPECTED: 函数名 + file:line"
    },
    {
      name: "consumers",
      agent: "explorer",
      task: "FIND: 所有导入 auth 模块的调用点\nSCOPE: src/**/*.ts\nEXCLUDE: src/auth/\nEXPECTED: 导入路径 + file:line"
    }
  ]
})
```

#### DAG 依赖图

通过 `{name}` 引用其他任务的输出，自动建立依赖关系：

```javascript
teammate({
  tasks: [
    {
      name: "scan",
      agent: "explorer",
      task: "FIND: 空指针风险\nSCOPE: src/**/*.ts\nEXPECTED: file:line 列表"
    },
    {
      name: "fix",
      agent: "delegate",
      taskType: "development",
      task: "PURPOSE: 修复所有问题\nTASK: 处理 {scan} 的发现 | 添加空值守卫\nMODE: write"
    },
    {
      name: "verify",
      agent: "delegate",
      taskType: "review",
      task: "PURPOSE: 验证 {fix} 的修复\nTASK: 读取变更文件 | 运行测试\nMODE: analysis"
    }
  ]
})
// 执行顺序: scan → fix → verify（自动推断）
```

使用 `outputSchema` 可通过 `{name.field}` 引用结构化字段：

```javascript
{
  name: "scan",
  agent: "workflow-reviewer",
  task: "扫描安全问题",
  outputSchema: {
    type: "object",
    properties: {
      critical: { type: "array" },
      high: { type: "array" }
    }
  }
}
// 下游任务可引用 {scan.critical}、{scan.high}
```

#### 后台任务

```javascript
teammate({
  name: "long-test",
  agent: "delegate",
  task: "运行完整测试套件并生成报告",
  background: true
})
// 继续其他工作；完成后收到 teammate-complete 通知
```

#### 上下文模式

| 模式 | 行为 |
|------|------|
| `context: "fresh"`（默认） | 干净子进程 — 仅系统提示 + 任务描述 |
| `context: "fork"` | 继承父会话完整历史，独立继续 |

#### P0 三轴控制

| 轴 | 选项 | 用途 |
|----|------|------|
| `name` | 任意字符串 | 可寻址名称，用于 `teammate-send` 和 DAG 引用 |
| `reply_to` | `"caller"` / `"main"` | 控制结果投递目标 |
| `lifecycle` | `"ephemeral"` / `"resident"` | 临时：完成后退出。常驻：休眠等待后续指令 |

#### 自动模型路由

根据 `taskType` 自动映射到配置的模型：

| taskType | 用途 |
|----------|------|
| `explore` | 代码探索 |
| `analysis` | 只读分析 |
| `debug` | 调试 |
| `planning` | 规划 |
| `development` | 实现 |
| `review` | 代码审查 |
| `testing` | 测试 |

模型优先级：任务级 `model` → 顶层 `model` → `taskType` 映射 → 推断类型 → Agent 默认。

通过 `Alt+M` 或 `/teammate-models` 配置路由映射。

#### 思考深度

每个 teammate 任务可独立控制思考深度：

```javascript
teammate({
  agent: "delegate",
  task: "...",
  thinking: "high"   // off | minimal | low | medium | high | xhigh | max
})
```

| 级别 | 说明 |
|------|------|
| `off` | 关闭扩展思考 |
| `minimal` | 最小思考 |
| `low` | 低深度 |
| `medium` | 中等深度 |
| `high` | 高深度 |
| `xhigh` | 极高深度 |
| `max` | `xhigh` 的别名 |

优先级：任务级 `thinking` → 顶层 `thinking` → 模型默认。不同模型支持的级别范围不同（见可用模型目录）。

#### 结构化 Prompt 格式

```
PURPOSE: [目标] + [成功标准]
TASK: [步骤1] | [步骤2] | [步骤3]
MODE: analysis|write
CONTEXT: @[文件模式] | Memory: [先前工作]
EXPECTED: [输出格式]
CONSTRAINTS: [范围限制]
```

`MODE` 必填。`analysis` 模式下 Agent 必须保持只读。

---

### 2.2 maestro — 知识感知调度

提供三个 action，连接外部 CLI 端点和知识系统：

#### explore — 并行代码搜索

```javascript
maestro({
  action: "explore",
  prompts: [
    "FIND: 所有 JWT 验证中间件\nSCOPE: src/middleware/\nEXPECTED: file:line + 控制流摘要",
    "FIND: 所有 auth.login() 调用点\nSCOPE: src/**/*.ts\nEXPECTED: file:line 列表"
  ],
  concurrency: 3,
  maxTurns: 6
})
```

#### delegate — 任务委派到外部工具

```javascript
maestro({
  action: "delegate",
  prompt: "PURPOSE: 实现密码重置流程\nMODE: write\nCONTEXT: @src/auth/",
  tool: "claude",       // gemini | claude | codex
  mode: "write"
})
```

#### moa — 混合智能体合成

```javascript
maestro({
  action: "moa",
  prompts: ["从安全和架构两个角度分析支付流程"],
  preset: "deep"
})
// 跨多个模型并行分析，然后合成为统一报告
```

---

### 2.3 goal — 长时目标生命周期

为多轮自主工作提供持久化引擎：自动续行、Token 预算、压缩存活、独立验证。

#### 模型侧操作

```javascript
goal({ action: "create", objective: "实现 JWT 认证模块" })
goal({ action: "create", objective: "实现 JWT 认证模块", tokenBudget: "100k" })
goal({ action: "get" })
goal({ action: "update", objective: "实现 JWT 认证 + 刷新令牌" })
goal({ action: "complete", summary: "所有模块已实现并通过测试" })
```

#### 用户侧命令

| 命令 | 效果 |
|------|------|
| `/goal status` | 查看当前 Goal |
| `/goal create [--tokens 100k] <目标>` | 创建 Goal 并启动代理循环 |
| `/goal stop` | 暂停，保存状态 |
| `/goal resume [--tokens 200k]` | 恢复；可提高预算 |
| `/goal clear` | 放弃并删除 Goal |

#### 验证机制

- 正常 `agent_end` 后自动触发独立验证
- `pass` → 标记完成，清除 Goal
- `fail` → 保持活跃，携带未满足需求启动下一轮
- `inconclusive` → 保持活跃，等待用户 `/goal resume`

#### Goal 面板

Goal 存在时，输入编辑器上方渲染 `goal-panel`，显示：
- 状态（ACTIVE / WAITING / VERIFYING / VERIFIED / STOPPED / BUDGET / BLOCKED / ERROR）
- 目标描述、已用时间、循环次数
- 显式配置的 Token 预算（未配置时不显示）

---

### 2.4 todo — 任务管理

7 个操作，支持纯文本上下文和可选的 Pi Skill 执行：

```javascript
// 创建任务
todo({ action: "create", subject: "实现用户认证", description: "JWT + 刷新令牌" })

// 带 Skill 绑定的任务
todo({
  action: "create",
  subject: "代码审查",
  skills: [{ name: "quality-review", role: "primary", args: "--level deep" }]
})

// 更新状态
todo({ action: "update", id: "abc123", status: "completed", summary: "已完成认证模块" })

// 列出任务
todo({ action: "list", filter: { status: "pending" } })

// 激活下一个待办任务
todo({ action: "next" })

// 分配给 teammate
todo({ action: "create", subject: "探索代码库", assignee: "explorer-1" })
```

| 操作 | 说明 |
|------|------|
| `create` | 创建任务（subject 必填） |
| `update` | 更新状态/摘要/上下文/技能 |
| `list` | 按状态/成员过滤列出 |
| `get` | 获取单个任务详情 |
| `delete` | 删除任务 |
| `clear` | 清除所有任务 |
| `next` | 激活下一个待办任务，返回解析后的上下文 |

---

### 2.5 run-control — 工作流运行控制

通过统一类型化 Shell 读取和控制规范化 Maestro Workflow Run：

| Action | 类型 | 说明 |
|--------|------|------|
| `status` | 只读 | 读取当前 Session 快照 |
| `brief` | 只读 | 加载 Run 恢复包 |
| `prepare` | 只读 | 预览工作流步骤（不创建 Run） |
| `check` | 只读 | 评估 Run 门控和完成指引 |
| `next` | 写入 | 分配下一个链式 Run |
| `done` | 写入 | 以裁决封印 Run（done / done-with-concerns / needs-retry / blocked） |
| `edit` | 写入 | 修改未来链步骤（commands / after / replace / remove） |

```javascript
run-control({ action: "status" })
run-control({ action: "next" })
run-control({ action: "done", runId: "run-123", verdict: "done", summary: "完成" })
run-control({ action: "edit", commands: ["quality-review"], after: "current" })
```

---

## 3. 智能工具

### 3.1 lsp — 语言服务器集成

连接语言服务器，提供代码智能功能：

| Action | 说明 |
|--------|------|
| `diagnostics` | 获取诊断信息（错误/警告） |
| `definition` | 跳转到定义 |
| `references` | 查找所有引用 |
| `hover` | 悬停信息（类型/文档） |
| `symbols` | 文件/工作区符号列表 |
| `rename` | 重命名符号 |
| `rename_file` | 重命名文件（更新引用） |
| `code_actions` | 可用代码操作 |
| `type_definition` | 跳转到类型定义 |
| `implementation` | 查找实现 |
| `status` | 语言服务器状态 |
| `reload` | 重新加载 |
| `capabilities` | 服务器能力 |
| `request` | 原始 LSP 请求 |

```javascript
lsp({ action: "diagnostics", file: "src/auth/login.ts" })
lsp({ action: "definition", file: "src/auth/login.ts", line: 42, symbol: "validateToken" })
lsp({ action: "references", file: "src/auth/login.ts", line: 42, symbol: "validateToken" })
lsp({ action: "rename", file: "src/auth/login.ts", line: 42, symbol: "validateToken", new_name: "verifyToken", apply: true })
lsp({ action: "symbols", file: "*" })  // 工作区符号
```

插件还注册了 **LSP 自动诊断**：文件编辑后自动触发诊断检查。

---

### 3.2 browser — 浏览器控制

通过 CDP 控制 Chromium，支持命名标签页、截图和页面内 JavaScript 执行：

| Action | 说明 |
|--------|------|
| `open` | 打开/附加浏览器标签页 |
| `close` | 关闭标签页（`all: true` 关闭全部） |
| `run` | 在页面中执行 JavaScript |

```javascript
// 打开页面
browser({ action: "open", url: "http://localhost:3000", name: "app" })

// 执行 JS + 截图
browser({
  action: "run",
  name: "app",
  code: "await page.screenshot({ path: 'screenshot.png' }); return document.title;"
})

// 设置视口
browser({ action: "open", url: "...", viewport: { width: 1920, height: 1080 } })

// 关闭
browser({ action: "close", name: "app" })
browser({ action: "close", all: true })
```

支持配置：
- `app.path` — 自定义 Chromium/Chrome/Edge 路径
- `app.cdp_url` — 连接已有浏览器 CDP 端点
- `wait_until` — 导航等待策略（load / domcontentloaded / networkidle0 / networkidle2）
- `dialogs` — 对话框处理（accept / dismiss）

---

### 3.3 smart_search — 网络搜索与研究

外部信息检索 — 网络搜索、深度研究、URL 内容提取：

| 模式 | 用途 | 关键参数 |
|------|------|---------|
| `search` | 快速查询 | `platform`, `validation` |
| `research` | 多源深度研究 | `budget`（quick/standard/deep）, `validation`（strict） |
| `fetch` | 提取已知 URL 内容 | — |
| `route` | 路由诊断 | `router_mode` |

```javascript
smart_search({ mode: "search", query: "Express.js 中间件错误处理最佳实践" })
smart_search({ mode: "research", query: "JWT vs Session 认证对比", budget: "deep", validation: "strict" })
smart_search({ mode: "fetch", query: "https://docs.example.com/api/auth" })
```

通过 `Alt+S` 或 `/smart-search-config` 打开配置界面。

---

### 3.4 ffgrep / fffind — 快速搜索

基于 [FFF](https://github.com/fff-labs/fff) 的原生索引搜索，仅注册到根 Pi 会话：

```javascript
// 字面内容搜索
ffgrep({ pattern: "validateToken", context: 3, limit: 20 })

// 模糊文件路径搜索
fffind({ pattern: "auth middleware", limit: 10 })
```

---

### 3.5 search_tool_bm25 — 工具发现

按名称、描述和参数名搜索所有已注册工具，使用 BM25 加权排序：

```javascript
search_tool_bm25({ query: "code search", limit: 10 })
```

匹配的未激活工具会被自动激活。

---

## 4. MCP 集成

插件内置完整的 MCP（Model Context Protocol）客户端，通过统一的 `mcp` 代理工具连接外部 MCP 服务器。

> 设计原则：不将 MCP 服务器的数百个工具逐一注册到 Pi，而是通过单一 `mcp` 代理工具统一访问，保持 LLM 上下文精简。

### 基本操作

```javascript
// 查看服务器状态
mcp({ })

// 列出服务器的工具
mcp({ server: "server-name" })

// 搜索工具（按名称/描述）
mcp({ search: "query" })
mcp({ search: "pattern.*", regex: true })

// 查看工具详情和参数
mcp({ describe: "tool_name" })

// 连接服务器并刷新元数据
mcp({ connect: "server-name" })

// 调用工具
mcp({ tool: "tool_name", args: '{"key": "value"}' })
mcp({ server: "server-name", tool: "tool_name", args: '{"key": "value"}' })
```

### OAuth 认证

```javascript
// 启动手动 OAuth 流程，获取浏览器 URL
mcp({ action: "auth-start", server: "server-name" })

// 完成手动 OAuth
mcp({ action: "auth-complete", server: "server-name", args: '{"redirectUrl":"..."}' })

// 获取已完成 UI 会话的消息
mcp({ action: "ui-messages" })
```

### 传输协议

支持三种传输方式：
- **stdio** — 本地进程通信（最常用）
- **SSE** — Server-Sent Events HTTP 流
- **Streamable HTTP** — 可流式 HTTP 传输

### 高级特性

| 特性 | 说明 |
|------|------|
| **元数据缓存** | 持久化工具/资源元数据缓存（7 天 TTL），避免重复连接 |
| **NPX 解析** | 自动解析 `npx`/`npm exec` 二进制路径，避免 npm 父进程开销 |
| **输出守卫** | 大输出自动截断（默认 50KB / 2000 行），完整输出写入临时文件 |
| **Sampling** | 支持 MCP Sampling 请求（服务器请求 LLM 生成），需用户确认 |
| **UI 会话** | 支持 MCP UI 资源（`ui://` 协议），在浏览器中渲染交互式界面 |
| **UI 流式** | 支持 `eager` / `stream-first` 两种 UI 流式模式 |
| **OAuth 提供者** | 完整 OAuth 客户端实现（注册、令牌存储、授权重定向） |
| **配置导入** | 支持从 Cursor / Claude Code / Claude Desktop / Codex / Windsurf / VSCode 导入配置 |
| **MCP 管理器** | TUI 管理界面（`/mcp` 命令），支持启用/停用/删除服务器 |
| **资源工具** | MCP 资源自动转换为 `get_<name>` 工具 |
| **同意管理** | 工具调用同意管理，支持自动批准配置 |

### 配置

MCP 服务器在 Pi 配置文件中定义（用户级或项目级）：

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@my/mcp-server"],
      "env": { "API_KEY": "..." },
      "enabled": true,
      "excludeTools": ["dangerous_tool"]
    }
  }
}
```

---

## 5. 权限系统

插件实现了完整的工具调用权限控制，支持多种权限模式和细粒度规则。

### 权限模式

| 模式 | 行为 |
|------|------|
| `default` | 默认模式，危险操作需用户确认 |
| `acceptEdits` | 自动接受文件编辑，其他操作仍需确认 |
| `plan` | 计划模式，仅允许只读操作 |
| `dontAsk` | 不询问，自动允许所有操作 |
| `bypassPermissions` | YOLO 模式，跳过所有权限检查（可被配置禁用） |

### 权限规则

三种行为级别：

| 行为 | 说明 |
|------|------|
| `allow` | 自动允许，不询问 |
| `ask` | 每次询问用户 |
| `deny` | 拒绝执行 |

规则可配置在会话级（临时）或本地设置文件（持久）：

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash(npm test)", "Bash(npm run *)"],
    "ask": ["Bash(rm *)"],
    "deny": ["Bash(rm -rf /)"],
    "disableBypassPermissionsMode": "disable"
  }
}
```

### 始终允许的工具

以下工具在任何模式下都自动允许（只读或无副作用）：

`Read`, `Grep`, `Glob`, `Ls`, `Find`, `ffgrep`, `fffind`, `ask-user-question`, `teammate`, `teammate-send`, `teammate-list`, `teammate-watch`, `goal`, `todo`, `plan-*`, `search_tool_bm25`

### Teammate 子进程权限中继

Teammate 子进程没有本地终端，权限请求通过 IPC 中继到父进程处理：
- 父进程拥有实时模式、会话规则、钩子和持久化
- 子进程的权限请求通过 `teammate_proxy_request` 转发
- 父进程执行权限评估并返回 `allow_once` 或 `deny`

---

## 6. 思考深度控制

Teammate 调度支持精细的思考深度控制，影响子进程 Agent 的推理深度。

### 可用级别

| 级别 | 说明 |
|------|------|
| `off` | 关闭扩展思考，最快响应 |
| `minimal` | 最小思考开销 |
| `low` | 低深度推理 |
| `medium` | 中等深度（平衡速度和质量） |
| `high` | 高深度推理 |
| `xhigh` | 极高深度（最慢但最 thorough） |
| `max` | `xhigh` 的别名 |

### 使用方式

```javascript
// 顶层默认
teammate({
  thinking: "high",
  tasks: [
    { name: "quick-scan", agent: "explorer", task: "...", thinking: "off" },
    { name: "deep-analysis", agent: "delegate", task: "...", thinking: "xhigh" }
  ]
})
```

### 优先级

任务级 `thinking` → 顶层 `thinking` → 模型默认

> 注意：不同模型支持的思考级别范围不同。例如 `deepseek/deepseek-v4-flash` 仅支持 `off` 和 `high`，而 `maestro-openai/gpt-5.6-sol` 支持全部级别。

---

## 7. 交互工具

### 7.1 ask-user-question — 结构化用户输入

通过键盘优先的 TUI 向导收集结构化用户答案：

```javascript
// 单选
ask-user-question({
  questions: [{
    question: "选择哪种方案？",
    header: "方案",
    options: [
      { label: "A: 微服务", description: "独立部署，松耦合" },
      { label: "B: 单体", description: "简单直接，易调试" }
    ]
  }]
})

// 多选
ask-user-question({
  questions: [{
    question: "需要哪些功能？",
    multiSelect: true,
    options: [
      { label: "认证" }, { label: "授权" },
      { label: "审计日志" }, { label: "速率限制" }
    ]
  }]
})

// 开放式
ask-user-question({
  questions: [{ question: "项目名称是什么？" }]
})
```

- 单次最多 4 个问题
- 每个问题 2-4 个选项
- 支持单选、多选、开放式

---

### 7.2 plan-enter — 计划模式

进入持久化计划模式，加载当前会话的 `current.md` 草稿，激活计划专用工具：

```javascript
plan-enter()
```

**计划模式行为：**
- 编辑/写入工具和文件变更命令被阻止
- 读取/搜索/探索工具保持可用
- 通过 `plan-update` 起草 Markdown 计划
- 通过 `plan-status` 检查计划状态
- `plan-confirm`（或 `/plan approve`）提交计划并恢复 Act 工具
- `plan-exit` 放弃计划返回 Act 模式

**切换方式：** `Alt+P` 或 `/plan` 切换 Plan/Act 模式。

---

## 8. Agent 控制工具

管理运行中的 teammate Agent：

```javascript
// 列出所有活跃 Agent
teammate-list({ view: "all" })     // all | active | named | roles

// 查看 Agent 输出
teammate-watch({ name: "my-agent", lines: 30 })

// 等待 Agent 完成（事件驱动，避免轮询）
teammate-wait({ name: "my-agent", timeoutMs: 60000 })
teammate-wait({ waitMs: 5000 })  // 固定延迟

// 向运行中的 Agent 发送消息
teammate-send({ to: "my-agent", message: "请也检查边界情况", mode: "follow_up" })

// 紧急修正（中断当前轮次）
teammate-send({ to: "my-agent", message: "停止当前方案，改用替代方案", mode: "steer" })

// 终止
teammate-send({ to: "my-agent", mode: "abort" })
```

| 工具 | 用途 |
|------|------|
| `teammate-list` | 列出 Agent（active / named / all / roles） |
| `teammate-watch` | 查看最近输出、工具活动、收件箱 |
| `teammate-wait` | 事件驱动等待 Agent 完成或固定延迟 |
| `teammate-send` | 发送消息（follow_up / steer / abort） |

---

## 9. 运行时子系统

### 9.1 自动压缩

插件实现了智能的上下文窗口管理，防止长会话溢出：

| 特性 | 说明 |
|------|------|
| **自动修剪** | 上下文达到阈值（~70%）时自动修剪大型工具结果（≥4KB） |
| **保留近期** | 始终保留最近 ~20K Token 的对话内容 |
| **预留空间** | 预留 ~16K Token 给模型响应 |
| **可重放工具** | `read`, `grep`, `glob`, `search`, `find` 的结果可安全修剪（需要时可重新执行） |
| **压缩续行** | 压缩后自动注入续行提示，Agent 从中断点继续 |
| **状态持久化** | 修剪状态持久化，跨会话保持 |

### 9.2 GUI 子系统（UCL）

统一通信层（Unified Communication Layer），通过 `PI_GUI=1` 环境变量启用：

```bash
PI_GUI=1 pi   # 启动带 GUI sidecar 的 Pi
```

| 特性 | 说明 |
|------|------|
| **工具发现** | `GET /tools` — 列出所有可用工具 |
| **工具调用** | `POST /tools/:name` — 通过 HTTP 调用工具（带权限网关） |
| **状态聚合** | `GET /state` / `GET /state/:sub` — 聚合会话状态 |
| **变更事件** | SSE（Server-Sent Events）实时推送状态变更 |
| **零侵入** | 未启用时无任何行为变化（无监听器、无发现文件） |

### 9.3 TUI 界面组件

插件注册了多个 TUI 覆盖层和面板：

| 组件 | 触发方式 | 功能 |
|------|---------|------|
| **Goal 面板** | Goal 存在时自动显示 | 状态、目标、时间、循环次数、Token 预算 |
| **Todo 覆盖层** | Todo 操作时 | 任务列表和状态 |
| **Session 覆盖层** | `/maestro-session` | 工作流会话控制中心 |
| **Maestro 面板** | Maestro 操作时 | 运行状态和进度 |
| **Swarm 覆盖层** | `/swarm` | 蚁群优化状态、拓扑、指标 |
| **模型映射覆盖层** | `Alt+M` / `/teammate-models` | 配置 taskType → 模型映射 |
| **Smart Search 配置** | `Alt+S` / `/smart-search-config` | 搜索引擎和提供商配置 |
| **MCP 管理器** | `/mcp` | MCP 服务器管理（启用/停用/删除/配置导入） |
| **MCP 面板** | MCP 工具选择时 | 服务器工具浏览、搜索、调用 |
| **MCP 设置面板** | 首次 MCP 配置时 | 引导式配置（导入/脚手架/仓库提示） |
| **进度树** | Teammate 执行时 | Agent 执行进度可视化 |
| **Attach 覆盖层** | Teammate 启动时 | 附加到 Agent 子进程 |
| **状态栏** | 持续显示 | 当前模式、压缩状态、MCP 连接状态 |

---

## 10. Agent 角色（27 个）

每个 Agent 是一个专门的子进程配置，拥有独立的系统提示和工具集。

### 核心 Agent

| Agent | 用途 |
|-------|------|
| `explorer` | 快速只读代码侦察，用于并行搜索 |
| `delegate` | 通用 Agent，用于委派分析或实现 |
| `goal-verifier` | 独立验证器，审计目标完成声明 |
| `ralph-executor` | 单步执行器，用于 maestro 编排管线 |

### 工作流 Agent

| Agent | 用途 |
|-------|------|
| `workflow-analyzer` | 多维评估，基于证据的评分 |
| `workflow-codebase-mapper` | 从特定焦点分析代码库 |
| `workflow-collab-planner` | 协作规划器，预分配任务 ID 范围 |
| `workflow-debugger` | 假设驱动调试，结构化证据日志 |
| `workflow-executor` | 单任务实现，带验证和提交纪律 |
| `workflow-external-researcher` | 外部研究（Exa MCP），API/技术评估 |
| `workflow-integration-checker` | 跨阶段集成验证 |
| `workflow-nyquist-auditor` | 测试覆盖审计，缺口检测和测试桩生成 |
| `workflow-phase-researcher` | 特定路线图阶段的实现方案研究 |
| `workflow-plan-checker` | 计划质量验证，最多 3 轮修订 |
| `workflow-planner` | 执行计划，任务分解、波次和依赖 |
| `workflow-project-researcher` | 项目初始化的领域研究 |
| `workflow-research-synthesizer` | 合并多个研究者输出为统一摘要 |
| `workflow-reviewer` | 多维代码审查（每 Agent 单维度） |
| `workflow-roadmapper` | 项目路线图，阶段化里程碑 |
| `workflow-verifier` | 目标反向验证（存在性、实质性、连接性） |

### 专家 Agent

| Agent | 用途 |
|-------|------|
| `team-supervisor` | 常驻管线监督者，质量观察 |
| `team-worker` | 统一工作者，执行 role_spec 文件中的角色逻辑 |
| `ui-design-agent` | UI 设计令牌管理和原型生成（WCAG AA 验证） |
| `impeccable-agent` | 自主 UI 审计、打磨、加固、排版执行器 |
| `role-design-author` | 为头脑风暴会话生成多文件角色分析 |
| `cross-role-reviewer` | 跨角色分析文件的决策摘要比较 |
| `cli-explore-agent` | Bash + CLI 语义双源只读代码探索 |
| `aggregator` | MOA 聚合器，合成多个参考分析 |
| `reference` | MOA 参考，单模型视角独立分析 |

### 自定义 Agent

在 `.pi/agents/` 下创建 Markdown 文件即可定义新 Agent：

```markdown
<!-- .pi/agents/db-migrator.md -->
# Database Migrator
你是数据库模式迁移专家。
## 角色
- 分析现有模式
- 规划安全迁移（含回滚策略）
- 生成迁移文件
## 约束
- 始终包含经验证的回滚计划
```

使用：`teammate({ agent: "db-migrator", taskType: "planning", task: "..." })`

---

## 11. Prompt 模板（20 个）

通过 `teammate` 的 `prompt` 字段调用。发现顺序：项目 `.pi/prompts/` → 用户 `~/.pi/agent/prompts/` → 内置目录。

### 分析模板

| 模板 | 用途 |
|------|------|
| `analysis-trace-code-execution` | 追踪执行流、控制流、数据流 |
| `analysis-diagnose-bug-root-cause` | 诊断 Bug 根因，提出只读修正 |
| `analysis-analyze-code-patterns` | 分析实现模式、约定、反模式 |
| `analysis-analyze-technical-document` | 分析技术文档，证据支撑引用 |
| `analysis-review-architecture` | 审查架构、依赖、集成点、权衡 |
| `analysis-review-code-quality` | 审查正确性、可维护性、测试 |
| `analysis-analyze-performance` | 分析瓶颈和优化机会 |
| `analysis-assess-security-risks` | 评估攻击面和优先级缓解措施 |

### 规划模板

| 模板 | 用途 |
|------|------|
| `planning-plan-architecture-design` | 结构化软件架构设计 |
| `planning-breakdown-task-steps` | 将需求分解为可执行、可验证的步骤 |
| `planning-design-component-spec` | 组件规格（接口 + 验收标准） |
| `planning-plan-migration-strategy` | 分阶段迁移（兼容性 + 回滚） |

### 开发模板

| 模板 | 用途 |
|------|------|
| `development-implement-feature` | 遵循现有模式实现功能 |
| `development-refactor-codebase` | 安全重构，保持行为不变 |
| `development-generate-tests` | 生成测试，填补具体覆盖缺口 |
| `development-implement-component-ui` | 可复用的无障碍 UI 组件 + 测试 |
| `development-debug-runtime-issues` | 复现、诊断、修复、回归测试 |

### 紧凑兼容模板

| 模板 | 模式 | 参数 |
|------|------|------|
| `analysis` | analysis | 目的、上下文、预期输出 |
| `review` | analysis | 审查目标、额外约束 |
| `write` | write | 实现目标、上下文、验收输出 |

### 使用示例

```javascript
teammate({
  agent: "delegate",
  taskType: "analysis",
  prompt: "analysis-trace-code-execution",
  task: "追踪令牌刷新流程",
  promptArgs: ["@src/auth/tokens.ts", "file:line 证据 + 状态转换"],
  background: false
})
```

### 自定义模板

在 `.pi/prompts/` 下创建 Markdown 文件：

```markdown
<!-- .pi/prompts/security-audit.md -->
# Security Audit
审查以下内容：
1. OWASP Top 10 漏洞
2. {{dependency}} 的供应链风险
3. {{dataFlow}} 中的数据暴露
焦点: {{focus}}
预期: 漏洞列表（含严重性和 file:line）
```

使用：`prompt: "security-audit"` + 对应 `promptArgs`。

---

## 12. Skills 索引（68 个）

Skills 是按需加载的能力包，通过 `/skill:name` 调用或由 Agent 自动加载。
完整 Skill 定义和工作流详情请参阅 [Maestro Flow](https://github.com/catlog22/maestro-flow) 项目。

### 编排与生命周期

| Skill | 简介 |
|-------|------|
| `maestro` | 意图到链的规划器，自动路由到最优命令链 |
| `maestro-next` | 统一开发意图入口，分类复杂度并路由到正确执行通道 |
| `maestro-companion` | 小任务快速执行，最小化 Run 生命周期 |
| `maestro-ralph` | 规范化 Session/Run 链上的闭环策略 |
| `maestro-init` | 项目初始化，自动状态检测 |
| `maestro-fork` | 创建/同步会话工作树，用于并行开发 |
| `maestro-merge` | 合并工作树分支回主分支 |
| `maestro-session-seal` | 封印当前会话，提取知识并推进 DAG |
| `maestro-update` | 检测版本、预览变更、应用工作流升级 |
| `maestro-help` | 命令帮助系统，搜索命令、浏览技能 |
| `maestro-guard` | 管理编辑边界限制 |
| `maestro-overlay` | 从自然语言创建/编辑命令覆盖层 |

### 质量与测试

| Skill | 简介 |
|-------|------|
| `quality-refactor` | 系统性技术债识别与安全削减 |
| `security-audit` | OWASP Top 10 + STRIDE 安全审计 |
| `insight-challenge` | 对代码质量发现进行对抗性审查 |
| `delegation-check` | 检查工作流委派 Prompt 的内容分离违规 |

### UI / 设计

| Skill | 简介 |
|-------|------|
| `maestro-impeccable` | 前端 UI 设计、审计、打磨 |

### 团队协作

| Skill | 简介 |
|-------|------|
| `team-coordinate` | 通用团队协调，动态角色生成 |
| `team-lifecycle-v4` | 完整生命周期：计划→开发→测试→审查 |
| `team-review` | 3 角色代码审查管线：扫描→审查→修复 |
| `team-testing` | 渐进式测试覆盖（Generator-Critic 循环） |
| `team-quality-assurance` | 全闭环 QA（问题发现 + 测试） |
| `team-brainstorm` | 统一头脑风暴团队 |
| `team-arch-opt` | 架构优化 |
| `team-perf-opt` | 性能优化（单/扇出/并行模式） |
| `team-tech-debt` | 技术债识别与修复 |
| `team-roadmap-dev` | 路线图驱动开发 |
| `team-planex` | 计划-执行管线 |
| `team-ultra-analyze` | 深度协作多角色调查 |
| `team-issue` | 问题解决团队 |
| `team-swarm` | ACO 蚁群智能多 Agent 探索 |
| `team-adversarial-swarm` | 带对抗决策门的蚁群智能 |
| `team-frontend` | 统一前端开发（含 ui-ux-pro-max 设计智能） |
| `team-frontend-debug` | Chrome DevTools MCP 前端调试 |
| `team-uidesign` | UI 设计团队：研究→令牌→审计→实现 |
| `team-ui-polish` | 自动发现/修复 UI 问题 |
| `team-motion-design` | 动画令牌系统、滚动编排、GPU 变换 |
| `team-visual-a11y` | 视觉无障碍 QA（OKLCH 对比度、WCAG AA/AAA） |
| `team-ux-improve` | 发现/修复 UI/UX 交互问题 |
| `team-interactive-craft` | 原生 JS+CSS 交互组件（零依赖） |
| `team-designer` | 团队 Skill 生成元技能 |
| `team-executor` | 轻量级会话执行（恢复已有 team-coordinate 会话） |

### 长时循环（Odyssey）

| Skill | 简介 |
|-------|------|
| `odyssey` | 长时迭代循环，五模式（debug/improve/planex/review/ui） |
| `maestro-odyssey` | 长时迭代循环，六模式（+security） |

### 知识管理

| Skill | 简介 |
|-------|------|
| `spec` / `maestro-spec` | Spec 条目管理（添加/加载/删除/初始化） |
| `manage` / `maestro-manage` | 项目管理中枢（状态/Issue/知识/Drift） |
| `codify-to-knowhow` | 清单驱动的知识资产生成器 |

### 学术写作（Scholar）

| Skill | 简介 |
|-------|------|
| `scholar-ideation` | 研究构思（文献→缺口分析→规划） |
| `scholar-writing` | 端到端学术论文写作（NeurIPS/ICML/ICLR 等） |
| `scholar-review` | 系统性论文审查（自审 + Rebuttal） |
| `scholar-rebuttal-pro` | 增强型 Rebuttal（协作分析 + 多视角） |
| `scholar-experiment` | ML/AI 论文实验结果分析 |
| `scholar-citation-verify` | 四层引用验证 |
| `scholar-anti-ai-writing` | 去除学术文章中的 AI 写作模式 |
| `scholar-latex-organizer` | 整理 LaTeX 模板为 Overleaf 可用结构 |
| `scholar-publish` | 录用后会议准备（幻灯片/海报/宣传） |
| `scholar-thesis-docx` | 创建/修订学位论文 Word 文档 |

### 元 / 工具

| Skill | 简介 |
|-------|------|
| `prompt-generator` | 生成/转换 Prompt 文件（GSD 风格质量门） |
| `skill-generator` | 创建新 Skill 的元技能 |
| `skill-iter-tune` | 迭代 Skill 调优（执行→评估→改进） |
| `skill-simplify` | SKILL.md 简化（功能完整性验证） |
| `skill-tuning` | 通用 Skill 诊断与优化 |
| `workflow-skill-designer` | 编排器+阶段工作流 Skill 设计元技能 |
| `swarm` | 蚁群优化状态投影 |

### 学习

| Skill | 简介 |
|-------|------|
| `learn` / `maestro-learn` | 引导式阅读、调查、模式提取、第二意见 |

---

## 13. 知识系统

知识系统确保 Agent 在接触代码前拥有完整的项目上下文。

### 强制知识门

在任何代码访问或调度之前执行：

```bash
# 搜索（跨 spec、knowhow、domain、issue、session）
maestro search "<查询>" [--type spec|knowhow|domain|issue] [--code] [--kg]

# 加载特定知识
maestro load --type <type> [--list] [--category <cat>] [--keyword <word>] [--id <id>]
```

### 查询规则

```bash
# ❌ 避免关键词堆砌
maestro search "topology display frontend DetailedTopologySVG elk layout rendering"

# ✅ 使用聚焦查询
maestro search "topology layout"
maestro search "DetailedTopologySVG" --code
maestro load --type spec --category coding
```

### 知识类型

| 类型 | 分类 | 用途 |
|------|------|------|
| `spec` | `arch`, `coding`, `debug`, `test`, `review`, `learning`, `ui` | 可复用约定和规则 |
| `knowhow` | `compact`, `tip` | 任务特定模式和配方 |
| `domain` | — | 项目术语表 |
| `issue` | — | 跟踪的 Bug 和任务 |
| `roadmap` | — | 里程碑和阶段规划 |

### 知识生命周期

```bash
# 添加
/spec-add coding "使用 Result<T,E>" "服务方法必须返回 Result<T,AppError>" --keywords error-handling
/manage-knowhow-capture

# 演化
maestro spec supersede SPEC-042 --by SPEC-089     # 替代旧规则
maestro spec conflict mark src/auth.ts 45 --note "JWT vs session: 两者均有效"

# 维护
maestro spec health                                # 健康检查
maestro spec history SPEC-042                     # 查看历史
maestro search "旧模式" --include-deprecated       # 搜索全部
```

### 三轴正交

| 轴 | 说明 |
|----|------|
| `confidence` | 人工/审计裁决 |
| `status` | active / deprecated 生命周期 |
| 时间衰减 | 自动新鲜度衰减 |

---

## 14. 工作流模式

### 模式 1：门控 → 探索 → 实现

```
1. maestro search + load      → 知识门
2. teammate (explorer × 2-3)  → 交叉搜索建立信心
3. 定向读取                    → 验证单匹配结果
4. teammate (delegate)         → 带完整上下文实现
5. /skill:quality-review       → 验证
```

### 模式 2：计划 → 执行 → 验证

```
1. maestro search + load      → 知识门
2. /skill:maestro-plan         → 创建执行计划
3. /skill:maestro-execute      → 逐步执行 + 验证
4. workflow-verifier           → 目标反向验证
5. /skill:quality-test         → 验收测试
```

### 模式 3：并行审查 → 合成 → 修复 → 复审

```
1. teammate (reviewer × 3)    → 安全、性能、可维护性
2. teammate (delegate)         → 合成发现
3. teammate (delegate)         → 修复最高优先级问题
4. teammate (reviewer × 3)    → 复审修复
```

### 模式 4：Odyssey 完整循环

```
1. /skill:odyssey-debug        → 考古 → 诊断 → 修复 → 泛化
2. /skill:quality-test         → 验证修复
3. /manage-knowhow-capture     → 持久化经验
```

### 模式 5：多阶段 DAG 管线

```javascript
teammate({
  tasks: [
    // 阶段 1: 并行研究
    { name: "api-research", agent: "workflow-external-researcher", task: "研究速率限制最佳实践" },
    { name: "codebase-survey", agent: "explorer", task: "FIND: 所有 API 端点\nSCOPE: src/api/" },
    // 阶段 2: 规划（研究 + 调查完成后）
    { name: "plan", agent: "workflow-planner", task: "整合 {api-research} + {codebase-survey} 制定计划" },
    // 阶段 3: 实现
    { name: "implement", agent: "workflow-executor", task: "执行 {plan}" },
    // 阶段 4: 验证
    { name: "verify", agent: "workflow-verifier", task: "验证 {implement} 是否满足 {plan}" }
  ]
})
```

### Explorer 交叉搜索策略

| 角度 | 任务 A | 任务 B |
|------|--------|--------|
| 定义 vs 使用 | 查找导出定义 | 查找导入和调用点 |
| 正面 vs 缺失 | 查找正确实现 | 查找缺少约定的地方 |
| 入口 vs 实现 | 查找路由或导出 | 查找内部逻辑 |

**信心规则：**
- ✅ 两个角度匹配 → 高信心，直接使用
- ⚠️ 一个角度匹配 → 用 `rg` 或定向读取验证
- ❌ 零匹配 → 换角度或结论目标不存在

---

## 15. 配置参考

### 模型路由（`.pi/teammate-models.json`）

```json
{
  "global": "deepseek/deepseek-v4-pro",
  "mappings": {
    "explore": "deepseek/deepseek-v4-flash",
    "analysis": "deepseek/deepseek-v4-pro",
    "development": "deepseek/deepseek-v4-pro",
    "review": "deepseek/deepseek-v4-flash",
    "testing": "deepseek/deepseek-v4-flash",
    "planning": "deepseek/deepseek-v4-pro",
    "debug": "deepseek/deepseek-v4-pro"
  }
}
```

通过 `Alt+M` 或 `/teammate-models` 交互式配置。

### 项目级配置

| 文件 | 用途 |
|------|------|
| `.pi/teammate-models.json` | 本项目的模型路由映射 |
| `.pi/prompts/` | 项目特定 Prompt 模板 |
| `.pi/agents/` | 项目特定 Agent 定义 |
| `.pi/settings.json` | Pi 设置覆盖 |

### 全局配置

| 文件 | 用途 |
|------|------|
| `~/.pi/agent/teammate-models.json` | 全局模型路由默认值 |
| `~/.pi/agent/prompts/` | 用户级 Prompt 模板 |
| `~/.pi/agent/settings.json` | 全局 Pi 设置 |

---

## 16. 故障排除

### Teammate 无法启动

```
Error: Failed to spawn teammate process
```

**检查：** `which pi`、`node --version`（≥22.19.0）、`/teammate-models` 模型配置。

### Explorer 无结果

**修复：** 验证 `SCOPE` 路径存在，使 `FIND` 更具体，添加 `ATTENTION` 说明命名约定。

### 知识门失败

```
maestro: command not found
```

**修复：** `npm install -g maestro-flow`

### 模型不可用

```
Error: Model not found in authenticated catalog
```

**修复：** `/teammate-models` → 检查可用模型 → `/login` 认证。

### Agent 挂起

```javascript
teammate-list({ view: "all" })                          // 检查状态
teammate-watch({ name: "stuck", lines: 50 })            // 查看输出
teammate-send({ to: "stuck", mode: "abort" })           // 终止
// 带超时重试:
teammate({ agent: "delegate", task: "...", timeoutMs: 120000 })
```

### 长会话上下文溢出

```bash
/compact "总结关键决策和当前状态"
# 或对重工作使用 fresh 上下文:
teammate({ agent: "delegate", context: "fresh", task: "PURPOSE: 读取状态并继续\n..." })
```

---

## 快速参考

```bash
# ─── 安装 ───
pi install npm:pi-maestro-flow

# ─── 知识 ───
maestro search "查询" --code
maestro load --type spec --category coding

# ─── 探索 ───
teammate({ agent: "explorer", taskType: "explore", task: "FIND: ...\nSCOPE: src/..." })

# ─── 分析 ───
teammate({ agent: "delegate", taskType: "analysis", prompt: "analysis-trace-code-execution", task: "..." })

# ─── 实现 ───
teammate({ agent: "delegate", taskType: "development", prompt: "development-implement-feature", task: "..." })

# ─── 审查 ───
/skill:team-review src/ --level deep

# ─── 完整循环 ───
/skill:maestro-analyze → /skill:maestro-plan → /skill:maestro-execute → /skill:quality-review

# ─── 调试 ───
/skill:odyssey-debug "问题描述"

# ─── Agent 控制 ───
teammate-list({ view: "all" })
teammate-watch({ name: "agent", lines: 30 })
teammate-send({ to: "agent", message: "..." })
teammate-send({ to: "agent", mode: "abort" })
```
