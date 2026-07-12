# pi-maestro-flow

> Maestro workflow orchestration for [Pi](https://github.com/earendil-works/pi) — tools, workflows, and templates

Pi extension providing Maestro's workflow tools. Built on [pi-maestro-teammate](../pi-maestro-teammate/) for the execution engine. Skills and agents live in project-level `.pi/` directory (see root README).

## Contents

| Resource | Count | Description |
|----------|-------|-------------|
| **Maestro tool** | 1 | `maestro` |
| **Workflow docs** | 82 | Installed from `maestro-flow` to `~/.maestro/workflows` |
| **Templates** | 23 | Bundled template files |

Skills (113) and agents (29) are in the project root `.pi/` directory, not in this package.

## Prerequisites

- **Pi coding agent** — the host runtime
- **Maestro CLI** — `maestro search` and `maestro load` for the project knowledge system
- **pi-maestro-teammate** — exploration, analysis, planning, development, review, and testing dispatch
- **pi-maestro-teammate** — peer dependency (optional)

## Install

```bash
# From npm
pi install npm:pi-maestro-flow

# Or from local path (development)
pi install ./packages/pi-maestro-flow
```

After installation:
- Maestro dispatch is available through the single `maestro` tool
- Maestro workflow docs installed at `~/.maestro/workflows/`

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

### Approval-mode shortcut

Maestro Flow registers `Shift+Tab` to cycle the hook approval mode in this order:

```text
default -> acceptEdits -> plan -> dontAsk -> bypassPermissions -> default
```

Pi uses `Shift+Tab` for effort/thinking-level cycling by default, and that action is a
reserved host binding. During `npm install`, Maestro Flow creates or merges
`~/.pi/agent/keybindings.json` so the original effort shortcut moves to `Shift+E`:

```json
{
  "app.thinking.cycle": "shift+e"
}
```

The installer preserves all other shortcuts. If the existing file is invalid JSON, it
is left unchanged and npm prints a warning. Run `/reload` after installation when Pi is
already open. Pi then releases `Shift+Tab`, allowing the
extension shortcut to handle approval-mode cycling. `plan` activates Maestro's
durable Plan mode; the other values are forwarded as `permission_mode` to Codex-style
hooks and do not create an operating-system sandbox or additional Pi tool isolation.

The statusline follows the effective approval mode. Wide terminals show labels such as
`ACT · APPROVAL acceptEdits`; medium and narrow terminals progressively compact this to
`ACT/acceptEdits` and `A/E`. Active or ready Plan mode always renders approval as `plan`,
regardless of whether it was entered through `Shift+Tab`, `Alt+P`, or `/plan`.

### Statusline fonts

Pi renders terminal text and ANSI styles; the terminal emulator controls the font
family. Configure the desired font in Windows Terminal, WezTerm, Kitty, iTerm2, or the
host terminal rather than in Maestro Flow. Set `MAESTRO_NERD_FONT=1` before starting Pi
to use the statusline's Nerd Font icon set. Without it, Maestro Flow uses portable
Unicode symbols. Bold and dim ANSI styling are supported when the terminal implements
them, but a single statusline cannot select a different font family from the rest of
the terminal.

## Session Compaction Checkpoints

Pi compaction is extended with a Maestro recovery checkpoint that preserves the
current Todo snapshot, active Todo skill metadata, working/reference files, and
the previous checkpoint lineage. Skill source is recorded by identity and path
so the normal Todo loader can re-inject the canonical skill after compaction.

## Project skills and teammate agents

The npm package does not declare a duplicate package-level routing skill. Project
skills under `.pi/skills/` are the primary Pi skill source; in this repository the
canonical set lives at `D:\pi-maestro-flow\.pi\skills`. Install the package through
`pi install npm:pi-maestro-flow` (or register a local package path) for the extension,
workflow documents, templates, and associated runtime resources.

`pi-maestro-flow` also pins `maestro-flow@0.5.49` as an associated runtime package.
During postinstall it calls Maestro's workflows-only installer, which writes the canonical
workflow documents to `~/.maestro/workflows`. Pi project skills continue to reference that
default path. Releases predating the dedicated command use the same package workflows as a
compatibility fallback. On session startup, the extension also contributes the installed
package's `.agents/skills` directory through Pi's `resources_discover` event.

Agent definitions are not a native Pi package resource type and must not be declared
as `pi.agents`. They are owned by `pi-maestro-teammate`, which discovers Markdown
agent definitions in this priority order:

1. nearest project `.pi/agents/*.md`
2. `~/.pi/agent/extensions/teammate/agents/*.md`
3. the `agents/*.md` directory bundled inside the installed `pi-maestro-teammate` package

Project and user definitions override lower-priority agents with the same frontmatter
`name`. Each file requires `name` and `description`; its Markdown body becomes the
agent system prompt.

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
│    maestro                               │
│                                          │
│  Runtime assets:                         │
│    Maestro workflows + Templates (23)    │
│                                          │
│  Dispatch via ──► pi-maestro-teammate    │
└──────────────────────────────────────────┘

Skills (113) and agents (29) are in .pi/ at project root.
```

## License

MIT
