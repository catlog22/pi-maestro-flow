---
description: Structured read-only investigation with explicit evidence
argument-hint: "<purpose> [context] [expected]"
---
PURPOSE: $1
TASK: Inspect evidence | Test hypotheses | Report the verified conclusion
MODE: analysis
CONTEXT: ${2:-@relevant files}
EXPECTED: ${3:-file:line evidence + concise conclusion}
CONSTRAINTS: Read-only; do not modify files
