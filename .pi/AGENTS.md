# pi-maestro-flow

Maestro workflow orchestration for Pi coding agent.

## Prerequisites

- **Pi coding agent** (`pi`) — the host runtime
- **Maestro CLI** (`maestro`) — provides `search`, `load`, `delegate`, `explore` commands
- **pi-maestro-teammate** — teammate dispatch (installed automatically as dependency)

## Built-in Tools

### teammate

Dispatch tasks to teammate agents. Teammates run as pi subprocesses with their own tools and context.

```
teammate({
  // --- Single mode ---
  agent: "delegate",          // Agent definition name (matches agents/*.md)
  task: "Implement the auth module",

  // --- P0 Three-axis control ---
  name: "auth-worker",        // Optional: addressable name for routing
  reply_to: "caller",         // "caller" (direct return) | "main" (broadcast)
  lifecycle: "ephemeral",     // "ephemeral" (one-shot) | "resident" (persistent)

  // --- Parallel mode ---
  tasks: [
    { agent: "scout", task: "Find auth code" },
    { agent: "reviewer", task: "Review auth patterns" }
  ],
  concurrency: 4,

  // --- Chain mode ---
  chain: [
    { agent: "scout", task: "Find all API endpoints" },
    { agent: "delegate", task: "Fix issues found: {previous}" }
  ],

  // --- Structured output ---
  outputSchema: { type: "object", properties: { bugs: { type: "array" } } },

  // --- Execution ---
  model: "claude-opus-4-6",   // Model override
  context: "fresh",           // "fresh" | "fork"
  mode: "await",              // "await" | "detach"
  cwd: "/path/to/project",
  timeoutMs: 300000
})
```

### maestro

Main dispatch tool with action-based routing.

**action: "explore"** — Parallel codebase exploration

```
maestro({
  action: "explore",
  prompts: [
    "FIND: authentication middleware\nSCOPE: src/middleware/",
    "FIND: JWT token validation\nSCOPE: src/auth/"
  ],
  endpoint: "api-explore",    // Optional: specific model
  all: false,                 // Fan out to all endpoints
  maxTurns: 6,
  concurrency: 4
})
```

**action: "delegate"** — Task delegation to external CLI tools

```
maestro({
  action: "delegate",
  prompt: "<PROMPT>",          // Structured prompt (see format below)
  tool: "claude",             // Target: "claude" | "codex" | "opencode" | "agy"
  mode: "write",              // "analysis" (read-only) | "write" (modify)
  model: "claude-opus-4-6",   // Model override
  rule: "development-refactor-codebase"  // Prompt template (see list below)
})
```

#### Delegate Prompt 格式

6 字段结构化 prompt，`PURPOSE` + `TASK` 必填：

```
PURPOSE: [goal] + [success criteria]
TASK: [step 1] | [step 2] | [step 3]
MODE: analysis|write
CONTEXT: @[file patterns] | Memory: [prior work]
EXPECTED: [output format]
CONSTRAINTS: [scope limits]
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `PURPOSE` | **是** | 目标 + 成功标准，一句话定义"什么算完成" |
| `TASK` | **是** | 具体步骤，用 `\|` 分隔多步 |
| `MODE` | 否 | `analysis`（只读）/ `write`（可修改），仅作提示，`--mode` 参数才是权威 |
| `CONTEXT` | 否 | 文件范围 `@src/**/*.ts`，或引用上下文 `Memory: prior analysis` |
| `EXPECTED` | 否 | 输出格式：`JSON [{...}]`、`file:line list`、`summary` |
| `CONSTRAINTS` | 否 | 作用域限制、不可触碰的区域、兼容性要求 |

#### CONTEXT 文件模式

```
@**/*                  → 全部文件（默认）
@src/**/*.ts           → 限定范围
@../shared/**/*        → 兄弟目录（需 --includeDirs ../shared）
```

#### --rule 模板列表

| 类别 | 模板名 |
|------|--------|
| **通用** | `universal-rigorous-style`, `universal-creative-style` |
| **分析** | `analysis-trace-code-execution`, `analysis-diagnose-bug-root-cause`, `analysis-analyze-code-patterns`, `analysis-analyze-technical-document`, `analysis-review-architecture`, `analysis-review-code-quality`, `analysis-analyze-performance`, `analysis-assess-security-risks` |
| **规划** | `planning-plan-architecture-design`, `planning-breakdown-task-steps`, `planning-design-component-spec`, `planning-plan-migration-strategy` |
| **开发** | `development-implement-feature`, `development-refactor-codebase`, `development-generate-tests`, `development-implement-component-ui`, `development-debug-runtime-issues` |

#### Delegate 示例

**分析型**（read-only，诊断 bug）：
```
maestro({
  action: "delegate",
  prompt: "PURPOSE: Diagnose why login fails after token refresh; success = root cause identified with file:line evidence\nTASK: Trace token refresh flow | Check expiry logic | Find where stale token is used\nMODE: analysis\nCONTEXT: @src/auth/**/*.ts\nEXPECTED: root cause + fix recommendation with file:line",
  tool: "codex",
  mode: "analysis",
  rule: "analysis-diagnose-bug-root-cause"
})
```

**实现型**（write，重构代码）：
```
maestro({
  action: "delegate",
  prompt: "PURPOSE: Extract JWT validation into standalone middleware; success = all tests pass + no auth regression\nTASK: Create src/middleware/jwt.ts | Move validation logic from auth.ts | Update imports | Run tests\nMODE: write\nCONTEXT: @src/auth/**/* @src/middleware/**/*\nEXPECTED: Working code changes with test verification\nCONSTRAINTS: Backward compatible | No public API changes",
  tool: "claude",
  mode: "write",
  rule: "development-refactor-codebase"
})
```

**规划型**（分析后输出 JSON）：
```
maestro({
  action: "delegate",
  prompt: "PURPOSE: Break down caching layer implementation into subtasks; success = ordered task list with dependencies\nTASK: Analyze current data flow | Identify cache insertion points | Design cache invalidation strategy | Decompose into ordered tasks\nMODE: analysis\nCONTEXT: @src/api/**/*.ts @src/db/**/*.ts\nEXPECTED: JSON [{task_id, title, description, deps, files}]",
  tool: "claude",
  mode: "analysis",
  rule: "planning-breakdown-task-steps"
})
```

#### Delegate 执行规则

- `mode: "analysis"` 可主动触发（自修复失败、需求模糊、架构决策时）
- `mode: "write"` 需用户确认后执行
- 执行后通过 `maestro-wait` 或 `maestro-status` 跟踪进度
- 支持 `resume` 恢复中断的 session

**action: "moa"** — Mixture-of-Agents synthesis

```
maestro({
  action: "moa",
  prompts: ["Analyze the payment flow architecture"],
  preset: "default"
})
```

### maestro-wait

Block until background maestro/teammate runs finish.

```
maestro-wait({
  id: "run-123",              // Specific run ID (optional)
  all: true,                  // Wait for all active runs
  timeoutMs: 600000
})
```

### maestro-status

Inspect running or completed teammate fleet.

```
maestro-status({
  id: "run-123",              // Specific run ID (optional)
  view: "fleet"               // "fleet" | "transcript"
})
```

## Maestro CLI Commands

Skills use these CLI commands (require maestro installed):

### maestro search — 知识搜索

```bash
maestro search "<query>" [--type spec|knowhow|domain|issue] [--code] [--kg]
```

1-3 个核心关键词，短查询多次优于长查询一次。`--code` 搜代码符号，`--kg` 搜全源。

### maestro load — 加载知识

```bash
maestro load --type <type> [--list] [--category <cat>] [--keyword <word>] [--id <id>]
```

`--type`: spec, knowhow, domain, issue, session, scratch, note, project, roadmap
`--category` (spec): coding, arch, debug, test, review, learning, ui

### maestro delegate — 委托执行

```bash
maestro delegate "<PROMPT>" [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--to <tool>` | claude, codex, opencode, agy | First enabled |
| `--mode <mode>` | `analysis` (read-only) / `write` (modify) | `analysis` |
| `--model <model>` | Model override | Tool's primaryModel |
| `--rule <template>` | Prompt template | — |
| `--id <id>` | Execution ID | Auto |
| `--resume [id]` | Resume previous session | — |
| `--cd <dir>` | Working directory | Current |
| `--includeDirs <dirs>` | Additional directories | — |

Prompt 格式同上述 delegate action。ID prefix: claude→`cld`, codex→`cdx`, opencode→`opc`, agy→`agy`.

```bash
# 分析模式
maestro delegate "PURPOSE: Find all SQL injection risks\nTASK: Scan query builders\nCONTEXT: @src/db/**/*\nEXPECTED: file:line list" --to codex --mode analysis

# 写入模式
maestro delegate "PURPOSE: Fix auth bug\nTASK: Patch token refresh\nMODE: write" --to claude --mode write

# 恢复 session
maestro delegate "Continue fixing" --to claude --resume

# 消息注入
maestro delegate message <exec-id> "additional context"
maestro delegate message <exec-id> "next task" --delivery after_complete
```

### maestro explore — 代码探索

```bash
maestro explore "<PROMPT>" [more prompts...] [--json] [--all] [--max-turns <n>]
```

Prompt 结构：`FIND` + `SCOPE` 必填。

```bash
maestro explore "FIND: JWT validation logic\nSCOPE: src/auth/, src/middleware/\nEXPECTED: file:line list"
```

多 prompt 并发（每个 prompt 一个 agent）：

```bash
maestro explore \
  "FIND: All exported functions\nSCOPE: src/auth/" \
  "FIND: All imports from auth\nSCOPE: src/**/*.ts\nEXCLUDE: src/auth/" \
  --json
```

## Agent Definitions

28 agent definitions in `agents/`. Used by `teammate` tool:

| Agent | Role | Tools |
|-------|------|-------|
| `explorer` | Read-only codebase exploration | read, grep, find, ls |
| `delegate` | General-purpose task execution | read, grep, find, ls, bash, edit, write |
| `workflow-executor` | Atomic task implementation | Read, Write, Edit, Glob, Grep, Bash |
| `workflow-planner` | Execution plan creation | Read, Glob, Grep, Bash |
| `workflow-reviewer` | Multi-dimensional code review | Read, Glob, Grep, Bash |
| `team-worker` | Role-specific pipeline execution | All tools |
| `team-supervisor` | Pipeline health monitoring | All tools |

## Skills Usage

113 skills available as `/skill:name`:

```
/skill:maestro-analyze auth-refactor
/skill:odyssey-planex "Add caching layer" --template feature
/skill:quality-review --level deep
/skill:maestro-delegate "Fix login bug" --to claude --mode write
```

## Coding Guidelines

- Follow existing code patterns — read before writing
- Minimize changes — only modify what's required
- Fix, don't hide — no `@ts-ignore`, no skipped tests
- Incremental commits — small changes that compile and pass
