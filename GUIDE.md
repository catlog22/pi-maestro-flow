# pi-maestro-flow User Guide

> Comprehensive guide to multi-agent orchestration with pi-maestro-flow and Pi Coding Agent.

---

## Table of Contents

1. [Installation & Setup](#1-installation--setup)
2. [Concepts](#2-concepts)
3. [Teammate Dispatch](#3-teammate-dispatch)
4. [Explorer Protocol](#4-explorer-protocol)
5. [Knowledge System](#5-knowledge-system)
6. [Skills Deep Dive](#6-skills-deep-dive)
7. [Agent Roles](#7-agent-roles)
8. [Prompt Templates](#8-prompt-templates)
9. [Workflow Patterns](#9-workflow-patterns)
10. [Advanced: DAG Graphs](#10-advanced-dag-graphs)
11. [Advanced: Subprocess Model](#11-advanced-subprocess-model)
12. [Advanced: Custom Agents & Prompts](#12-advanced-custom-agents--prompts)
13. [Configuration Reference](#13-configuration-reference)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Installation & Setup

### Prerequisites

```bash
# 1. Node.js ≥ 22.19.0
node --version

# 2. Pi Coding Agent globally
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# 3. Maestro CLI globally (for knowledge features)
npm install -g maestro-flow

# 4. Authenticate Pi
export ANTHROPIC_API_KEY=sk-ant-...
# Or: pi → /login → select provider
```

### Install pi-maestro-flow

```bash
# Install both packages (teammate auto-installed as dependency)
pi install npm:pi-maestro-flow

# Verify
pi list
# Expected: pi-maestro-flow@0.4.1, pi-maestro-teammate@0.4.1
```

### First Run

```bash
pi
```

On startup, trust the project when prompted. Type `/skill:maestro-help` to explore available commands.

---

## 2. Concepts

### The Three Layers

```
┌─────────────────────────────────────────┐
│  Skills (104)                            │
│  /skill:maestro-plan, /skill:team-...    │
│  High-level workflows, user-facing       │
├─────────────────────────────────────────┤
│  Teammate & Maestro Tools                │
│  Dispatch, explore, delegate, moa        │
│  Mid-level orchestration                 │
├─────────────────────────────────────────┤
│  Agent Roles (29)                        │
│  explorer, reviewer, planner, debugger   │
│  Low-level task execution                │
└─────────────────────────────────────────┘
```

- **Skills** are Markdown workflow definitions in `.pi/skills/`. Invoke via `/skill:name` or auto-load.
- **Tools** are Pi extensions. `teammate` spawns subprocess agents; `maestro` provides explore/delegate/moa.
- **Agent Roles** are Markdown system prompts defining specialized subprocess behaviors.

### When to Use What

| Scenario | Tool/Skill |
|----------|------------|
| Find where something is defined | `teammate` + `agent: "explorer"` |
| Read-only analysis | `teammate` + `taskType: "analysis"` |
| Implement a feature | `/skill:maestro-execute` or `teammate` + `taskType: "development"` |
| Full project planning | `/skill:maestro-plan` → `/skill:maestro-execute` |
| Debug a complex bug | `/skill:odyssey-debug` |
| Code review | `/skill:team-review` or `teammate` + `prompt: "review"` |
| Team coordination | `/skill:team-lifecycle-v4` |
| Build knowledge base | `/skill:spec-add`, `/skill:manage-knowhow-capture` |

---

## 3. Teammate Dispatch

### Basic Single-Task (Foreground)

```javascript
teammate({
  agent: "delegate",
  taskType: "analysis",
  task: "PURPOSE: Review authentication for security issues\nTASK: Trace login flow | Check token handling | Check password storage\nMODE: analysis\nCONTEXT: @src/auth/**/*.ts\nEXPECTED: Security issues with file:line evidence\nCONSTRAINTS: Read-only; do not modify files",
  model: "deepseek/deepseek-v4-pro",
  background: false
})
```

Blocks until complete. Result returned directly to caller.

### Parallel Tasks

```javascript
teammate({
  taskType: "explore",
  background: false,
  tasks: [
    {
      name: "api-routes",
      agent: "explorer",
      task: "FIND: All Express route definitions\nSCOPE: src/routes/\nEXPECTED: method, path, file:line"
    },
    {
      name: "middleware",
      agent: "explorer",
      task: "FIND: All middleware applied globally or per-route\nSCOPE: src/middleware/, src/app.ts\nEXPECTED: name, file:line, scope"
    },
    {
      name: "schemas",
      agent: "explorer",
      task: "FIND: All Zod/TypeBox schema definitions\nSCOPE: src/schemas/, src/models/\nEXPECTED: name, type, file:line"
    }
  ]
})
```

All three run concurrently. Call blocks until all complete.

### DAG Dependencies

```javascript
teammate({
  tasks: [
    {
      name: "find-bugs",
      agent: "explorer",
      task: "FIND: Null pointer risks\nSCOPE: src/**/*.ts\nEXCLUDE: **/*.test.ts\nEXPECTED: file:line list with risk",
      outputSchema: { type: "object", properties: { findings: { type: "array" } } }
    },
    {
      name: "fix-bugs",
      agent: "delegate",
      task: "PURPOSE: Fix all issues\nTASK: Process {find-bugs.findings} | Apply safe null checks\nMODE: write\nEXPECTED: Fixed files with changes\nCONSTRAINTS: Only add null guards; no refactoring",
      taskType: "development"
    },
    {
      name: "verify",
      agent: "delegate",
      task: "PURPOSE: Verify fixes from {fix-bugs}\nTASK: Read changed files | Run tests | Check no regression\nMODE: analysis\nEXPECTED: Pass/fail per fix",
      taskType: "review"
    }
  ]
})
```

Use `{name}` for raw output, `{name.field}` for structured fields (requires `outputSchema`).

### Background Tasks

```javascript
teammate({
  name: "long-test",
  agent: "delegate",
  task: "Run full test suite",
  background: true
})
// Continue working; teammate-complete notification triggers new turn when done
```

### Agent Control

```javascript
teammate-list({ view: "all" })                          // Status of all agents
teammate-watch({ name: "long-test", lines: 50 })        // Inspect output
teammate-send({ to: "agent", message: "...", mode: "follow_up" })  // Queue message
teammate-send({ to: "agent", message: "...", mode: "steer" })       // Urgent redirect
teammate-send({ to: "agent", mode: "abort" })           // Terminate
```

### Context & Lifecycle

| Parameter | Options | Purpose |
|-----------|---------|---------|
| `context` | `"fresh"` (default) | Clean subprocess, only task description |
| `context` | `"fork"` | Inherits full parent conversation history |
| `name` | any string | Addressable name for follow-up and DAG refs |
| `reply_to` | `"caller"` / `"main"` | Where `agent_end` result is delivered |
| `lifecycle` | `"ephemeral"` (default) | Process exits on completion |
| `lifecycle` | `"resident"` | Process sleeps, awaits `teammate-send` commands |

---

## 4. Explorer Protocol

### Mandatory Prompt Structure

```
FIND: <concrete, decidable target + condition>
SCOPE: <explicit paths or bounded globs>
EXCLUDE: <directories or file types to skip>
ATTENTION: <framework, conventions, known pitfalls>
EXPECTED: <required output format>
```

`FIND` and `SCOPE` are mandatory.

### Examples

```javascript
// Find authentication middleware
teammate({
  agent: "explorer",
  taskType: "explore",
  task: "FIND: Auth middleware validating JWT tokens\nSCOPE: src/middleware/, src/auth/\nATTENTION: Express.js; *.middleware.ts naming convention\nEXPECTED: file:line + control-flow summary",
  background: false
})

// Find unsafe SQL patterns
teammate({
  agent: "explorer",
  taskType: "explore",
  task: "FIND: db.query() with string concatenation instead of positional parameters\nSCOPE: src/db/**/*.ts, src/api/**/*.ts\nEXCLUDE: **/*.test.ts\nEXPECTED: file:line including SQL expression",
  background: false
})
```

### Cross-Search Strategy

For high confidence, run 2-3 explorers from different angles:

| Angle | Task A | Task B |
|-------|--------|--------|
| Definition vs usage | Find exported definitions | Find imports and call sites |
| Positive vs missing | Find correct implementations | Find places missing the convention |
| Entry vs implementation | Find routes or exports | Find internal logic |
| File type | Find TypeScript usage | Find UI/template usage |

**Confidence rules:**
- ✅ Two matching angles → high confidence
- ⚠️ One matching angle → verify with `rg` or read
- ❌ Zero matches → change angle or conclude absent

---

## 5. Knowledge System

### Mandatory Gate

**Before any code access or dispatch:**

```bash
maestro search "<query>" [--type spec|knowhow|domain|issue] [--code] [--kg]
maestro load --type <type> [--category <cat>] [--keyword <word>]
```

### Query Best Practices

```bash
# ❌ Avoid keyword dumps
maestro search "topology display frontend DetailedTopologySVG elk layout rendering"

# ✅ Prefer focused queries
maestro search "topology layout"
maestro search "DetailedTopologySVG" --code
maestro load --type spec --category coding
```

### Knowledge Types

| Type | Purpose |
|------|---------|
| `spec` | Reusable conventions: `arch`, `coding`, `debug`, `test`, `review`, `learning`, `ui` |
| `knowhow` | Task-specific patterns and recipes |
| `domain` | Project glossary terms |
| `issue` | Tracked bugs and tasks |
| `roadmap` | Milestone and phase planning |

### Adding Knowledge

```bash
/spec-add coding "Use Result<T,E>" "Service methods must return Result<T,AppError>, not throw" --keywords error-handling,result-type
/manage-knowhow-capture
/domain-add "Workspace" "Top-level organizational unit containing projects, members, settings"
```

### Lifecycle Management

```bash
maestro spec supersede SPEC-042 --by SPEC-089     # Replace old rule
maestro spec conflict mark src/auth/login.ts 45 --note "JWT vs session: both valid"  # Flag conflict
maestro spec history SPEC-042                     # View history
maestro spec health                                # Health check
maestro search "old pattern" --include-deprecated  # Search all
```

---

## 6. Skills Deep Dive

### Orchestration Pipeline

```bash
/skill:maestro-analyze "Implement payment gateway"     # Understand problem
/skill:maestro-plan --spec SPEC-042                   # Create plan
/skill:maestro-execute                                 # Execute with verification
/skill:quality-review --level standard --dimensions security,architecture,performance
/skill:quality-test --smoke --frontend-verify          # Acceptance testing
```

### Odyssey: Long-Running Cycles

```bash
/skill:odyssey-planex "Build real-time notifications" --max-iterations 5
/skill:odyssey-debug "Memory leak in WebSocket" --auto
/skill:odyssey-improve src/services/ --dimensions security,performance,maintainability
/skill:odyssey-ui src/components/Dashboard --fix-threshold medium
```

### Team Coordination

```bash
/skill:team-coordinate "Build real-time collaboration feature"
/skill:team-lifecycle-v4
/skill:team-review src/ --level deep
/skill:team-quality-assurance
```

### UI & Design

```bash
/skill:maestro-ui-codify src/components/ --package-name my-design-system
/skill:team-ui-polish src/pages/
/skill:team-visual-a11y --level WCAG-AA
/skill:team-motion-design
```

### Knowledge Management

```bash
/skill:manage-knowledge-audit --scope all --level P0 --interactive
/skill:manage-codebase-rebuild --force
/skill:manage-drift-realign --scope all --since HEAD~10
/skill:manage-harvest SESSION-123 --to spec --auto
```

### Scholar (Academic Writing)

```bash
/skill:scholar-ideation "Research question about transformer architectures"
/skill:scholar-writing  # End-to-end paper writing for ML/AI conferences
/skill:scholar-review   # Self-review + rebuttal
/skill:scholar-citation-verify  # Four-layer citation verification
/skill:scholar-experiment  # Experimental results analysis
```

---

## 7. Agent Roles

### Explorer
Read-only code discovery. Optimized for fast parallel search.

```javascript
teammate({
  agent: "explorer",
  taskType: "explore",
  task: "FIND: React components with useState lacking cleanup\nSCOPE: src/components/\nEXPECTED: component name + file:line"
})
```

### Delegate
General-purpose analysis and implementation workhorse.

```javascript
teammate({
  agent: "delegate",
  taskType: "development",
  prompt: "development-implement-feature",
  task: "Add rate limiting to login endpoint",
  promptArgs: ["@src/auth/ @src/middleware/", "Implementation + tests"]
})
```

### Workflow-Verifier
Three-layer verification: existence, substance, connection.

```javascript
teammate({
  agent: "workflow-verifier",
  taskType: "testing",
  task: "Verify: 'Implemented password reset flow'",
  context: "fork"
})
```

### Workflow-Reviewer
Run multiple in parallel for multi-dimensional review:

```javascript
teammate({
  taskType: "review",
  tasks: [
    { name: "sec", agent: "workflow-reviewer", task: "Review for security" },
    { name: "perf", agent: "workflow-reviewer", task: "Review for performance" },
    { name: "maint", agent: "workflow-reviewer", task: "Review for maintainability" }
  ]
})
```

### Other Key Agents

| Agent | Purpose |
|-------|---------|
| `workflow-planner` | Execution plans with task decomposition and waves |
| `workflow-executor` | Single-task implementation with verification |
| `workflow-debugger` | Hypothesis-driven debugging with evidence logging |
| `workflow-roadmapper` | Project roadmap with phased milestones |
| `workflow-nyquist-auditor` | Test coverage audit with stub generation |
| `goal-verifier` | Independent audit of goal completion claims |
| `team-supervisor` | Resident pipeline quality observer |
| `team-worker` | Unified worker executing role_spec logic |

---

## 8. Prompt Templates

### Using Templates

```javascript
// Analysis
teammate({
  agent: "delegate", taskType: "analysis",
  prompt: "analysis-trace-code-execution",
  task: "Trace JWT refresh flow",
  promptArgs: ["@src/auth/tokens.ts", "file:line evidence + state transitions"]
})

// Planning
teammate({
  agent: "delegate", taskType: "planning",
  prompt: "planning-design-component-spec",
  task: "Design DataTable component",
  promptArgs: ["@src/components/Table/", "Props, states, events, slots, a11y"]
})

// Development
teammate({
  agent: "delegate", taskType: "development",
  prompt: "development-implement-feature",
  task: "Implement pagination for search API",
  promptArgs: ["@src/api/search/", "Implementation + tests"]
})

// Compact
teammate({
  agent: "delegate", prompt: "review",
  task: "Review the auth module",
  promptArgs: ["@src/auth/", "Focus on security and error handling"]
})
```

### Full Template Catalog

**Analysis:** `analysis-trace-code-execution`, `analysis-diagnose-bug-root-cause`, `analysis-analyze-code-patterns`, `analysis-analyze-technical-document`, `analysis-review-architecture`, `analysis-review-code-quality`, `analysis-analyze-performance`, `analysis-assess-security-risks`

**Planning:** `planning-plan-architecture-design`, `planning-breakdown-task-steps`, `planning-design-component-spec`, `planning-plan-migration-strategy`

**Development:** `development-implement-feature`, `development-refactor-codebase`, `development-generate-tests`, `development-implement-component-ui`, `development-debug-runtime-issues`

**Compact:** `analysis`, `review`, `write`

### Custom Templates

Create `.pi/prompts/security-audit.md`:

```markdown
# Security Audit
Review for:
1. OWASP Top 10 vulnerabilities
2. Supply chain risks in {{dependency}}
3. Data exposure in {{dataFlow}}
Focus: {{focus}}
Expected: vulnerability list with severity and file:line
```

Use: `prompt: "security-audit"` with appropriate `promptArgs`.

---

## 9. Workflow Patterns

### Pattern 1: Gate → Explore → Implement
```
1. maestro search + load      → Knowledge Gate
2. teammate (explorer × 2-3)  → Cross-search for confidence
3. Targeted reads              → Verify single-match results
4. teammate (delegate)         → Implement with full context
5. /skill:quality-review       → Validate
```

### Pattern 2: Plan → Execute → Verify
```
1. maestro search + load      → Knowledge Gate
2. /skill:maestro-plan         → Create execution plan
3. /skill:maestro-execute      → Execute with step verification
4. workflow-verifier           → Goal-backward verification
5. /skill:quality-test         → Acceptance testing
```

### Pattern 3: Parallel Review → Synthesize → Fix → Re-Review
```
1. teammate (reviewer × 3)    → Security, performance, maintainability
2. teammate (delegate)         → Synthesize findings
3. teammate (delegate)         → Fix highest-priority issues
4. teammate (reviewer × 3)    → Re-review fixes
```

### Pattern 4: Odyssey Full Cycle
```
1. /skill:odyssey-debug        → Archaeology → Diagnosis → Fix → Generalize
2. /skill:quality-test         → Verify fix
3. /skill:manage-knowhow-capture → Persist lessons
4. /skill:manage-knowledge-audit → Prevent knowledge rot
```

### Pattern 5: Team-Driven Development
```
1. /skill:team-coordinate      → Dynamic team generation
2. /skill:team-lifecycle-v4    → Plan → Develop → Test → Review
3. /skill:team-review          → Independent verification
4. /skill:quality-test         → Final acceptance
```

---

## 10. Advanced: DAG Graphs

### Structured Output with JSON Schema

```javascript
teammate({
  tasks: [
    {
      name: "scan",
      agent: "workflow-reviewer",
      task: "Scan all changed files for security issues",
      outputSchema: {
        type: "object",
        properties: {
          critical: { type: "array", items: { type: "object", properties: { file: { type: "string" }, line: { type: "number" }, description: { type: "string" } } } },
          high: { type: "array", items: { type: "object" } },
          medium: { type: "array", items: { type: "object" } }
        }
      }
    },
    {
      name: "fix-critical",
      agent: "delegate",
      task: "PURPOSE: Fix critical issues\nTASK: Process {scan.critical} | Apply fixes | Add tests\nMODE: write\nEXPECTED: Fixed files + test results",
      taskType: "development"
    },
    {
      name: "fix-high",
      agent: "delegate",
      task: "PURPOSE: Fix high issues\nTASK: Process {scan.high} | Apply fixes | Add tests\nMODE: write\nEXPECTED: Fixed files + test results",
      taskType: "development"
    }
  ]
})
// scan runs first, then fix-critical and fix-high run in parallel
```

### Multi-Stage Pipeline

```javascript
teammate({
  tasks: [
    // Stage 1: Parallel research
    { name: "api-research", agent: "workflow-external-researcher", task: "Research rate limiting best practices" },
    { name: "codebase-survey", agent: "explorer", task: "FIND: All API endpoints + middleware\nSCOPE: src/api/\nEXPECTED: endpoint + middleware list" },

    // Stage 2: Plan (after research + survey complete)
    { name: "plan", agent: "workflow-planner", task: "PURPOSE: Create rate limiting plan\nTASK: Incorporate {api-research} + map to {codebase-survey}\nMODE: analysis\nEXPECTED: Phased plan with tasks" },

    // Stage 3: Implement (after plan)
    { name: "implement", agent: "workflow-executor", task: "PURPOSE: Execute {plan}\nTASK: Implement each phase | Test after each | Commit incrementally\nMODE: write\nEXPECTED: Implementation with passing tests" },

    // Stage 4: Verify (after implement)
    { name: "verify", agent: "workflow-verifier", task: "PURPOSE: Verify {implement} against {plan}\nTASK: Check existence, substance, connection\nMODE: analysis\nEXPECTED: Pass/fail per deliverable" }
  ]
})
```

Execution: `api-research` + `codebase-survey` → `plan` → `implement` → `verify`

---

## 11. Advanced: Subprocess Model

### Process Lifecycle

```
[Pi Main Process]
  └── teammate() call
       ├── Spawn: pi --mode rpc [--fork <session>]
       ├── stdin → JSONL RPC: prompt | steer | follow_up | abort
       ├── stdout ← JSONL events: agent_start → messages → tool_calls → agent_end
       └── Lifecycle
            ├── ephemeral: agent_end → resolve → process exits
            └── resident:   agent_end → resolve → sleep → await commands
```

### Agent States

| State | Description |
|-------|-------------|
| `running` | Actively processing a turn |
| `sleeping` | Turn complete, process alive, awaiting `teammate-send` |
| `completed` | Process exited normally |
| `aborted` | Process killed via abort |
| `errored` | Process exited with error |

### Child ↔ Root IPC

Agent subprocesses can proxy tool calls back to root when they lack a tool:

```
[Child] → teammate_proxy_request: { tool: "maestro", args: { action: "explore", ... } }
[Root]  → execute maestro tool
[Root]  → teammate_proxy_result: { result: ... }
[Child] → continue processing
```

---

## 12. Advanced: Custom Agents & Prompts

### Custom Agent

Create `.pi/agents/db-migrator.md`:

```markdown
# Database Migrator

You are a database schema migration specialist.

## Role
- Analyze existing schemas
- Plan safe migrations with rollback strategies
- Generate migration files with up/down methods

## Constraints
- Always include verified rollback plan
- Never modify production data without confirmation
- Follow project migration conventions

## Output Format
1. Schema diff (before → after)
2. Migration file (up + down)
3. Rollback verification plan
4. Risk assessment
```

Use: `teammate({ agent: "db-migrator", taskType: "planning", task: "..." })`

### Custom Prompt Template

Create `.pi/prompts/db-review.md`:

```markdown
# Database Migration Review
Review migration for:
1. Backward compatibility with {{before}}
2. Performance on large tables: {{sizes}}
3. Index usage and foreign key validity
4. Rollback feasibility
```

Use: `prompt: "db-review"` with `promptArgs`.

---

## 13. Configuration Reference

### Model Routing (`.pi/teammate-models.json`)

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

Configure interactively via `Alt+M` or `/teammate-models`.

### Key Pi Settings (`.pi/settings.json`)

```json
{
  "teammate": {
    "defaultBackground": false,
    "concurrency": 4,
    "timeoutMs": 300000
  }
}
```

---

## 14. Troubleshooting

### Teammate Fails to Start
```
Error: Failed to spawn teammate process
```
**Checks:** `which pi`, `node --version` (≥22.19.0), `/teammate-models` for model config.

### Explorer Returns No Results
**Fixes:** Verify `SCOPE` paths exist, make `FIND` more concrete, add `ATTENTION` with naming conventions.

### Knowledge Gate Fails
```
maestro: command not found
```
**Fix:** `npm install -g maestro-flow`

### Model Not Available
```
Error: Model not found in authenticated catalog
```
**Fix:** `/teammate-models` → check available models → `/login` to authenticate.

### Agent Hangs
```javascript
teammate-list({ view: "all" })                          // Check status
teammate-watch({ name: "stuck", lines: 50 })            // Inspect output
teammate-send({ to: "stuck", mode: "abort" })           // Kill
// Retry with timeout:
teammate({ agent: "delegate", task: "...", timeoutMs: 120000 })
```

### Long Session Context Overflow
```bash
/compact "Summarize key decisions and current state"
# Or use fresh context for heavy work:
teammate({ agent: "delegate", context: "fresh", task: "PURPOSE: Read state and continue\n..." })
```

---

## Quick Reference

```bash
# ─── Installation ───
pi install npm:pi-maestro-flow
pi list

# ─── Knowledge ───
maestro search "query" --code
maestro load --type spec --category coding
/spec-add coding "title" "content" --keywords k1,k2
/manage-knowhow-capture

# ─── Exploration ───
teammate({ agent: "explorer", taskType: "explore", task: "FIND: ...\nSCOPE: src/..." })

# ─── Analysis ───
teammate({ agent: "delegate", taskType: "analysis", prompt: "analysis-trace-code-execution", task: "...", promptArgs: ["@src/...", "file:line"], background: false })

# ─── Implementation ───
teammate({ agent: "delegate", taskType: "development", prompt: "development-implement-feature", task: "...", promptArgs: ["@src/...", "impl + tests"], background: false })

# ─── Review ───
teammate({ agent: "delegate", taskType: "review", prompt: "review", task: "Review auth", promptArgs: ["@src/auth/", "security + error handling"], background: false })
/skill:team-review src/ --level deep

# ─── Full Cycle ───
/skill:maestro-analyze "topic"
/skill:maestro-plan
/skill:maestro-execute
/skill:quality-review --level standard
/skill:quality-test

# ─── Debug ───
/skill:odyssey-debug "issue description" --auto

# ─── Team ───
/skill:team-lifecycle-v4
/skill:team-coordinate "complex task"

# ─── Agents ───
teammate-list({ view: "all" })
teammate-watch({ name: "agent-name", lines: 30 })
teammate-send({ to: "agent-name", message: "..." })
teammate-send({ to: "agent-name", mode: "abort" })
```
