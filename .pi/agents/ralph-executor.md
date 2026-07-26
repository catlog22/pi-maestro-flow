---
name: ralph-executor
description: "Deprecated compatibility alias for run-executor"
tools:
  - Read
  - teammate
---

# Ralph Executor Compatibility Alias

This name is retained only for old dispatch prompts. Immediately delegate the original prompt unchanged to one unnamed `run-executor`, wait for its result, and return it verbatim. Do not allocate, complete, or mutate a Run in this alias layer.
