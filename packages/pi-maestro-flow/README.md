# pi-maestro-flow

> Maestro workflow orchestration for [Pi](https://github.com/earendil-works/pi) — tools, skills, workflows, and agent definitions

Pi extension providing Maestro's full workflow toolkit. Built on [pi-teammate](../pi-teammate/) for the execution engine.

## Contents

| Resource | Count | Description |
|----------|-------|-------------|
| **Extension tools** | 3 | `maestro`, `maestro-wait`, `maestro-status` |
| **Skills** | 113 | All maestro commands + skills as `/skill:name` |
| **Agent definitions** | 28 | For teammate dispatch |
| **Workflow docs** | 82 | Bundled reference documentation |
| **Templates** | 23 | Bundled template files |

## Prerequisites

- **Pi coding agent** — the host runtime
- **Maestro CLI** — `maestro search`, `maestro load`, `maestro delegate`, `maestro explore`
- **pi-maestro-teammate** — installed automatically as dependency

## Install

```bash
# From npm (installs pi-maestro-teammate automatically)
pi install npm:pi-maestro-flow

# Or from local path
pi install ./flow
```

After installation:
- 3 tools available: `maestro`, `maestro-wait`, `maestro-status`
- 113 skills available as `/skill:name` slash commands
- 28 agent definitions for teammate dispatch
- 82 workflow docs bundled at `~/.pi/agent/packages/pi-maestro-flow/workflows/`

## Skills Categories

**Workflow orchestration:** `maestro-analyze`, `maestro-plan`, `maestro-execute`, `maestro-ralph-v2`, `maestro-roadmap`

**Quality & review:** `quality-review`, `quality-test`, `quality-refactor`, `security-audit`

**Odyssey workflows:** `odyssey-planex`, `odyssey-debug`, `odyssey-review-test-fix`, `odyssey-ui`

**Team orchestration:** `team-coordinator`, `team-executor`, `team-frontend`, `team-quality-assurance`

**Knowledge management:** `spec-add`, `spec-load`, `manage-knowhow-capture`, `manage-knowledge-audit`

**Academic writing:** `scholar-writing`, `scholar-review`, `scholar-experiment`, `scholar-thesis-docx`

## Tool Actions

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
│  Extension:                              │
│    maestro / maestro-wait / maestro-status│
│                                          │
│  Skills (113):                           │
│    maestro-* / odyssey-* / quality-*     │
│    team-* / manage-* / spec-* / learn-*  │
│    scholar-* / skill-*                   │
│                                          │
│  Agents (28):                            │
│    workflow-* / team-* / role-*          │
│                                          │
│  Workflows (82) + Templates (23):        │
│    Bundled reference docs                │
│                                          │
│  Dispatch via ──► pi-maestro-teammate    │
└──────────────────────────────────────────┘
```

## License

MIT
