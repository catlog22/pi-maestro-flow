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

## Durable Plan Mode

Act mode exposes `plan-enter`. Entering Plan mode loads the current chat session draft and
dynamically activates the safe Plan tools:

- `plan-update` — persist complete Markdown to `current.md`
- `plan-review` — open the full-screen multiline editor without approval
- `plan-confirm` — edit and atomically approve before returning to Act mode
- `plan-exit` — leave Plan mode while preserving the draft
- `plan-status` — inspect session ID, path, revision and approval state

Plans are stored outside the project under:

```text
~/.pi/workspaces/<workspace-name>-<path-hash>/sessions/<session-id>-<id-hash>/plans/
├─ current.md
├─ manifest.json              # includes sessionId/sessionFile/sessionName
└─ approvals/<timestamp>-<revision>-<checksum>.md
```

Different chats in the same workspace have independent drafts, revisions,
approval histories and transaction locks. On upgrade, the legacy workspace-level
`plans/` directory is atomically assigned to the first chat session that opens it.

The full-screen editor supports line numbers, current-line highlighting,
multiline cursor editing, `Ctrl+S` save, `Ctrl+Enter` confirm and `Esc` cancel.
`/plan` and `Alt+P` remain available as human-facing aliases.

## Session Compaction Checkpoints

Pi compaction is extended with a Maestro recovery checkpoint that preserves the
current Todo snapshot, active Todo skill metadata, working/reference files, and
the previous checkpoint lineage. Skill source is recorded by identity and path
so the normal Todo loader can re-inject the canonical skill after compaction.

Each successful Maestro compaction also writes a non-overwriting session copy to:

```text
<project>/.workflow/knowhow/KNW-<timestamp>-session-compact-<session>-<checkpoint>.md
```

The session entry remains the machine-readable source of truth; the knowhow file
is a durable recovery and audit copy. Repeated compactions carry the prior
knowhow path forward as a reference instead of copying the full previous document.

## Codex-compatible Hooks

Project hooks use `.pi/hooks.json` as their only configuration source. The shape follows the OpenAI Codex `hooks.json` contract; an editor schema is bundled at `schemas/hooks.schema.json`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "python3 .pi/hooks/pre_tool_use.py",
            "commandWindows": "python .pi/hooks/pre_tool_use.py",
            "timeout": 30,
            "statusMessage": "Checking command"
          }
        ]
      }
    ]
  }
}
```

Command hooks receive Codex-compatible JSON on `stdin` and return JSON on `stdout`. Pi maps `SessionStart`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, and `Stop`. `PermissionRequest`, `SubagentStart`, and `SubagentStop` are accepted by the schema but reported as unmapped because Pi does not currently expose equivalent lifecycle events here.

Repository commands require review before first execution. Run `/hooks` to inspect and trust the exact config hash; run `/hooks revoke` to disable it. Any change to `.pi/hooks.json` invalidates the previous trust entry.

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
