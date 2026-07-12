---
description: Structured implementation with focused verification
argument-hint: "<goal> [context] [acceptance]"
---
PURPOSE: $1
TASK: Inspect existing patterns | Implement the minimal change | Verify acceptance criteria
MODE: write
CONTEXT: ${2:-@relevant files}
EXPECTED: ${3:-working implementation + focused test results}
CONSTRAINTS: Preserve existing behavior and unrelated worktree changes
