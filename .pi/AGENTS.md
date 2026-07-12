# pi-maestro-flow

Maestro workflow orchestration for Pi coding agent.

## Prerequisites

- **Pi coding agent** (`pi`) — the host runtime
- **Maestro CLI** (`maestro`) — provides `search`, `load`, `delegate`, `explore` commands
- **pi-maestro-teammate** — teammate dispatch (installed automatically as dependency)

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

## Architecture

```
pi-maestro-flow/
├── .pi/
│   ├── skills/               — 113 skills (project-level, Pi native)
│   ├── agents/               — 29 agent definitions (teammate discoverAgents)
│   └── AGENTS.md             — This file
├── packages/
│   ├── pi-maestro-teammate/  — Core teammate dispatch extension
│   │   ├── src/
│   │   │   ├── extension/    — index.ts (tools), schemas.ts
│   │   │   ├── runs/         — execution.ts (RPC subprocess)
│   │   │   ├── tui/          — render.ts, attach-overlay.ts
│   │   │   ├── shared/       — types.ts
│   │   │   └── agents/       — agent discovery
│   │   └── agents/           — Builtin agent definitions (*.md)
│   └── pi-maestro-flow/      — Maestro tools extension (explore, delegate, moa)
│       ├── src/
│       ├── workflows/        — 82 workflow reference docs
│       └── templates/        — 23 template files
└── docs/                     — Development guides
```

### Subprocess Model

```
[Pi main session]
  └── teammate tool call
       ├── context: "fresh" (default)
       │    └── spawn: pi --mode rpc
       └── context: "fork"
            └── spawn: pi --mode rpc --fork <parent-session.jsonl> --session-dir <child-dir>
                 (子进程加载父会话完整对话历史，task 作为新 turn 继续)

  [spawned subprocess]
       ├── stdin: RPC JSON lines (prompt/steer/follow_up/abort)
       ├── stdout: JSON line events (agent_start/end, message_update, tool_execution_*)
       ├── IPC: teammate_proxy_request/result (child ↔ root)
       └── agent_end → resolve Promise → sleeping (process stays alive)
                     → teammate-send follow_up → new turn → agent_end → sleeping → ...
                     → teammate-send abort → kill process → completed
```
