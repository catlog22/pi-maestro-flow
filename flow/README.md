# pi-maestro-flow

> Maestro workflow orchestration for [Pi](https://github.com/earendil-works/pi) — tools, skills, and agent definitions

Pi extension providing Maestro's full workflow toolkit: explore/delegate/MOA tools, 113 skills (converted from maestro commands + skills), and 28 agent definitions. Built on [pi-teammate](../pi-teammate/) for the execution engine.

## Features

### Tools

| Tool | Purpose |
|------|---------|
| `maestro` | Main dispatch — `action: explore \| delegate \| moa` |
| `maestro-wait` | Block until background runs finish |
| `maestro-status` | Inspect running/completed teammate fleet |

### Skills (113)

All maestro commands and skills converted to Pi skill format. Available as `/skill:name` slash commands.

**Workflow orchestration:**
- `maestro-analyze` — Multi-dimensional analysis with scoring
- `maestro-plan` — Execution planning with task decomposition
- `maestro-execute` — Task execution with verification
- `maestro-ralph-v2` — Adaptive lifecycle orchestrator
- `maestro-roadmap` — Project roadmap generation

**Quality & review:**
- `quality-review` — Code quality review
- `quality-test` — Test generation and execution
- `quality-refactor` — Refactoring with behavior preservation
- `security-audit` — Security vulnerability analysis

**Odyssey workflows:**
- `odyssey-planex` — Requirement-to-delivery closed loop
- `odyssey-debug` — Hypothesis-driven debugging
- `odyssey-review-test-fix` — Review + test + fix cycle
- `odyssey-ui` — UI optimization workflow

**Team orchestration:**
- `team-coordinator` — Multi-role team pipeline
- `team-executor` — Session execution
- `team-frontend` — Frontend development team
- `team-quality-assurance` — QA pipeline

**Knowledge management:**
- `spec-add` / `spec-load` / `spec-remove` — Spec CRUD
- `manage-knowhow-capture` — Knowledge extraction
- `manage-knowledge-audit` — Knowledge health check

### Agent Definitions (28)

| Agent | Role |
|-------|------|
| `explorer` | Read-only codebase exploration |
| `delegate` | General-purpose task execution |
| `workflow-executor` | Atomic task implementation |
| `workflow-planner` | Execution plan creation |
| `workflow-reviewer` | Multi-dimensional code review |
| `workflow-verifier` | Goal-backward verification |
| `team-worker` | Role-specific pipeline execution |
| `team-supervisor` | Pipeline health monitoring |
| ... and 20 more |

### Dynamic Provider Registration

On startup, reads `~/.maestro/cli-tools.json` and registers each enabled tool as a Pi provider via `pi.registerProvider()`.

## Install

```bash
pi install npm:pi-maestro-flow
# or from local path
pi install ./flow
```

Requires `pi-maestro-teammate` as a dependency (installed automatically).

After installation, all 113 skills become available as `/skill:name` slash commands.

## Actions

### Explore

```
{ action: "explore", prompts: ["Find authentication middleware"], maxTurns: 6 }
```

### Delegate

```
{ action: "delegate", prompt: "Fix the login bug", tool: "claude", mode: "write" }
```

### MOA (Mixture-of-Agents)

```
{ action: "moa", prompts: ["Best approach for caching layer?"] }
```

## Architecture

```
┌──────────────────────────────────────────┐
│  pi-maestro-flow                         │
│                                          │
│  Extension (tools):                      │
│    maestro, maestro-wait, maestro-status  │
│                                          │
│  Skills (113):                           │
│    maestro-*, odyssey-*, quality-*,       │
│    team-*, manage-*, spec-*, learn-*      │
│                                          │
│  Agents (28):                            │
│    workflow-*, team-*, role-*             │
│                                          │
│  All dispatch via ──► pi-teammate        │
│  (spawn pi subprocess)                   │
└──────────────────────────────────────────┘
```

## License

MIT
