# Architecture Template Library (arch-kb)

Load before a plan/design for a common product or system category. This reference does not authorize an architecture change or waive Plan approval.

`maestro arch-kb` is a prebuilt architecture template library for well-known product and system categories (URL shortener, e-commerce, AI gateway / proxy, cloud storage, collaborative document, browser extension, embedded device, AI agent platform, ...). Use it when the task maps to a common architecture category:

```bash
maestro arch-kb search "<domain keywords>" --type template
maestro arch-kb list template
maestro arch-kb show <id>
maestro arch-kb show <id> --section "<section name>"
```

Use the verbatim template section name, e.g. `关键架构决策与权衡`. Treat matched templates as governing evidence in plans and designs; reuse their locked decisions and trade-offs, and deviate only with an explicit reason. This is distinct from project knowledge (`maestro search` / `maestro load`), which holds project-specific specs and knowhow.
