# pi-maestro-flow

> Maestro workflow orchestration for [Pi](https://github.com/earendil-works/pi) — tools, workflows, and templates

Pi extension providing Maestro's workflow tools. Built on [pi-maestro-teammate](../pi-maestro-teammate/) for the execution engine. Skills and agents live in project-level `.pi/` directory (see root README).

## Contents

| Resource | Count | Description |
|----------|-------|-------------|
| **Extension tools** | 3 | `maestro`, `maestro-wait`, `maestro-status` |
| **Workflow docs** | 82 | Bundled reference documentation |
| **Templates** | 23 | Bundled template files |

Skills (113) and agents (29) are in the project root `.pi/` directory, not in this package.

## Prerequisites

- **Pi coding agent** — the host runtime
- **Maestro CLI** — `maestro search`, `maestro load`, `maestro delegate`, `maestro explore`
- **pi-maestro-teammate** — peer dependency (optional)

## Install

```bash
# From npm
pi install npm:pi-maestro-flow

# Or from local path (development)
pi install ./packages/pi-maestro-flow
```

After installation:
- 3 tools available: `maestro`, `maestro-wait`, `maestro-status`
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
│  pi-maestro-flow (extension package)     │
│                                          │
│  Extension tools:                        │
│    maestro / maestro-wait / maestro-status│
│                                          │
│  Bundled assets:                         │
│    Workflows (82) + Templates (23)       │
│                                          │
│  Dispatch via ──► pi-maestro-teammate    │
└──────────────────────────────────────────┘

Skills (113) and agents (29) are in .pi/ at project root.
```

## License

MIT
