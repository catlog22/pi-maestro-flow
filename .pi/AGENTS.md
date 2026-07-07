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

**Single mode** (requires `agent`):
```
teammate({ agent: "delegate", task: "Implement the auth module", name: "auth" })
```

**Parallel mode** (top-level `agent` optional):
```
teammate({
  tasks: [
    { agent: "delegate", task: "Refactor auth module" },
    { agent: "delegate", task: "Add unit tests for auth" }
  ],
  concurrency: 4
})
```

**Chain mode** (sequential pipeline):
```
teammate({
  chain: [
    { agent: "explorer", task: "Find all auth endpoints" },
    { agent: "delegate", task: "Fix security issues in: {previous}" }
  ]
})
```

**Full parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | Single mode | Agent definition name (matches `agents/*.md`) |
| `task` | string | No | Task description |
| `name` | string | No | Addressable name (enables send/watch) |
| `reply_to` | `"caller"` \| `"main"` | No | Result routing (default: caller) |
| `tasks` | array | Parallel | `[{ agent, task, model?, cwd? }]` |
| `chain` | array | Chain | `[{ agent, task?, model? }]` with `{previous}` |
| `concurrency` | integer | No | Max parallel tasks (default: 4) |
| `background` | boolean | No | Default `true`. Set `false` to block (Alt+B detaches) |
| `model` | string | No | Model override |
| `outputSchema` | object | No | JSON Schema for structured output |
| `timeoutMs` | integer | No | Timeout in ms |
| `cwd` | string | No | Working directory |

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

输出: `[delegate] name="auth" | up 45s | idle 3s | inbox: 0`

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
| `delegate` | 通用任务执行（读写、编辑、bash） |
| `coordinator` | 多 agent 编排协调 |

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
