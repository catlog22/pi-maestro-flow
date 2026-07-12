# Maestro for Pi

- **Coding Philosophy**: @~/.maestro/workflows/coding-philosophy.md

## Tool Boundaries

Follow this routing order:

1. `maestro search` + `maestro load` — load existing project knowledge before code access.
2. `teammate` with `agent: "explorer"` — locate files, definitions, call sites, patterns, and evidence read-only.
3. `teammate` — replace legacy delegate work for deep analysis, planning, implementation, review, and testing.
4. Local `rg` / targeted reads — verify single-hit explorer results or act as fallback when teammate exploration is unavailable.

Do not call `maestro delegate` or `maestro explore`. Do not use the `maestro` tool as a second agent-dispatch surface when `teammate` can express the task directly.

## Teammate

Use Pi's `teammate` tool directly for delegated work; the legacy delegate path is not part of Pi guidance.

The system prompt includes an `<available_teammate_models>` catalog at session start. Use an exact `provider/model` identifier from that catalog.

### Automatic Model Routing

Teammate recognizes `explore`, `analysis`, `debug`, `planning`, `development`, `review`, and `testing` task types.

Open the Pi model-routing overlay with `Alt+M` or `/teammate-models`. It lists models authenticated for the current session and saves project mappings to `.pi/teammate-models.json`. Global defaults may be defined in `~/.pi/agent/teammate-models.json`; project mappings override global mappings.

Model precedence is task-level `model` → top-level `model` → explicit `taskType` mapping → inferred task type → agent default. Prefer an explicit `taskType` for stable routing. Omit `model` when routing should choose the configured model; use an exact `provider/model` only for a deliberate override.

### Prompt Template

Preserve this prompt structure when dispatching teammate work:

```text
PURPOSE: [goal] + [success criteria]
TASK: [step 1] | [step 2] | [step 3]
MODE: analysis|write
CONTEXT: @[file patterns] | Memory: [prior work]
EXPECTED: [output format]
CONSTRAINTS: [scope limits]
```

`MODE` is mandatory. In `analysis` mode, the teammate MUST remain read-only. Put an optional workflow or review protocol in the task as `RULE: [rule name or requirements]` without changing the remaining field order.

### Invocation Style

Single task:

```text
teammate({
  agent: "delegate",
  taskType: "analysis",
  task: "PURPOSE: Analyze authentication + identify the verified control flow\nTASK: Trace entry | Trace validation | Summarize evidence\nMODE: analysis\nCONTEXT: @src/auth/**/*.ts | Memory: none\nEXPECTED: file:line evidence + conclusion\nCONSTRAINTS: Read-only; do not modify files",
  model: "provider/model",
  background: false
})
```

Single delegated work defaults to foreground blocking. The tool call returns only after the teammate completes, so the next step can consume its result directly without a separate wait tool.

Parallel tasks preserve the same prompt shape inside every task:

```text
teammate({
  taskType: "explore",
  background: false,
  tasks: [
    {
      name: "definitions",
      agent: "explorer",
      task: "PURPOSE: Locate definitions + produce authoritative anchors\nTASK: Find exports | Find schemas\nMODE: analysis\nCONTEXT: @src/**/*.ts\nEXPECTED: file:line list\nCONSTRAINTS: Read-only"
    },
    {
      name: "calls",
      agent: "explorer",
      task: "PURPOSE: Locate consumers + map usage\nTASK: Find imports | Find calls\nMODE: analysis\nCONTEXT: @src/**/*.ts\nEXPECTED: file:line list\nCONSTRAINTS: Read-only"
    }
  ]
})
```

Fixed prompt templates use Pi-compatible positional arguments. Templates are discovered from project `.pi/prompts/*.md`, user `~/.pi/agent/prompts/*.md`, then bundled teammate `prompts/*.md`; higher-priority names override lower-priority names. `task` becomes `$1`, and `promptArgs` begin at `$2`.

### Available Fixed Prompts

The following bundled templates are always callable by exact name through the `prompt` field.

Analysis templates:

- `analysis-trace-code-execution`
- `analysis-diagnose-bug-root-cause`
- `analysis-analyze-code-patterns`
- `analysis-analyze-technical-document`
- `analysis-review-architecture`
- `analysis-review-code-quality`
- `analysis-analyze-performance`
- `analysis-assess-security-risks`

Planning templates:

- `planning-plan-architecture-design`
- `planning-breakdown-task-steps`
- `planning-design-component-spec`
- `planning-plan-migration-strategy`

Development templates:

- `development-implement-feature`
- `development-refactor-codebase`
- `development-generate-tests`
- `development-implement-component-ui`
- `development-debug-runtime-issues`

The compact compatibility templates remain available:

| Template | Mode | Arguments | Use |
|----------|------|-----------|-----|
| `analysis` | `analysis` | `$1` purpose, `$2` context, `$3` expected output | Read-only investigation with evidence and a verified conclusion |
| `review` | `analysis` | `$1` review target, `$2` extra constraints | Correctness, security, testing, and maintainability review |
| `write` | `write` | `$1` implementation goal, `$2` context, `$3` acceptance output | Minimal implementation followed by focused verification |

Project and user templates are also callable by filename without `.md`. For example, `.pi/prompts/security-audit.md` is invoked with `prompt: "security-audit"`. The available prompt catalog is included in the `teammate` tool description; use the exact discovered name.

Canonical Analysis call:

```text
teammate({ agent: "delegate", taskType: "analysis", prompt: "analysis-trace-code-execution", task: "Trace the authentication request", promptArgs: ["@src/auth/**/*.ts", "Return file:line evidence"], background: false })
```

Canonical Planning call:

```text
teammate({ agent: "delegate", taskType: "planning", prompt: "planning-plan-migration-strategy", task: "Plan the auth-token migration", promptArgs: ["@src/auth/**/*.ts", "Include compatibility and rollback stages"], background: false })
```

Canonical Development call:

```text
teammate({ agent: "delegate", taskType: "development", prompt: "development-implement-feature", task: "Implement token validation", promptArgs: ["@src/auth/**/*.ts", "Implementation plus focused tests"], background: false })
```

### Execution Rules

- Use `background: false` for a single delegated task when its result is required by the next step. This is the default compatibility behavior for the former foreground `maestro delegate` workflow.
- Use `background: true` only for independent parallel work, deliberately detached long-running work, or work that can complete after the current turn.
- A foreground teammate call is already blocking and needs no separate wait step.
- Background teammate completion sends a `teammate-complete` notification with `triggerTurn: true`. Stop issuing dependent calls until that notification arrives.
- A task-level `model` overrides the top-level model default.
- Name tasks that need follow-up or downstream references. Use `{name}` or `{name.field}` to create DAG dependencies.
- Use `context: "fork"` only when the teammate needs the current conversation history; otherwise use fresh context.
- Use `teammate-list` or `teammate-watch` only when current status or output is required.
- Use `teammate-send` with `follow_up` for normal continuation, `steer` for urgent correction, and `abort` only to terminate work.
- Preserve the original prompt fields when sending follow-up work; do not collapse a structured request into a vague sentence.
- Prefer a named fixed `prompt` when the same structured protocol is reused; keep one-off details in `task` and `promptArgs`.

## Explore with Teammate

Use `teammate` with `agent: "explorer"` for read-only file discovery and code search. It takes priority over Glob, Grep, `rg`, and direct file reads. Run the Knowledge Gate first, dispatch the explorer, and wait for its result.

```text
teammate({
  agent: "explorer",
  taskType: "explore",
  task: "FIND: <target + condition>\nSCOPE: <paths>\nEXPECTED: <output shape>",
  background: false
})
```

One task maps to one explorer. The configured `explore` model is selected automatically when `model` is omitted. Use the other task types for deep analysis, debugging, planning, implementation, review, or testing.

### Context Injection

Fresh explorer agents have no implicit project knowledge. Inject relevant context before dispatch:

| Context | Field | Requirement |
|---------|-------|-------------|
| Structure | `SCOPE` | Name concrete relevant directories or files; do not use unrestricted scans |
| Domain | `SCOPE` | Include key paths returned by `maestro search` |
| Constraints | `ATTENTION` | State framework, language, naming conventions, and known traps |

```text
FIND: Authentication middleware that validates JWT tokens.
SCOPE: src/middleware/, src/auth/, src/api/routes/
ATTENTION: Express.js; middleware files use the *.middleware.ts naming convention.
EXPECTED: file:line list with a concise control-flow summary.
```

### Prompt Structure

`FIND` and `SCOPE` are mandatory. Write one declarative sentence per field and avoid nested conditional requests.

| Field | Required | Rule |
|-------|----------|------|
| `FIND` | Yes | A concrete, decidable target: what to find and the condition it must satisfy |
| `SCOPE` | Yes | Explicit paths or bounded globs; never use unrestricted `**/*` |
| `EXCLUDE` | No | Directories or file types to skip |
| `ATTENTION` | No | Framework, conventions, or known pitfalls |
| `EXPECTED` | Recommended | Required output such as `file:line`, summary, or JSON |

```text
FIND: Functions that call db.query() using string concatenation instead of positional parameters.
SCOPE: src/db/**/*.ts, src/api/**/*.ts
EXCLUDE: **/*.test.ts
EXPECTED: file:line list including the SQL expression.
```

### Cross-Search

For important searches, run 2-3 explorer tasks from different analytical angles. Split by viewpoint, not by keyword:

| Angle | Task A | Task B |
|-------|--------|--------|
| Definition vs usage | Find exported definitions | Find imports and call sites |
| Positive vs missing | Find correct implementations | Find places missing the convention |
| Entry vs implementation | Find routes or exports | Find internal logic |
| File type | Find TypeScript usage | Find UI/template usage |

```text
teammate({
  taskType: "explore",
  background: false,
  tasks: [
    {
      name: "definitions",
      agent: "explorer",
      task: "FIND: All functions exported from the auth module.\nSCOPE: src/auth/\nEXPECTED: function name + file:line"
    },
    {
      name: "calls",
      agent: "explorer",
      task: "FIND: All imports from the auth module.\nSCOPE: src/**/*.ts\nEXCLUDE: src/auth/\nEXPECTED: import path + file:line"
    }
  ]
})
```

Confidence rules:

- Two matching angles: high confidence; use the result.
- One matching angle: verify with local `rg` or a targeted read.
- Zero matches: change the angle and search again, or conclude the target does not exist with stated evidence.

### Execution

- Single lookup: use `background: false` and consume the result directly.
- Multiple independent angles: put explorer tasks in one `tasks` call; they execute concurrently while the foreground call waits for all results.
- Detached exploration: use `background: true`; completion sends `teammate-complete` and triggers a new turn.
- Use `teammate-list` and `teammate-watch` only for background status or output inspection.
- Stop and wait for explorer output before issuing dependent reads or edits.

If teammate exploration is unavailable or fails, switch to local `rg`, targeted reads, and focused runtime checks. Record the degradation instead of repeatedly retrying the same failure.

## Knowledge System

### Mandatory Gate

Run `maestro search` and `maestro load` before reading code, dispatching an explorer, dispatching another teammate, or editing files.

```bash
maestro search "<query>" [--type <type>] [--category <category>] [--code] [--kg]
maestro load --type <type> [--list] [--category <category>] [--keyword <word>] [--id <id>]
```

Types: `spec`, `knowhow`, `domain`, `issue`, `session`, `scratch`, `note`, `project`, `roadmap`.

Spec categories: `coding`, `arch`, `debug`, `test`, `review`, `learning`, `ui`.

### Query Rules

- Use 1-3 core keywords per query; multiple short queries are better than a keyword dump.
- Separate concepts from code symbols.
- Add `--code` for symbols and implementation anchors.
- Add `--kg` when full-source knowledge-graph context is required.

```bash
# Avoid
maestro search "topology display frontend DetailedTopologySVG elk"

# Prefer
maestro search "topology layout"
maestro search "DetailedTopologySVG" --code
maestro load --type spec --category coding
```

Feed the key files, constraints, and prior decisions returned by the knowledge system into `SCOPE`, `ATTENTION`, teammate `CONTEXT`, and teammate `Memory` fields.

### Record Confirmed Knowledge

| Knowledge | Command |
|-----------|---------|
| Spec | `/spec-add <category> "title" "content" --keywords kw1,kw2 --description "summary"` |
| Knowhow | `/manage-knowhow-capture` with optional `--spec-category <category>` |

Category routing:

- Decisions and architectural constraints → `arch`.
- Reusable implementation patterns → `coding`.
- Pitfalls and failure modes → `debug` or `learning`.
- Review rules → `review`.
- Verification conventions → `test`.

Only persist knowledge when the task or user asks for durable capture, or when the active workflow explicitly requires it.

### Supersession and Conflict

Use separate mechanisms for evolution and disagreement:

| Relationship | Situation | Command | Result |
|--------------|-----------|---------|--------|
| `supersede` | A new rule replaces an old rule | `maestro spec supersede <old-sid> --by <new-sid>` | Old entry becomes `deprecated`; history is preserved |
| `conflict` | Both rules remain plausible and need human resolution | `maestro spec conflict mark <file> <line> --note "<reason>"` | Entry becomes `contested`, remains searchable with reduced weight |

```bash
maestro spec add coding "New rule" "Content" --keywords kw1,kw2 --json
maestro spec supersede <old-sid> --by <new-sid>
maestro spec history <sid>

maestro spec conflict mark <file> <line> --note "<reason>"
```

Keep confidence, lifecycle status, and time decay as separate dimensions. Resolve contested knowledge through `/manage-knowledge-audit`.

### Health and Maintenance

```bash
maestro spec health
maestro spec backfill-sid
maestro spec history <sid>
maestro search "<query>" --include-deprecated
```

## Execution

- Required sequence: Knowledge Gate → teammate explorer → targeted verification → teammate execution or local edit → focused tests.
- Inspect existing patterns and dirty-worktree changes before editing.
- Preserve backward compatibility and existing user changes unless the request explicitly replaces them.
- Use the project's build and test commands. Add focused tests for changed behavior.
- Keep edits small, explicit, and limited to the requested scope.
