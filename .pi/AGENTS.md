# pi-maestro-flow

Maestro workflow orchestration for Pi coding agent.

## Prerequisites

- **Pi coding agent** (`pi`) — the host runtime
- **Maestro CLI** (`maestro`) — provides `search`, `load`, `delegate`, `explore` commands
- **pi-maestro-teammate** — teammate dispatch (installed automatically as dependency)

## Teammate Tools

### teammate

Dispatch tasks to teammate agents. Teammates run as pi subprocesses via RPC mode.
**默认后台运行** — 立即返回，agent 在后台执行，完成后自动通知主会话。

统一 TaskSpec 模型 — 两条规则：
1. **引用即依赖**: task 中写 `{name}` 引用其他任务输出 → 自动等待
2. **无引用即并行**: 没有依赖的任务并发执行（受 `concurrency` 限制）

**Single agent**:
```
teammate({ agent: "delegate", task: "Implement the auth module", name: "auth" })
```

**Parallel** (无引用 = 并发):
```
teammate({
  tasks: [
    { agent: "delegate", task: "Refactor auth module" },
    { agent: "delegate", task: "Add unit tests for auth" }
  ],
  concurrency: 4
})
```

**Chain** (线性引用 = 顺序):
```
teammate({
  tasks: [
    { agent: "scout", name: "recon", task: "Find the auth module structure" },
    { agent: "delegate", task: "Based on this context: {recon}\n\nRefactor the auth module" }
  ]
})
```

**DAG** (混合引用 = fan-in/fan-out):
```
teammate({
  tasks: [
    { agent: "scout", name: "api", task: "List all API routes",
      outputSchema: { type: "object", properties: { routes: { type: "array" } }, required: ["routes"] } },
    { agent: "scout", name: "db", task: "Map the database schema" },
    { agent: "reviewer", task: "Routes: {api.routes}\nDB: {db}\n\nCheck consistency" }
  ]
})
```

**变量引用语法:**

| 语法 | 解析为 |
|------|--------|
| `{name}` | 任务全文输出；若有 outputSchema 则为 JSON |
| `{name.field}` | 结构化输出的指定字段 |
| `{name.arr[0].path}` | 嵌套字段 + 数组索引 |

仅命名任务可被引用。非任务名的 `{braces}` 不受影响。

**TaskSpec (单任务 + tasks 项共用):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | Yes | Agent definition name (matches `agents/*.md`) |
| `task` | string | No | Task description，支持 `{name}` 变量引用 |
| `name` | string | No | 任务标识 — 变量引用 + teammate-send 寻址 |
| `model` | string | No | 模型覆盖（per-task 优先于 top-level） |
| `cwd` | string | No | 工作目录（per-task 优先于 top-level） |
| `outputSchema` | object | No | JSON Schema 结构化输出，下游可用 `{name.field}` |
| `timeoutMs` | integer | No | 超时（per-task 优先于 top-level） |

**Top-level 控制字段 (所有模式生效):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tasks` | TaskSpec[] | — | 多任务，`{name}` 引用定义执行顺序 |
| `concurrency` | integer | 4 | 最大并发任务数 |
| `background` | boolean | `true` | 后台运行；`false` 阻塞（Alt+B 可分离） |
| `reply_to` | `"caller"` \| `"main"` | caller | 结果路由 |
| `chain` | array | — | **[Deprecated]** 用 tasks + `{name}` 引用代替 |

### teammate-send

向已命名的运行中 agent 发送消息。通过 RPC stdin 注入。

```
teammate-send({
  to: "auth",
  message: "Also fix the login handler",
  mode: "follow_up"
})
```

| Mode | Behavior |
|------|----------|
| `steer` | 打断当前执行，立即注入 |
| `follow_up` | 等当前 turn 完成后执行 |
| `abort` | 取消 agent |

消息记录到 agent inbox，overlay 实时显示 `◀ follow_up: message...`。

### teammate-watch

查看指定 agent 的实时输出和活动日志。

```
teammate-watch({ name: "auth", lines: 30 })
```

返回最近 N 行（默认 20）的工具调用记录和流式输出：
```
[delegate/auth] up 45s | idle 3s | log 82 lines | inbox 1
---
[09:15:32] ~ Read src/auth.ts
[09:15:33] ✓ Read src/auth.ts
I'll fix the login handler by updating the token refresh logic...
```

### teammate-list

列出活跃的 teammate agent。

```
teammate-list({ view: "active" })
```

| View | Description |
|------|-------------|
| `active` | 所有运行中 agent（默认） |
| `named` | 仅可寻址（有 name）的 agent |
| `all` | 所有 agent 含已完成元数据 |

输出（含嵌套树形显示）:
```
[coordinator/worker] name="worker" | up 45s | idle 3s | inbox: 0
  └─ [scout] name="recon" | up 30s | idle 2s | depth 1
  └─ [delegate] name="impl" | up 20s | idle 1s | depth 1
```

`teammate-watch` 也支持查看嵌套 agent（按 name 查找，只读）。

## 平铺 Agent 模型

所有 agent 由 root 进程统一管理，平铺在同一个 `activeRuns` 池中。子 agent 调用 teammate 工具时，通过 proxy 请求 root spawn 新 agent——新 agent 是 root 的直属子进程，不是嵌套子进程。

**直达发送**: `teammate-send({ to: "name" })` = `namedAgents.get(name) → stdin`。一次查找，直接投递，无 IPC 链，无中继。

**coordinator**: 已配置 teammate 全套工具（proxy 版），可动态 spawn、send、list、watch。

## TUI 交互

| 快捷键 | 功能 |
|--------|------|
| Alt+R | 打开 agent 选择器 → attach overlay（多 agent tab 切换） |
| Alt+B | 前台阻塞模式下分离到后台 |
| Tab/Shift+Tab | Overlay 内切换 agent tab |
| ↑↓ | Overlay 内滚动日志 |
| ESC | 关闭 overlay |

**Widget**: 编辑器下方显示活跃 agent 状态，2s 自动刷新，无 agent 时自动隐藏。

## Maestro Tools

### maestro

Main dispatch tool with action-based routing.

**action: "explore"** — 并行代码探索

```
maestro({
  action: "explore",
  prompts: [
    "FIND: authentication middleware\nSCOPE: src/middleware/",
    "FIND: JWT token validation\nSCOPE: src/auth/"
  ],
  endpoint: "api-explore",
  maxTurns: 6,
  concurrency: 4
})
```

**action: "delegate"** — 任务委托到外部 CLI 工具

```
maestro({
  action: "delegate",
  prompt: "PURPOSE: ...\nTASK: ...\nMODE: analysis\nCONTEXT: @src/**/*.ts\nEXPECTED: ...",
  tool: "claude",
  mode: "write",
  rule: "development-refactor-codebase"
})
```

**action: "moa"** — Mixture-of-Agents synthesis

```
maestro({ action: "moa", prompts: ["Analyze the payment flow"], preset: "default" })
```

#### Delegate Prompt 格式

| 字段 | 必填 | 说明 |
|------|------|------|
| `PURPOSE` | **是** | 目标 + 成功标准 |
| `TASK` | **是** | 具体步骤，`\|` 分隔 |
| `MODE` | 否 | `analysis` / `write`（`--mode` 参数权威） |
| `CONTEXT` | 否 | 文件范围 `@src/**/*.ts` |
| `EXPECTED` | 否 | 输出格式 |
| `CONSTRAINTS` | 否 | 作用域限制 |

#### --rule 模板

| 类别 | 模板名 |
|------|--------|
| 通用 | `universal-rigorous-style`, `universal-creative-style` |
| 分析 | `analysis-trace-code-execution`, `analysis-diagnose-bug-root-cause`, `analysis-analyze-code-patterns`, `analysis-review-code-quality`, `analysis-analyze-performance`, `analysis-assess-security-risks` |
| 规划 | `planning-plan-architecture-design`, `planning-breakdown-task-steps`, `planning-design-component-spec`, `planning-plan-migration-strategy` |
| 开发 | `development-implement-feature`, `development-refactor-codebase`, `development-generate-tests`, `development-implement-component-ui`, `development-debug-runtime-issues` |

### maestro-wait

阻塞等待后台运行完成。

```
maestro-wait({ id: "run-123", all: true, timeoutMs: 600000 })
```

### maestro-status

查看运行中或已完成的 teammate fleet。

```
maestro-status({ id: "run-123", view: "fleet" })
```

## Maestro CLI Commands

### maestro search — 知识搜索

```bash
maestro search "<query>" [--type spec|knowhow|domain|issue] [--code] [--kg]
```

### maestro load — 加载知识

```bash
maestro load --type <type> [--list] [--category <cat>] [--keyword <word>] [--id <id>]
```

### maestro delegate — 委托执行

```bash
maestro delegate "<PROMPT>" --to <tool> --mode <mode> [--rule <template>] [--resume]
```

### maestro explore — 代码探索

```bash
maestro explore "FIND: ...\nSCOPE: ..." [more prompts...] [--json] [--all]
```

## Agent Definitions

`pi-teammate/agents/` 下的 agent 定义文件：

| Agent | Role |
|-------|------|
| `delegate` | 通用单任务执行（读写、编辑、bash） |
| `coordinator` | DAG 多任务编排协调，使用 `{name}` 变量引用定义数据流 |

## Architecture

```
pi-maestro-flow/
├── pi-teammate/          — Core teammate dispatch extension
│   ├── src/
│   │   ├── extension/    — index.ts (tools), schemas.ts
│   │   ├── runs/         — execution.ts (RPC subprocess)
│   │   ├── tui/          — render.ts, attach-overlay.ts
│   │   ├── shared/       — types.ts
│   │   └── agents/       — agent discovery
│   └── agents/           — Agent definitions (*.md)
├── flow/                 — Maestro tools extension (explore, delegate, moa)
└── .pi/                  — AGENTS.md (this file)
```

### Subprocess Model

```
[Pi main session]
  └── teammate tool call
       └── spawn: node cli.js --mode rpc
            ├── stdin: RPC JSON lines (prompt/steer/follow_up/abort)
            ├── stdout: JSON line events (agent_start/end, message_update, tool_execution_*)
            └── agent_end → resolve Promise → cleanup → pi.sendMessage(triggerTurn)
```
