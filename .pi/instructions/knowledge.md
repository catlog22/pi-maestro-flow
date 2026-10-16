# Knowledge Operations

Load before knowledge capture, attribution writes, staging, adjudication, publication, corpus maintenance, or a Workflow Run's knowledge handling. SYSTEM.md owns the pre-discovery search/load gate; this reference owns the operation-specific protocol.

```bash
maestro search "<query>" [--type <type>] [--category <category>] [--tag <tag>] [--keyword <word>] [--code] [--kg]
maestro load --type <type> [--list] [--category <category>] [--tag <tag>] [--keyword <word>] [--id <id>]
```

Knowledge types: `spec`, `knowhow`, `domain`, `issue`, `session`, `scratch`, `note`, `project`, `roadmap`. Spec categories: `coding`, `arch`, `debug`, `test`, `review`, `learning`, `ui`; route decisions to `arch`, patterns to `coding`, pitfalls to `debug`/`learning`, rules to `review`, and tests to `test`.

### Window evidence staging (K12-K17)

- Back a knowledge candidate with the current window's raw record via `/maestro-knowledge-from-window <spec|knowhow> <title> <content>` (Pi) or `maestro knowledge stage ... --transcript-quote <descriptor.json>` (CLI). The raw quote is stored as **untrusted snapshot evidence only** — it never enters candidate content, review stdout, corpus, or search (iron rule 10); review renders only a `[untrusted]` state. Never copy quote text into candidate content or any prompt context.
- Transcript-only candidates are auto-gated to `review_required` (K17): `promote --all` skips them. Promote explicitly with `maestro knowledge promote <session-id> --resolve <candidate-id> --as unique --reason "<human review>"` after review. Never bypass the gate by editing evidence refs.

### Know-how capture

`maestro-knowhow` captures reusable knowledge in `.workflow/knowhow/`. Automatically load and follow it when the user explicitly asks for “知识沉淀”, “沉淀经验”, “记录模板”, “记录决策”, or “存个技巧”; use `maestro-spec` instead for explicit project constraints, rules, conventions, or quality standards.

Query discipline and association follow-through belong to SYSTEM.md's Project Knowledge Gate. The relevant association commands are `maestro wiki backlinks <id>`, `maestro wiki forward <id>`, and `maestro spec history <sid>`.

### Search and load attribution

`maestro search` is **exposure only** — it never proves the Run/Session used an entry. Turn hits into evidence explicitly:

- `maestro load --id <id>` records `consumed` via three-tier routing: unique active Run, then an unambiguous Session identity (host lease / single live channel), else the global usage ledger with a warning — attribution never blocks loading.
- `maestro knowledge record <ids...> --signal consumed|cited|validated|contradicted --source search|load|manual [--run <run-id> | --session <session-id> | --channel <name>]` records **pure attribution** (no candidate staged) on the resolved Run or Session ledger; `--source search` is the retrieval-attribution spelling. Write authority resolves by tiers: explicit run/session args > explicit or environment channel (`--channel`/`MAESTRO_CHANNEL`) > host lease > single live hook channel > narrowed scan > synthetic session; ambiguity fails closed and lists live channels. Use `knowledge stage --signal` only when a candidate is intended. IDs are validated against the wiki index; unknown IDs are rejected unless `--allow-unknown` (which records a degraded marker).
- `maestro knowledge review <session-id> --json` reports per-source totals (`input_totals_by_source`) and knowledge-id detail (`inputs`) so you can verify what was searched, loaded, and staged.

## Run Knowledge

Runtime birth packets are authoritative for Run-specific commands and state; read them via `run-control { argv: ["run","brief","<run-id>"] }` / `{ argv: ["run","check","<run-id>"] }`.

- Record accepted decisions and locked constraints in `report.md` frontmatter.
- Attribute search hits before citing them via `maestro knowledge record` (full command under "Search and load attribution"); it records pure ledger attribution without staging a candidate.
- Stage reusable recipes or pitfalls before completion. Write candidate content to a temp file and pass `--content-file <path|->` (or stdin `-`) — never inline as a positional argument: content with spaces, quotes, unicode, newlines, or leading dashes misparses and shifts later arguments.

```bash
maestro knowledge stage spec|knowhow "<title>" --content-file <path|-> --run <run-id> [--category <category>]
maestro knowledge stage spec|knowhow "<title>" --content-file <path|-> --session <session-id> --evidence <file:line,...>
```

- Add `--signal cited|validated|contradicted --signal-ids <comma-separated ids>` when relating a candidate to existing knowledge; space-separated `--signal-ids` values leak into positional arguments.
- Run completion stages pending candidates; it does not promote them.
- Completion messages summarize attribution and staged candidates; use current runtime receipts and `maestro knowledge review <session-id> --json` for the actual backlog, not re-extraction of completed artifacts.
- **Knowledge closeout**: at terminal task/Session closeout, the completion owner follows `@~/.maestro/ref/knowledge-closeout.md`. If not expanded or no longer in context, Read @~/.maestro/ref/knowledge-closeout.md explicitly before closeout. Intermediate Runs continue the confirmed chain; workers return candidate IDs/warnings without repeating approval questions. **The user only decides; the agent reads, presents, asks, executes, and verifies — never hand raw review/promote commands back to the user as the entire task.**
- Present candidate IDs/content/evidence/matches and recommendations, obtain human decisions through `ask-user-question` or verify matching prior explicit authorization, then execute fixed approved IDs via `promote --candidate`; confirmed adjudication plus any resulting publication uses `promote --resolve` (deprecated `review --resolve` is the relationship-only compatibility fallback). Importance, `-y`, machine recommendations, `accepted` decisions, and `locked` constraints are not publication approval. Read execution results and re-read review; material content/evidence/relationship changes require renewed confirmation. Zero candidates, rejection, deferral, or no question tool/no matching authorization leave backlog intact and do not block otherwise valid completion.
- Work through the `run check` finish checklist and record intentional concerns.
- Read-only review/presentation is part of owner closeout, not a separate user shell task. Resolution, promotion, supersession, conflict marking, and pruning require an explicit user request, matching prior human authorization, or a confirmed governance step. A review-only request never implies publication or receipt-write authority.
- Promote only eligible candidates with fresh reconciliation: run-source requires every source Run sealed; canonical `session/3.0` session-source requires immutable candidate/evidence snapshots, non-empty stage evidence, and a fresh session receipt revalidated at final commit — not Session completion. Only repair missing/stale receipts with `maestro knowledge review <session-id> --refresh --json` within caller authority; blocked evidence is not repaired by blind refresh. Deprecated or superseded knowledge remains auditable but is excluded from normal search and injection.
- Outside a Run, governed staging still works: without `--run/--session`, write authority falls back through identity tiers and, with nothing running, idempotently creates a daily-partitioned synthetic knowledge Session (`ksyn-*`). Direct writes to project spec/knowhow still require an explicit knowledge-management request; prefer `--channel <name>` when multiple concurrent sessions share one workspace.
- **Fast path for standalone insights (outside any Run)**: `maestro knowhow add --type <tip|recipe|template|reference|decision|session> --title "<title>" --body-file <path>` writes `.workflow/knowhow/` directly — no Session, no `--evidence`, no review/promote cycle. Use it for standalone insights (tips, recipes, decisions) that do not belong to any Run's outcome; reserve `stage → review → promote` for candidates needing adjudication against the corpus. Routine Run completion still must not call `knowhow add` directly (Run-internal knowledge routes through `stage --run`).
- **Direct-write whitelist** (corpus writes bypassing stage→review→promote, only for explicit knowledge management): `maestro spec add`, `maestro spec supersede <old-sid> --by <new-sid>`, `maestro spec conflict mark`, `maestro knowhow add`, `maestro domain add`, and the knowhow/wiki maintenance commands. `maestro knowhow add` doubles as the fast path above for standalone Run-less insights. Content-producing workflows (retrospective, wiki-digest, wiki-connect, maestro-learn, ui-codify-knowhow, harvest, finish-work) MUST route through that stage→review→promote path — never direct `.workflow/specs/` or `.workflow/knowhow/` writes.
- **Knowledge auto-deposition (self-evolve T1)**: at seal, `accepted` decisions / `locked` constraints in report.md frontmatter are automatically staged as candidates — do not manually re-stage the same facts. **Write quality gate (anti-noise)**: frontmatter must contain only reusable prescriptive decisions/constraints (rules future work must follow); **never** write operational-state narration into decisions/constraints — read-only declarations, worktree/audit-process observations, missing-file records, routing memos (e.g. "Read-only audit; preserve the existing dirty worktree", "Debug investigation remained read-only") — seal auto-drafts every accepted/locked entry into a corpus candidate, and state narration directly pollutes the knowledge base.
- **Staging Quality Bar (what is worth depositing)**: stage only content that future work can directly reuse, avoiding re-paid learning cost, and that satisfies at least one of: ① pitfall warning ("when doing X, watch out for Y because Z" — non-obvious failure mode + prevention); ② failure lesson (what failed, root cause, which alternative worked); ③ non-trivial trade-off (why A over B, constraints and context); ④ newly established prescriptive constraint (spec). **Do NOT stage**: process notes ("did X", "produced doc Y" — those belong in report.md body/commits/README); restatements of existing project patterns (code/config is already the best documentation); trivial self-evident operations; raw traces (tool output, log/error snippet copies) — traces must first be semantically distilled into lessons; if no reusable lesson can be extracted, discard them. **Zero candidates is a legitimate outcome** — never fabricate candidates to prove the pipeline's value. Explicit self-evolve T2 batch requests retain their own confirmed governance scope and existing eligibility/fresh-receipt gates; they are not the default for ordinary Session closeout, which selects fixed approved IDs. Repair missing/stale receipts within authority, not unconditionally before each promotion; record self-evolve approval receipts only when that explicitly requested workflow requires them.
- **Self-evolve entry points**: see `.pi/skills/self-evolve` (orchestration), `scripts/self-evolve-health.mjs` (health sidecar), `scripts/self-evolve-phase5.mjs` (canary verification).
- Commands emitted by current runtime receipts override static examples.
