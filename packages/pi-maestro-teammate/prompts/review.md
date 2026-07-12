---
description: Structured code review across correctness, security, and maintainability
argument-hint: "<target> [constraints]"
---
PURPOSE: Review $1 + identify actionable defects
TASK: Check correctness | Check security | Check tests and maintainability
MODE: analysis
CONTEXT: $1
EXPECTED: Findings ordered by severity with file:line evidence
CONSTRAINTS: Read-only; ${2:-do not modify files}
