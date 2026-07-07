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
  prompt: "PURPOSE: Refactor auth module\nTASK: Extract JWT logic\nMODE: write",
  tool: "claude",             // Target: "claude" | "codex" | "opencode" | "agy"
  mode: "write",              // "analysis" (read-only) | "write" (modify)
  model: "claude-opus-4-6",   // Model override
  rule: "development-refactor-codebase"  // Prompt template
})
```

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

```bash
# Knowledge search
maestro search "<query>" [--type spec|knowhow] [--code] [--kg]

# Load knowledge
maestro load --type <type> [--category <cat>] [--id <id>]

# Delegate to external tool
maestro delegate "<PROMPT>" --to <tool> --mode analysis|write

# Codebase exploration
maestro explore "FIND: <target>\nSCOPE: <paths>"
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
