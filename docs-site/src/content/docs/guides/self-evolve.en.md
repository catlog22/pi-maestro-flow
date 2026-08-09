---
title: "Self-Evolve Knowledge Automation"
icon: "✨"
---

Self-Evolve turns real Pi execution traces into **auditable, reviewable, and reversible knowledge candidates**. It observes turn and compaction boundaries, extracts reusable lessons and evidence, classifies candidate types, and applies a review gate before anything can enter the knowledge candidate pool.

> Self-Evolve is disabled by default. It never gives a model direct write access to the knowledge corpus or Skills. Even in `auto-deposit` mode, it only stages gate-passing candidates after an explicit `/self-evolve review`; **promotion is always a separate governance action and is never automatic**.

> **Version availability:** stable 0.16.0 supports dry-run candidate signals; v0.17.0, which introduced `auto-deposit`, was withdrawn. This page retains current-source auto-deposit, health, canary, and proposal contracts for review before a fixed release. Do not install v0.17.0.

---

## 1. Quick Start

Start with the default `dry-run` mode:

```text
/self-evolve on          # enable signal collection
/self-evolve status      # mode, model, budgets, output, counters

# Work for several turns or pass a session compaction boundary.
/self-evolve signals 10  # inspect recent signals
/self-evolve review 5    # review up to five actionable signals
/self-evolve reviews 5   # review history
```

This flow creates suggestions, evidence, and review records without writing to the knowledge candidate pool. Consider `auto-deposit` only after signal quality is stable.

## 2. M1-M5 Layers

Self-Evolve is a governed knowledge lifecycle, not an unconstrained “rewrite yourself” switch.

| Layer | Capability | User-visible result | Governance boundary |
|-------|------------|---------------------|---------------------|
| **M1: loop and acceptance** | codifies run check, stage, seal, review, promote, and future search | executable loop acceptance and hard gates | unsealed sources, stale receipts, and unresolved conflicts fail closed |
| **M2: thin router** | maps Self-Evolve intents to existing Maestro CLI operations | review-run, stage, health, and full-cycle flows | never writes spec/knowhow files directly |
| **M3: signals and review** | trace collection, dedup, evidence, LLM review, auto-deposit | suggestions, reviews, deposits, and TUI status | dry-run by default; auto-deposit stages but never promotes |
| **M4: knowledge health** | freshness, audit, contest, TTL, and approval aggregation | `health.json` and revalidation queue | queue generation is automatic; lifecycle actions require confirmation |
| **M5: online verification and proposals** | canary/shadow knowledge trials and Skill proposal/apply/revert | PROMOTE/ROLLBACK advice and signed proposal bundles | canary advises only; Skill changes require explicit reasons |

Most users need only the M3 `/self-evolve` command. M4-M5 are advanced maintenance flows.

## 3. Enabling and Precedence

Self-Evolve defaults to `enabled: false`.

### Session Commands

```text
/self-evolve on
/self-evolve off
```

These commands persist `.pi/self-evolve.json` in the project.

### Project Configuration

```json
{
  "enabled": true,
  "mode": "dry-run"
}
```

The file is gitignored and stores project-specific personal runtime preferences.

### Environment Override

```bash
PI_SELF_EVOLVE=1 pi
PI_SELF_EVOLVE=0 pi
```

`PI_SELF_EVOLVE` overrides the project file. Status output identifies whether the effective setting came from environment or config.

## 4. Signal Collection

When enabled, Self-Evolve observes three boundaries:

| Boundary | Behavior |
|----------|----------|
| `agent_end` | serialize transcript tail and extract assistant, tool, and file evidence |
| `session_before_compact` | retain file operations for the next compact event without cancelling compaction |
| `session_compact` | build a signal from the compaction summary and read/modified file operations |

Before writing a signal, it:

1. hashes the redacted digest with SHA-256;
2. checks an in-process LRU and recent daily files for duplicate traces;
3. applies independent cooldowns to `agent_end` and `session_compact`;
4. checks the shared `maxSignalsPerSession` budget;
5. rejects tool fragments, `grep: No matches`, plain headings, and progress narration;
6. heuristically classifies `knowhow`, `spec`, or `unknown`;
7. creates an `se-<12 hex>` id, evidence file, and executable stage template.

Signals without an actionable suggestion are marked `not-actionable` and skipped by review. **Zero candidates is a valid result.**

## 5. Dry-run and Auto-deposit

| Mode | `/self-evolve review` behavior | Stage | Promote |
|------|--------------------------------|-------|---------|
| `dry-run` (default) | review signals and append the review ledger | no | no |
| `auto-deposit` | review, then stage gate-passing signals into the pending pool | yes | **never** |

Switch modes:

```text
/self-evolve config mode=dry-run
/self-evolve config mode=auto-deposit
```

The TUI `mode` field also toggles with `Enter` or `Space`; save with `Ctrl+S`.

### Auto-deposit Requirements

A stage attempt occurs only when all conditions hold:

- the user explicitly runs `/self-evolve review [N]`;
- the verdict is `stage` at or above `reviewScoreThreshold`;
- the signal has an actionable `knowhow` or `spec` suggestion;
- its id matches `se-[0-9a-f]{12}`;
- `evidence/<signal-id>.md` exists;
- the signal belongs to the current project;
- that signal id has not already deposited successfully.

Stage runs through structured Maestro CLI argv with a 60-second hard timeout, a 1 MiB output boundary, and process-tree termination on Windows. Every success and failure is audited; failed attempts can retry after repair, while successful signal ids are deduplicated across restarts.

> Auto-deposit creates pending candidates only. Review, resolution, source sealing, fresh receipts, and promotion remain governed by the [Knowledge System](/guides/knowledge).

## 6. Review Gate

```text
/self-evolve review          # default: 5
/self-evolve review 10       # maximum: 10
/self-evolve reviews 5
```

Teammate's `analyst` returns one structured action per signal:

| Action | Meaning | Next step |
|--------|---------|-----------|
| `stage` | evidence is credible, reusable, and worth a candidate | suggestion only in dry-run; stage attempt in auto-deposit |
| `skip` | noise, duplicate, or insufficient value | no candidate |
| `uncertain` | insufficient evidence or novelty | no automatic stage |

The gate drops hallucinated verdict ids, downgrades low-score `stage` verdicts, skips non-actionable signals, and fails closed when model/runtime output is unavailable. Review uses a 60-second attempt timeout and a 120-second overall deadline.

The model inherits the main session by default:

```text
/self-evolve config model=provider/model-id
/self-evolve config model=auto
```

An explicit model must be available in the current model registry.

## 7. Command Reference

| Command | Purpose |
|---------|---------|
| `/self-evolve` / `panel` | open the editable TUI panel |
| `/self-evolve status` | effective state, mode, model, budgets, counters, output |
| `/self-evolve on` / `off` | enable or disable signal collection |
| `/self-evolve config` | show full configuration |
| `/self-evolve config <k>=<v> ...` | atomically validate and save one or more values |
| `/self-evolve config reset` | restore defaults while preserving `enabled` |
| `/self-evolve signals [N]` | list recent signals with date/project filters |
| `/self-evolve signals delete <id-prefix...>` | delete matching signal records |
| `/self-evolve signals clear` | clear signal records from suggestion daily files |
| `/self-evolve signals export ...` | export filtered signal JSONL |
| `/self-evolve review [N]` | review actionable signals and optionally auto-deposit |
| `/self-evolve reviews [N]` | show review history |
| `/self-evolve deposits [N]` | show successful and failed stage attempts |

Filter examples:

```text
/self-evolve signals 20 --since 2026-08-01 --until 2026-08-09
/self-evolve signals --project pi-maestro-flow
/self-evolve signals export --project pi-maestro-flow
```

Deleting signals does not remove knowledge that has already been staged or promoted.

## 8. TUI and Status Bar

Run bare `/self-evolve` to open the panel.

| Key | Action |
|-----|--------|
| `↑` / `↓` | select a config field |
| `Enter` | edit; toggle `enabled` or `mode` |
| `Space` | toggle `enabled` or `mode` |
| `Ctrl+S` | validate and persist `.pi/self-evolve.json` |
| `r` | reload from disk; dirty changes require confirmation |
| `q` / `Esc` | close; dirty changes require discard confirmation |

The panel shows source, resolved model, suggestion path, counters, and up to eight recent signals. Below 20 columns it collapses to a single status line.

```text
EVOL ● <signals>·<deduped>·<suppressed>·<deposits>D !<failures>
```

Disabled state is `EVOL off`; empty deposit/failure segments are omitted.

## 9. Configuration Reference

Default `.pi/self-evolve.json` values:

```json
{
  "enabled": false,
  "mode": "dry-run",
  "cooldownMs": 300000,
  "maxSignalsPerSession": 20,
  "maxTraceChars": 8000,
  "maxTraceMessages": 12,
  "maxEvidence": 8,
  "maxFiles": 14,
  "reviewScoreThreshold": 0.6,
  "maxReviewFiles": 28
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `false` | master switch |
| `mode` | `dry-run` | `dry-run` or `auto-deposit` |
| `model` | `auto` | Phase 2B review model, `provider/model` |
| `cooldownMs` | `300000` | per-source interval; accepts `5m`, `30s`, `1.5h` |
| `maxSignalsPerSession` | `20` | shared signal budget for turn and compact sources |
| `maxTraceChars` | `8000` | digest character cap |
| `maxTraceMessages` | `12` | transcript tail message cap |
| `maxEvidence` | `8` | evidence references per candidate |
| `maxFiles` | `14` | retained suggestion daily files; older files archive |
| `reviewScoreThreshold` | `0.6` | lower `stage` scores become `uncertain` |
| `maxReviewFiles` | `28` | retained review daily files; older files archive |

`cooldownMs` may be zero; count/capacity fields are positive integers and scores are in `[0,1]`. Multi-key updates are all-or-nothing.

| Environment variable | Purpose |
|----------------------|---------|
| `PI_SELF_EVOLVE` | override `enabled` |
| `SELF_EVOLVE_OUTPUT_DIR` | global output root; use an absolute path |
| `SELF_EVOLVE_SKILL` | record an active Skill-layer hint for aggregation |

## 10. Data and Permissions

Default global root:

```text
~/.maestro/self-evolve/
├── suggestions/<date>.jsonl
├── evidence/<se-id>.md
├── reviews/<date>.jsonl
├── deposits/<date>.jsonl
├── archive/
├── exports/
├── approvals/<date>.jsonl
├── canaries/
├── proposals/
├── health.json
└── health-<project>.json
```

Directories use `0700` and files use `0600`. Signals reuse Advisor redaction before persistence, but credentials should never be placed in task output or custom prompts. The global root aggregates projects, so use `--project` filters when inspecting or exporting.

## 11. Candidate to Promoted Knowledge

```text
execution trace
  → signal + evidence
  → analyst review gate
  → pending candidate (auto-deposit only)
  → knowledge review / resolve
  → sealed source + fresh receipt
  → user-confirmed promote
  → future maestro search/load
```

Before promotion, the Agent reads `maestro knowledge review <session-id> --json` and presents title, content summary, evidence, existing matches, and recommended disposition. The user decides unique / duplicate / related / conflict / supersede; the Agent executes promotion with a non-empty reason.

Record an approval receipt after a successful governance action:

```bash
node scripts/self-evolve-approval.mjs record \
  --action promote --session <session-id> \
  --candidates <candidate-id> --reason "<why>"
node scripts/self-evolve-approval.mjs query --session <session-id> --json
node scripts/self-evolve-approval.mjs reconcile
```

These are Agent/maintainer CLI operations, not `/self-evolve` subcommands.

## 12. Knowledge Health

```bash
node scripts/self-evolve-health.mjs
```

The rebuildable sidecar combines spec freshness and lineage, knowledge audit findings, validated/contradicted/cited signals, stale review-required candidates, candidate TTL, cross-run title groups, review quality, and approval gaps into `health.json`, a project twin, and a prioritized revalidation queue.

```bash
node scripts/self-evolve-health.mjs mark <item-id> --action reviewed
node scripts/self-evolve-health.mjs unmark <item-id>
```

Health generates facts and recommendations only. It never executes supersede, deprecate, conflict marking, or pruning.

## 13. Canary and Skill Proposals

### High-Impact Knowledge Canary

```bash
node scripts/self-evolve-phase5.mjs canary <knowledge-id> --window 3
node scripts/self-evolve-phase5.mjs list --type canary
```

The first call starts shadow observation; later calls consume a new health snapshot. A project-matching health snapshot newer than 24 hours is required. Incremental validation/citation produces PROMOTE advice; contradiction or window expiry produces ROLLBACK advice. **The script does not mutate the corpus.**

### Skill Proposal

```bash
node scripts/self-evolve-phase5.mjs proposal <skill-path> \
  --content <new-skill-file> --reason "<why>"
node scripts/self-evolve-phase5.mjs list --type proposal
node scripts/self-evolve-phase5.mjs apply <proposal-id> --reason "<approval>"
node scripts/self-evolve-phase5.mjs revert <proposal-id> --reason "<why>" [--force]
```

A proposal includes the original SHA-256, diff, `allowed-tools` permission delta, frontmatter/tag checks, and a signature. Failed post-apply validation restores the backup. Revert detects conflicts against the snapshot and requires explicit `--force` to overwrite a changed target.

Apply, revert, and global-knowledge actions require an explicit user request or confirmed governance step.

## 14. Troubleshooting

### No Signals

1. run `/self-evolve status` and confirm effective state is on;
2. check whether `PI_SELF_EVOLVE=0` overrides the project file;
3. cross an `agent_end` or `session_compact` boundary;
4. inspect cooldown, session budget, deduped, and suppressed counters;
5. ordinary progress narration may be filtered by design.

### Review Model Unavailable

```text
/self-evolve config model=provider/model-id
```

Confirm authentication, model registry availability, and `pi-maestro-teammate` installation. Review fails closed and never stages after a model failure.

### Auto-deposit Created No Candidate

```text
/self-evolve config
/self-evolve reviews 5
/self-evolve deposits 10
```

Check mode, verdict/score, project identity, evidence file, signal id, and deposit error. Skip, uncertain, cross-project, and already-deposited signals do not stage.

### Configuration Appears Ignored

Environment overrides project config. Panel edits require `Ctrl+S`; `r` reloads disk state and asks before discarding dirty changes.

### Output Write Failure

Use a writable absolute `SELF_EVOLVE_OUTPUT_DIR`. Path escape, oversized CLI output, and deposit timeout fail closed and appear in status or deposit history.

## 15. Known Boundaries

- Candidate type classification is heuristic, not a governance conclusion.
- The cross-run health index is advisory; this extension does not provide upstream transactional cross-run staging.
- Canary depends on refreshed health snapshots and is not a live listener.
- Full knowledge text is not automatically injected; future runs discover promoted entries through `maestro search`, then consume them with `maestro load`.
- Promoted spec content has no general snapshot rollback; use a corrected superseding entry.
- Raw logs, tool traces, and non-reusable run narration should never be retained merely to increase candidate volume.

## 16. Related Guides

- [Knowledge System](/guides/knowledge) — stage, review, resolve, promote, and the knowledge gate
- [Architecture & Concepts](/guides/architecture) — Self-Evolve runtime placement
- [Advisor Turn-Level Supervision](/guides/advisor) — shared redaction and supervised evaluation
- [Monitor Cross-Session Supervision](/guides/monitor) — stall and drift supervision for peer windows
- [Changelog](/guides/changelog) — auto-deposit and v0.17.0 changes
