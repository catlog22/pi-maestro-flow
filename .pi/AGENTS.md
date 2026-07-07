# pi-maestro-flow

Maestro workflow orchestration for Pi coding agent.

## Prerequisites

- **Pi coding agent** (`pi`) — the host runtime
- **Maestro CLI** (`maestro`) — provides `search`, `load`, `delegate`, `explore` commands
- **pi-maestro-teammate** — teammate dispatch (installed automatically as dependency)

## Package Structure

```
flow/
├── src/extension/     TypeScript extension (tools: maestro, maestro-wait, maestro-status)
├── skills/            113 Pi skills (workflow commands)
├── agents/            28 agent definitions (for teammate dispatch)
├── workflows/         82 workflow reference docs (bundled from maestro)
└── templates/         23 template files (bundled from maestro)
```

## Tools Available

| Tool | Description |
|------|-------------|
| `teammate` | Dispatch tasks to teammate agents (from pi-maestro-teammate) |
| `maestro` | Main dispatch — `action: explore \| delegate \| moa` |
| `maestro-wait` | Block until background runs finish |
| `maestro-status` | Inspect active/completed runs |

## Skills Usage

All 113 skills are available as `/skill:name`. Examples:

```
/skill:maestro-analyze auth-refactor
/skill:odyssey-planex "Add caching layer" --template feature
/skill:quality-review --level deep
/skill:security-audit
```

## Workflow References

Skills reference workflow docs at:
`~/.pi/agent/packages/pi-maestro-flow/workflows/`

These are bundled in the package — no need to install maestro workflows separately.

## Maestro CLI Integration

Skills use these maestro CLI commands (require maestro installed):
- `maestro search "<query>"` — knowledge search
- `maestro load --type <type>` — load specs/knowhow
- `maestro delegate "<prompt>" --to <tool>` — delegate to external CLI
- `maestro explore "<prompt>"` — codebase exploration

## Coding Guidelines

- Follow existing code patterns — read before writing
- Minimize changes — only modify what's required
- Fix, don't hide — no `@ts-ignore`, no skipped tests
- Incremental commits — small changes that compile and pass
