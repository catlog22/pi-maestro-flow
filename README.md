# pi-maestro-flow

<p align="center">
  <strong>Multi-Agent Orchestration for Pi Coding Agent</strong><br />
  Knowledge Systems · Teammate Dispatch · 104 Skills · 29 Agents · DAG Task Graphs
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-maestro-flow"><img alt="npm: pi-maestro-flow" src="https://img.shields.io/npm/v/pi-maestro-flow?color=cb3837&logo=npm&logoColor=white&label=pi-maestro-flow" /></a>
  <a href="https://www.npmjs.com/package/pi-maestro-teammate"><img alt="npm: pi-maestro-teammate" src="https://img.shields.io/npm/v/pi-maestro-teammate?color=cb3837&logo=npm&logoColor=white&label=pi-maestro-teammate" /></a>
  <a href="https://github.com/catlog22/pi-maestro-flow"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-catlog22%2Fpi--maestro--flow-blue?logo=github" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

---

## Overview

**pi-maestro-flow** is the complete multi-agent orchestration layer for [Pi Coding Agent](https://github.com/earendil-works/pi). It ports the intent-driven [Maestro-Flow](https://github.com/catlog22/maestro-flow) framework into Pi's native extension and skill ecosystem, giving you:

- **Teammate Dispatch** — spawn parallel subprocess agents with DAG task graphs, RPC messaging, and structured prompt templates
- **Knowledge System** — semantic search, spec management, knowhow capture, and conflict/supersession lifecycle
- **104 Skills** — orchestration, quality, UI design, team coordination, academic writing, and more
- **29 Agent Roles** — explorer, reviewer, planner, debugger, verifier, and specialized workflow agents
- **20 Fixed Prompt Templates** — structured analysis, planning, development, review, and write protocols

> ⚠️ pi-maestro-flow is designed for **advanced agent-driven development**. If you want simple single-agent coding, Pi's built-in tools are all you need. If you want parallel exploration, structured delegation, team coordination, long-running cycles, and knowledge persistence — read on.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Pi Coding Agent                             │
│  (interactive / print / JSON / RPC / SDK modes)                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐    ┌─────────────────────────────┐    │
│  │  pi-maestro-flow      │    │  pi-maestro-teammate         │    │
│  │  (Extension Package)  │◄──►│  (Core Dispatch Engine)      │    │
│  │                       │    │                              │    │
│  │  • maestro tool       │    │  • teammate tool             │    │
│  │  • maestro-wait       │    │  • DAG task graphs           │    │
│  │  • maestro-status     │    │  • RPC subprocess messaging  │    │
│  │  • explore/delegate/  │    │  • P0 three-axis control     │    │
│  │    moa actions        │    │    (name × reply_to ×        │    │
│  │                       │    │     lifecycle)               │    │
│  └──────────┬───────────┘    └──────────────┬──────────────┘    │
│             │                               │                    │
│  ┌──────────▼───────────────────────────────▼──────────────┐    │
│  │                    Project Resources                      │    │
│  │                                                           │    │
│  │  .pi/skills/          .pi/agents/       .pi/prompts/     │    │
│  │  (104 skills)         (29 agent defs)   (user templates)  │    │
│  │                                                           │    │
│  │  Built-in in packages/:  agents/ + prompts/               │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Two Packages, One System

| Package | npm | Role |
|---------|-----|------|
| **pi-maestro-teammate** | [`pi-maestro-teammate`](https://www.npmjs.com/package/pi-maestro-teammate) | Core dispatch engine — `teammate` tool, RPC subprocess model, DAG graphs, TUI widgets |
| **pi-maestro-flow** | [`pi-maestro-flow`](https://www.npmjs.com/package/pi-maestro-flow) | Maestro tools (`explore` / `delegate` / `moa`), 104 skills, knowledge system bridge |

---

## Quick Start

### Prerequisites

- **Node.js** ≥ 22.19.0
- **[Pi Coding Agent](https://github.com/earendil-works/pi)** installed globally
- **[Maestro CLI](https://github.com/catlog22/maestro2)** installed globally (required for `maestro search` and `maestro load`)

### Installation

```bash
# Install both packages (pi-maestro-teammate auto-installed as dependency)
pi install npm:pi-maestro-flow

# Verify installation
pi list    # Should show both packages
```

### First Session

```bash
pi                        # Start Pi in interactive mode
```

Pi now loads the full pi-maestro-flow extension system on startup. Type `/skill:maestro-help` to explore available commands, or just describe what you want in natural language — pi will route to the right skill.

---

## Core Tools

### `teammate` — Multi-Agent Dispatch

The heart of the system. Spawn independent Pi subprocesses as agents, each with their own tools and context. Supports single, parallel, DAG, and background execution modes.

**Single task (foreground, block until complete):**

```javascript
teammate({
  agent: "delegate",
  taskType: "analysis",
  task: "PURPOSE: Analyze authentication flow for security gaps\nTASK: Trace entry points | Trace validation | Summarize findings\nMODE: analysis\nCONTEXT: @src/auth/**/*.ts\nEXPECTED: file:line evidence + conclusion\nCONSTRAINTS: Read-only",
  model: "deepseek/deepseek-v4-pro",
  background: false
})
```

**Parallel tasks with DAG dependencies:**

```javascript
teammate({
  taskType: "explore",
  background: false,
  tasks: [
    {
      name: "definitions",
      agent: "explorer",
      task: "FIND: All exported auth functions\nSCOPE: src/auth/\nEXPECTED: function name + file:line"
    },
    {
      name: "consumers",
      agent: "explorer",
      task: "FIND: All call sites importing from auth module\nSCOPE: src/**/*.ts\nEXCLUDE: src/auth/\nEXPECTED: import path + file:line"
    },
    {
      name: "report",
      agent: "delegate",
      task: "PURPOSE: Synthesize exploration results\nTASK: Merge {definitions} with {consumers} | Report overlap and gaps\nMODE: analysis\nEXPECTED: structured reconciliation report"
    }
  ]
})
```

**Fixed prompt templates:**

```javascript
teammate({
  agent: "delegate",
  taskType: "analysis",
  prompt: "analysis-trace-code-execution",
  task: "Trace the token refresh flow",
  promptArgs: ["@src/auth/", "Return file:line evidence"],
  background: false
})
```

#### P0 Three-Axis Control

Every teammate dispatch can be precisely controlled:

| Axis | Options | Purpose |
|------|---------|---------|
| `name` | any string | Addressable name for `teammate-send` follow-up and `{name}` DAG references |
| `reply_to` | `"caller"` / `"main"` | Controls where `agent_end` result is delivered |
| `lifecycle` | `"ephemeral"` / `"resident"` | Ephemeral: process exits on completion. Resident: process sleeps, awaits `teammate-send` |

#### Context Modes

| Mode | Behavior |
|------|----------|
| `context: "fresh"` (default) | Clean subprocess — only system prompt + task |
| `context: "fork"` | Inherits full parent session history, continues independently |

#### Execution Modes

| Mode | When to Use |
|------|-------------|
| `background: false` | Result needed by next step — call blocks until agent completes |
| `background: true` | Independent parallel work, detachable long-running tasks |

#### Teammate Control

```javascript
// List active agents
teammate-list({ view: "all" })

// Inspect a running agent
teammate-watch({ name: "my-agent", lines: 30 })

// Send follow-up to a named, running agent
teammate-send({ to: "my-agent", message: "Please also check edge cases", mode: "follow_up" })

// Urgent course correction
teammate-send({ to: "my-agent", message: "Stop current approach, try alternative", mode: "steer" })

// Terminate
teammate-send({ to: "my-agent", mode: "abort" })
```

### `maestro` — Knowledge-Aware Dispatch

#### explore — Parallel Code Search

```javascript
maestro({
  action: "explore",
  prompts: [
    "FIND: All middleware that validates JWT tokens\nSCOPE: src/middleware/\nATTENTION: Express.js, *.middleware.ts convention\nEXPECTED: file:line + control-flow summary",
    "FIND: All call sites that call auth.login()\nSCOPE: src/**/*.ts\nEXCLUDE: **/*.test.ts\nEXPECTED: file:line list",
    "FIND: Schema definitions for User and Session types\nSCOPE: src/models/, src/types/\nEXPECTED: file:line + field list"
  ],
  concurrency: 3,
  maxTurns: 6
})
```

#### delegate — Task Delegation to External Tools

```javascript
maestro({
  action: "delegate",
  prompt: "PURPOSE: Implement password reset flow\nTASK: Create route | Add email service | Write tests\nMODE: write\nCONTEXT: @src/auth/ @src/email/\nEXPECTED: Implementation + passing tests",
  tool: "claude",
  mode: "write",
  rule: "development-implement-feature"
})
```

#### moa — Mixture-of-Agents Synthesis

```javascript
maestro({
  action: "moa",
  prompts: ["Analyze the payment flow from security and architecture perspectives"],
  preset: "deep"
})
// Runs analysis across multiple models, then synthesizes into a unified report
```

---

## Skills (104 Total)

Skills are on-demand capability packages loaded via `/skill:name` or auto-loaded by the agent. Organized by functional domain:

### Orchestration & Lifecycle (~25 skills)

| Skill | Description |
|-------|-------------|
| `maestro` | Auto-route intent to optimal command chain |
| `maestro-analyze` | Structured multi-dimensional investigation before planning |
| `maestro-plan` | Create, revise, or verify execution plans |
| `maestro-execute` | Execute a confirmed plan |
| `maestro-roadmap` | Generate roadmap with milestone/phase structure |
| `maestro-blueprint` | Generate formal spec package (Product Brief, PRD, Architecture, Epics) |
| `maestro-ralph-v2` | Adaptive lifecycle orchestrator — compose, dispatch, evaluate, loop |
| `maestro-brainstorm` | Multi-perspective analysis of ideas/approaches |
| `maestro-grill` | Stress-test plans/ideas against codebase reality |
| `maestro-collab` | Cross-verification from multiple CLI tools/perspectives |
| `maestro-quick` | Quick task execution, skip optional agents |
| `maestro-init` | Initialize project with auto state detection |
| `maestro-fork` | Create/sync milestone worktree for parallel dev |
| `maestro-merge` | Merge milestone worktree branch back to main |
| `maestro-milestone-*` | Audit, complete, and release milestones |

### Quality & Testing (~12 skills)

| Skill | Description |
|-------|-------------|
| `quality-review` | Multi-dimensional code evaluation (correctness, security, perf, architecture) |
| `quality-test` | User acceptance testing with interactive gap closure |
| `quality-auto-test` | Automated test coverage expansion |
| `quality-debug` | Systematic root cause investigation |
| `quality-refactor` | Systematic tech debt identification and safe reduction |
| `quality-retrospective` | Extract lessons/patterns after phase completion |
| `quality-sync` | Sync codebase docs by tracing git diff impact |
| `security-audit` | OWASP Top 10 + STRIDE security auditing with supply chain analysis |
| `team-review` | 3-role code review pipeline: scanner → reviewer → fixer |
| `team-testing` | Progressive test coverage via Generator-Critic loops |
| `team-quality-assurance` | Full closed-loop QA (issue discovery + testing) |

### UI / Design (~10 skills)

| Skill | Description |
|-------|-------------|
| `maestro-impeccable` | Design, audit, polish frontend UI |
| `maestro-ui-codify` | Extract design system from code, generate reference package |
| `team-frontend` | Unified frontend development with ui-ux-pro-max intelligence |
| `team-frontend-debug` | Frontend debugging via Chrome DevTools MCP |
| `team-uidesign` | UI design team: research → tokens → audit → implementation |
| `team-ui-polish` | Auto-discover/fix UI issues using Impeccable standards |
| `team-motion-design` | Animation token systems, scroll choreography, GPU transforms |
| `team-visual-a11y` | Visual accessibility QA (OKLCH contrast, WCAG AA/AAA) |
| `team-ux-improve` | Discover/fix UI/UX interaction issues |
| `team-interactive-craft` | Vanilla JS+CSS interactive components (zero dependencies) |

### Long-Running Cycles (Odyssey — 5 skills)

| Skill | Description |
|-------|-------------|
| `odyssey-planex` | Requirement-driven iterative plan→execute→verify→fix loop |
| `odyssey-debug` | Long-running debug cycle (archaeology→diagnosis→fix→generalize) |
| `odyssey-improve` | Long-running codebase improvement cycle |
| `odyssey-review-test-fix` | Deep review + fix cycle |
| `odyssey-ui` | Long-running UI optimization cycle |

### Team Coordination (~15 skills)

| Skill | Description |
|-------|-------------|
| `team-coordinate` | Universal team coordination with dynamic role generation |
| `team-lifecycle-v4` | Full lifecycle: plan, develop, test, review |
| `team-roadmap-dev` | Roadmap-driven development workflow |
| `team-planex` | Plan-and-execute pipeline |
| `team-brainstorm` | Unified brainstorming team |
| `team-arch-opt` | Architecture optimization |
| `team-perf-opt` | Performance optimization (single/fan-out/parallel modes) |
| `team-tech-debt` | Tech debt identification and remediation |
| `team-swarm` | ACO-driven swarm intelligence with hybrid LLM + Python controller |
| `team-adversarial-swarm` | ACO swarm with adversarial decision gates |
| `team-ultra-analyze` | Deep collaborative multi-role investigation |

### Knowledge Management (~18 skills)

| Skill | Description |
|-------|-------------|
| `spec-add` / `spec-load` / `spec-remove` | Spec entry management with role tagging |
| `spec-setup` | Initialize specs from project structure |
| `manage-knowhow` / `manage-knowhow-capture` | Knowhow entry management and capture |
| `manage-knowledge-audit` | Audit/prune knowledge across stores |
| `manage-wiki` | Wiki graph: health, cleanup, search, stats |
| `manage-harvest` | Extract knowledge from artifacts into wiki/spec/issues |
| `manage-codebase-rebuild` | Rebuild all codebase documentation from scratch |
| `manage-drift-realign` | Detect and realign .workflow/ artifact drift |
| `manage-status` | Show project dashboard with progress and next steps |
| `manage-issue` / `manage-issue-discover` | Issue tracking and multi-perspective discovery |
| `manage-kg-extractors` | Generate custom symbol extractors for knowledge graph |
| `codify-to-knowhow` | Manifest-driven knowledge asset generator |
| `domain-add` | Register domain term into project glossary |

### Academic Writing (Scholar — 10 skills)

| Skill | Description |
|-------|-------------|
| `scholar-ideation` | Research ideation (literature → gap analysis → planning) |
| `scholar-writing` | End-to-end academic paper writing for top ML/AI conferences |
| `scholar-review` | Systematic paper review (self-review + rebuttal) |
| `scholar-rebuttal-pro` | Enhanced rebuttal with collaborative analysis |
| `scholar-experiment` | Experimental results analysis for ML/AI papers |
| `scholar-citation-verify` | Four-layer citation verification |
| `scholar-anti-ai-writing` | Remove AI writing patterns from academic prose |
| `scholar-latex-organizer` | Clean up LaTeX templates for Overleaf |
| `scholar-publish` | Post-acceptance conference preparation |
| `scholar-thesis-docx` | Create/revise thesis Word documents |

### Meta / Tooling (~9 skills)

| Skill | Description |
|-------|-------------|
| `prompt-generator` | Generate/convert prompt files with GSD-style quality gates |
| `skill-generator` | Meta-skill for creating new skills |
| `skill-iter-tune` | Iterative skill tuning (execute→evaluate→improve) |
| `skill-simplify` | SKILL.md simplification with integrity verification |
| `skill-tuning` | Universal skill diagnosis and optimization |
| `workflow-skill-designer` | Meta-skill for designing orchestrator+phases workflow skills |
| `maestro-composer` | Compose reusable workflow templates from natural language |
| `maestro-overlay` | Create/edit command overlays from natural language |
| `maestro-player` | Play workflow templates with checkpoint resume |
| `maestro-amend` | Generate overlays to fix workflow command deficiencies |
| `maestro-guard` | Manage editing boundary restrictions |
| `maestro-help` | Command help system |
| `delegation-check` | Check workflow delegation prompts for content separation violations |
| `insight-challenge` | Adversarial review of code quality findings |

### Learning (~5 skills)

| Skill | Description |
|-------|-------------|
| `learn-investigate` | Hypothesis-driven investigation with evidence logging |
| `learn-follow` | Guided reading of code/wiki to extract patterns |
| `learn-decompose` | Extract design patterns from code into specs/wiki |
| `learn-second-opinion` | Get alternative perspectives (review, challenge, consult) |

---

## Agent Roles (29 Total)

Each agent is a specialized subprocess configuration with a distinct system prompt and tool set:

### Core Agents

| Agent | Purpose |
|-------|---------|
| **explorer** | Fast, read-only codebase reconnaissance for parallel search |
| **delegate** | General-purpose agent for delegated analysis or implementation |
| **coordinator** | Multi-step task coordination with DAG variable referencing |
| **goal-verifier** | Independent verifier that audits goal completion claims |
| **ralph-executor** | Single-step executor for maestro orchestration pipelines |

### Workflow Agents

| Agent | Purpose |
|-------|---------|
| **workflow-analyzer** | Multi-dimensional evaluation with evidence-based scoring |
| **workflow-codebase-mapper** | Analyzes codebase from a specific focus area |
| **workflow-debugger** | Hypothesis-driven debugging with structured evidence logging |
| **workflow-executor** | Implements single tasks with verification and commit discipline |
| **workflow-planner** | Creates execution plans with task decomposition, waves, and dependencies |
| **workflow-plan-checker** | Validates plan quality with up to 3 revision rounds |
| **workflow-reviewer** | Multi-dimensional code review (single dimension per agent) |
| **workflow-verifier** | Goal-backward verification across three layers (existence, substance, connection) |
| **workflow-collab-planner** | Collaborative planner with pre-allocated task ID ranges |
| **workflow-external-researcher** | External research via Exa MCP for API/tech evaluation |
| **workflow-integration-checker** | Cross-phase integration validation for milestone audits |
| **workflow-nyquist-auditor** | Test coverage audit with gap detection and test stub generation |
| **workflow-phase-researcher** | Researches implementation approach for a specific roadmap phase |
| **workflow-project-researcher** | Domain research for project initialization |
| **workflow-research-synthesizer** | Merges multiple researcher outputs into unified summary |
| **workflow-roadmapper** | Creates project roadmap with phased milestones |

### Specialist Agents

| Agent | Purpose |
|-------|---------|
| **team-supervisor** | Resident pipeline supervisor for quality observation |
| **team-worker** | Unified worker agent executing role-specific logic from role_spec files |
| **ui-design-agent** | UI design token management and prototype generation (WCAG AA validated) |
| **impeccable-agent** | Autonomous UI audit, polish, harden, layout, typeset executor |
| **role-design-author** | Generates multi-file role analysis for brainstorm sessions |
| **cross-role-reviewer** | Compares Decision Digests across role analysis files for conflicts/gaps |
| **cli-explore-agent** | Read-only code exploration via Bash + CLI semantic dual-source analysis |
| **aggregator** (MOA) | Synthesizes multiple reference analyses into unified output |
| **reference** (MOA) | Independent analysis from a single model perspective |

---

## Knowledge System

The knowledge system ensures agents work with full project context before touching code.

### Mandatory Knowledge Gate

```bash
# Search across specs, knowhow, domain terms, issues, sessions
maestro search "<query>" [--type spec|knowhow|domain|issue] [--code] [--kg]

# Load specific knowledge before making decisions
maestro load --type <type> [--list] [--category <cat>] [--keyword <word>] [--id <id>]
```

**Query rules:**
- Use 1-3 core keywords per query
- Separate concepts from code symbols
- Add `--code` for symbols and implementation anchors
- Add `--kg` for full-source knowledge-graph context

### Knowledge Lifecycle

| Action | Command |
|--------|---------|
| Add spec | `/spec-add <category> "title" "content" --keywords kw1,kw2` |
| Add knowhow | `/manage-knowhow-capture` |
| Mark superseded | `maestro spec supersede <old-sid> --by <new-sid>` |
| Mark conflict | `maestro spec conflict mark <file> <line> --note "<reason>"` |
| Audit health | `maestro spec health` |
| View history | `maestro spec history <sid>` |

### Knowledge Types

| Type | Category | Purpose |
|------|----------|---------|
| `spec` | `arch`, `coding`, `debug`, `test`, `review`, `learning`, `ui` | Reusable conventions and rules |
| `knowhow` | `compact`, `tip` | Task-specific patterns and recipes |
| `domain` | — | Project glossary terms |
| `issue` | — | Tracked bugs and tasks |
| `roadmap` | — | Milestone and phase planning |

---

## Fixed Prompt Templates (20 Built-in)

Callable via the `prompt` field in `teammate` dispatch. Templates are discovered from project `.pi/prompts/`, user `~/.pi/agent/prompts/`, and the bundled catalog.

### Analysis Templates

| Template | Purpose |
|----------|---------|
| `analysis-trace-code-execution` | Trace execution, control flow, data movement |
| `analysis-diagnose-bug-root-cause` | Diagnose bugs and propose read-only corrections |
| `analysis-analyze-code-patterns` | Analyze implementation patterns, conventions, anti-patterns |
| `analysis-analyze-technical-document` | Analyze technical docs with evidence-backed references |
| `analysis-review-architecture` | Review architecture, dependencies, integration points, trade-offs |
| `analysis-review-code-quality` | Review correctness, maintainability, and testing |
| `analysis-analyze-performance` | Analyze bottlenecks and optimization opportunities |
| `analysis-assess-security-risks` | Assess attack surfaces and prioritized mitigations |

### Planning Templates

| Template | Purpose |
|----------|---------|
| `planning-plan-architecture-design` | Structured software architecture design plan |
| `planning-breakdown-task-steps` | Break requirements into executable, verifiable task steps |
| `planning-design-component-spec` | Component specification with interfaces and acceptance criteria |
| `planning-plan-migration-strategy` | Staged migration with compatibility and rollback |

### Development Templates

| Template | Purpose |
|----------|---------|
| `development-implement-feature` | Implement feature following existing patterns |
| `development-refactor-codebase` | Refactor safely while preserving behavior |
| `development-generate-tests` | Generate tests that close concrete coverage gaps |
| `development-implement-component-ui` | Reusable accessible UI component with tests |
| `development-debug-runtime-issues` | Reproduce, diagnose, fix, and regression-test runtime issues |

### Compact Compatibility Templates

| Template | Mode | Arguments |
|----------|------|-----------|
| `analysis` | analysis | purpose, context, expected output |
| `review` | analysis | review target, extra constraints |
| `write` | write | implementation goal, context, acceptance output |

---

## Explorer Protocol

The explorer agent is your primary code discovery tool — use it before any implementation, refactoring, or debugging.

### Structured Prompt Format

```
FIND: <concrete, decidable target + condition>
SCOPE: <explicit paths or bounded globs>
EXCLUDE: <directories or file types to skip>
ATTENTION: <framework, conventions, known pitfalls>
EXPECTED: <required output format>
```

`FIND` and `SCOPE` are mandatory. Write one declarative sentence per field.

### Cross-Search for Confidence

Run 2-3 explorer tasks from different analytical angles:

| Angle | Task A | Task B |
|-------|--------|--------|
| Definition vs usage | Find exported definitions | Find imports and call sites |
| Positive vs missing | Find correct implementations | Find places missing the convention |
| Entry vs implementation | Find routes or exports | Find internal logic |
| File type | Find TypeScript usage | Find UI/template usage |

**Confidence rules:**
- Two matching angles → high confidence, use result
- One matching angle → verify with local `rg` or targeted read
- Zero matches → change angle or conclude target does not exist

### Execution Pipeline

1. **Knowledge Gate** — `maestro search` + `maestro load`
2. **Explorer** — parallel read-only code search
3. **Targeted verification** — local `rg` or reads for single-match cases
4. **Execution** — teammate or local edit with focused tests

---

## Prompt Template Format

When writing teammate tasks, use this structured format:

```
PURPOSE: [goal] + [success criteria]
TASK: [step 1] | [step 2] | [step 3]
MODE: analysis|write
CONTEXT: @[file patterns] | Memory: [prior work]
EXPECTED: [output format]
CONSTRAINTS: [scope limits]
```

`MODE` is mandatory. In `analysis` mode, the agent MUST remain read-only. Optionally add `RULE: [rule name]` for workflow or review protocols.

---

## Automatic Model Routing

Teammate maps tasks to models automatically based on task type:

| Task Type | Auto-mapped To |
|-----------|---------------|
| `explore` | Explorer-configured model |
| `analysis` | Analysis-configured model |
| `debug` | Debug-configured model |
| `planning` | Planning-configured model |
| `development` | Development-configured model |
| `review` | Review-configured model |
| `testing` | Testing-configured model |

Model precedence: task-level `model` → top-level `model` → explicit `taskType` mapping → inferred task type → agent default.

Open the model-routing overlay with `Alt+M` or `/teammate-models` to configure project-level mappings, stored in `.pi/teammate-models.json`.

---

## Project Structure

```
pi-maestro-flow/
├── .pi/
│   ├── skills/              # 104 skills (project-level, loaded by Pi)
│   ├── agents/              # 29 agent definitions (teammate discoverAgents)
│   └── AGENTS.md            # Architecture and tool documentation
├── packages/
│   ├── pi-maestro-teammate/ # Core teammate dispatch engine
│   │   ├── src/
│   │   │   ├── extension/   # index.ts (tools), schemas.ts
│   │   │   ├── runs/        # execution.ts (RPC subprocess lifecycle)
│   │   │   ├── tui/         # render.ts, attach-overlay.ts
│   │   │   └── shared/      # types.ts
│   │   ├── agents/          # Built-in agent definitions
│   │   └── prompts/         # Built-in prompt templates
│   └── pi-maestro-flow/     # Maestro tools + orchestration
│       ├── src/
│       ├── schemas/         # Task, agent, and state JSON schemas
│       └── templates/       # Workflow and project templates
└── docs/                    # Development guides
    ├── pi-extension-authoring-guide.md
    └── rpiv-plugin-implementation-strategy.md
```

---

## Subprocess Model

```
[Pi Main Session]
  └── teammate tool call
       ├── context: "fresh" (default)
       │    └── spawn: pi --mode rpc
       │         (Clean process — only system prompt + task)
       │
       └── context: "fork"
            └── spawn: pi --mode rpc --fork <parent-session>
                 (Inherits full conversation, continues independently)

[Agent Subprocess]
  ├── stdin:  RPC JSON lines (prompt | steer | follow_up | abort)
  ├── stdout: JSON line events (agent_start → message → tool_call → agent_end)
  ├── IPC:    teammate_proxy_request/result (child ↔ root tool calls)
  └── Lifecycle:
       agent_end → resolve Promise → sleeping (process stays alive)
       teammate-send follow_up → new turn → agent_end → sleeping → ...
       teammate-send abort → kill process → completed
```

---

## Common Workflows

### Codebase Exploration

```
1. /skill:maestro-analyze    → Structured multi-dimensional analysis
2. teammate (explorer × 3)   → Parallel code search from 3 angles
3. Targeted reads/edits      → Based on high-confidence results from ≥2 matching explorers
```

### Feature Implementation

```
1. maestro search + load     → Knowledge Gate
2. /skill:maestro-plan       → Create execution plan
3. /skill:maestro-execute    → Execute plan with verification at each step
4. /skill:quality-review     → Post-implementation review
5. /skill:quality-test       → Acceptance testing with gap closure
```

### Debugging

```
1. /skill:odyssey-debug      → Full debug cycle: archaeology → diagnosis → fix → generalize
2. /skill:quality-test       → Verify fix with smoke tests
```

### Team Collaboration

```
1. /skill:team-coordinate    → Dynamic team generation for complex tasks
2. /skill:team-lifecycle-v4  → Full plan → develop → test → review cycle
3. /skill:team-review        → 3-role structured code review
```

### Knowledge Management

```
1. /skill:manage-knowhow-capture  → Capture patterns as reusable knowledge
2. /skill:spec-add                → Add conventions and rules
3. /skill:manage-knowledge-audit  → Periodic audit and pruning
```

---

## Configuration

### Project-Level

| File | Purpose |
|------|---------|
| `.pi/teammate-models.json` | Model routing mappings for this project |
| `.pi/prompts/` | Project-specific prompt templates |
| `.pi/settings.json` | Pi settings overrides |

### Global

| File | Purpose |
|------|---------|
| `~/.pi/agent/teammate-models.json` | Global model routing defaults |
| `~/.pi/agent/prompts/` | User-level prompt templates |
| `~/.pi/agent/settings.json` | Global Pi settings |

---

## Requirements

| Component | Version | Required |
|-----------|---------|----------|
| Node.js | ≥ 22.19.0 | Yes |
| Pi Coding Agent | ≥ 0.80.3 (teammate) / ≥ 0.74.0 (flow) | Yes |
| Maestro CLI | ≥ 1.0.0 | For search/load features |

---

## Credits

Built on top of:

- **[Maestro-Flow](https://github.com/catlog22/maestro-flow)** — intent-driven multi-agent workflow orchestration framework by [@catlog22](https://github.com/catlog22)
- **[Pi Coding Agent](https://github.com/earendil-works/pi)** — minimal terminal coding harness by [@earendil-works](https://github.com/earendil-works)
- **Pi Extension patterns** — inspired by [pi-subagents](https://github.com/nicobailon/pi-subagents), [pi-extensions](https://github.com/narumiruna/pi-extensions), and [rpiv-mono](https://github.com/juicesharp/rpiv-mono)

---

## License

[MIT](LICENSE) © 2026 catlog22
