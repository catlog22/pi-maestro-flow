# Search Tools

## Semantic Search Tool

@~/.maestro/templates/search-tool.json

## Priority

```
maestro explore (structured) → Semantic Search → Grep (pattern) → Glob (files)
```

## Tool Selection

| Scenario | Tool |
|----------|------|
| Multi-angle codebase scan | `maestro explore` with multi-prompt parallel |
| Targeted code search (known scope) | `maestro explore` single prompt with FIND/SCOPE |
| Find by intent/behavior | Semantic search tool (see above) |
| Known identifier/regex | `Grep` |
| Find files by name/ext | `Glob` |
| Deep cross-file reasoning | `maestro delegate --role analyze --mode analysis` |
| Read identified file | `Read` |

## maestro explore Prompt Format

```
FIND: [what to search for]
SCOPE: [file patterns or directories]
EXCLUDE: [what to skip]
ATTENTION: [caveats, edge cases]
EXPECTED: [output format]
```

Single prompt: `maestro explore "FIND: ... SCOPE: src/" --max-turns 3`

Multi-prompt parallel: `maestro explore "prompt1" "prompt2" --json`

## Fallback

- **explore unavailable** → Semantic search + Grep + Glob pattern scanning
- **Semantic search unavailable** → Grep + Glob; log degraded mode
- **Grep insufficient** → Escalate to CLI delegate analysis

## Combined Strategy

For thorough exploration: maestro explore (broad) → Grep (validate specific) → Read (deep examine)
