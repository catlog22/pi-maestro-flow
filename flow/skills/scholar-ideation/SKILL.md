---
name: scholar-ideation
description: "Research ideation workflow from literature search to research planning. Triggers on \"brainstorm research ideas\", \"identify research gaps\", \"conduct gap analysis\", \"start research project\", \"conduct literature review\", \"define research question\", \"select research method\", \"plan research\", \"research ideation\"."
allowed-tools: WebSearch WebFetch Read Write Edit Bash Glob Grep maestro
disable-model-invocation: true
session-mode: none
---

# Scholar Ideation

Supports the complete research project initiation workflow: from literature search and gap analysis through research question formulation, method selection, and research planning. Produces a structured research plan with literature review, identified gaps, formulated questions, selected methods, and a timeline.

## Pre-load (before execution)

1. **Codebase docs**: If `.workflow/codebase/ARCHITECTURE.md` exists, read for project context
2. **Specs**: `maestro load --type spec --category coding` — load coding conventions
3. **Wiki knowledge**: `maestro search "academic writing research paper" --json` — top 5 entries as prior context
4. All optional — proceed without if unavailable

## Architecture Overview

```
User Input (research topic/interest)
        |
        v
┌─────────────────────────────────────────────────────────────┐
│  SKILL.md Orchestrator                                       │
│  Collect preferences → Dispatch phases → Track progress      │
└──────────┬──────────────────────────────────────────────────┘
           |
   ┌───────┼───────┬───────────┬───────────┬───────────┐
   v       v       v           v           v           v
┌──────┐┌──────┐┌──────┐┌──────────┐┌──────────┐┌──────────┐
│Input ││Phase1││Phase2││  Phase3  ││  Phase4  ││  Phase5  │
│Parse ││LitSrc││GapAnl││  RQ Form ││  Method  ││  Plan    │
└──────┘└──────┘└──────┘└──────────┘└──────────┘└──────────┘
   |       |       |         |           |           |
 topic   papers   gaps    questions    methods    plan
 scope   trends   opps    hypotheses   justify    timeline
```

## Key Design Principles

1. **Progressive depth**: Each phase builds on previous outputs — literature informs gaps, gaps inform questions, questions inform methods
2. **Interactive guidance**: Collect user preferences and domain context before each major phase
3. **Zotero integration**: Automatically organize discovered papers into Zotero collections when MCP tools are available
4. **Structured outputs**: Each phase produces structured artifacts that feed into the final research plan
5. **5W1H grounding**: Use the 5W1H framework to ensure comprehensive research scoping

## Interactive Preference Collection

Before dispatching to phases, collect research context and workflow preferences:

```
user prompt:
  question: "Please describe your research topic or interest area."
  → Store as: researchTopic

user prompt:
  question: "What is the scope and context of your research?"
  options:
    - "Broad exploration (survey a field)"
    - "Focused investigation (specific problem)"
    - "Applied research (practical application)"
  → Store as: researchScope

user prompt:
  question: "What is your target research timeline?"
  options:
    - "Short-term (3-6 months)"
    - "Medium-term (6-12 months)"
    - "Long-term (1-2 years)"
  → Store as: researchTimeline

user prompt:
  question: "Do you have access to Zotero for literature management?"
  options:
    - "Yes (auto-import papers to Zotero)"
    - "No (skip Zotero integration)"
  → Store as: useZotero

user prompt:
  question: "Workflow mode?"
  options:
    - "Interactive (confirm at each phase)"
    - "Auto (run all phases continuously)"
  → Store as: workflowMode
```

Derived preferences:
```
workflowPreferences = {
  topic: researchTopic,
  scope: researchScope,
  timeline: researchTimeline,
  useZotero: useZotero === "Yes",
  autoYes: workflowMode === "Auto"
}
```

## Auto Mode Defaults

When `workflowPreferences.autoYes === true`: Execute all 5 phases sequentially without confirmation prompts between phases. Still pause for user input when phase-specific questions arise (e.g., confirming search keywords, selecting papers for deep reading).

## Execution Flow

> **COMPACT DIRECTIVE**: Context compression MUST check TodoWrite phase status.
> The phase currently marked `in_progress` is the active execution phase — preserve its FULL content.
> Only compress phases marked `completed` or `pending`.

### TodoWrite Initialization

```
TodoWrite:
  - "Phase 1: Literature Search" (pending)
  - "Phase 2: Gap Analysis" (pending)
  - "Phase 3: Research Question Formulation" (pending)
  - "Phase 4: Method Selection" (pending)
  - "Phase 5: Research Planning" (pending)
```

### Phase Dispatch

```
Phase 1: Literature Search
   Mark TodoWrite Phase 1 → in_progress
   └─ Ref: phases/01-literature-search.md
      ├─ Input: workflowPreferences (topic, scope, useZotero)
      └─ Output: literatureResults (papers, trends, keyFindings)

Phase 2: Gap Analysis
   Mark TodoWrite Phase 1 → completed, Phase 2 → in_progress
   └─ Ref: phases/02-gap-analysis.md
      ├─ Input: literatureResults
      └─ Output: gapAnalysis (gaps, opportunities, priorities)

Phase 3: Research Question Formulation
   Mark TodoWrite Phase 2 → completed, Phase 3 → in_progress
   └─ Ref: phases/03-research-question.md
      ├─ Input: gapAnalysis + literatureResults
      └─ Output: researchQuestions (questions, hypotheses, objectives)

Phase 4: Method Selection
   Mark TodoWrite Phase 3 → completed, Phase 4 → in_progress
   └─ Ref: phases/04-method-selection.md
      ├─ Input: researchQuestions + gapAnalysis
      └─ Output: selectedMethods (methods, justification, resources)

Phase 5: Research Planning
   Mark TodoWrite Phase 4 → completed, Phase 5 → in_progress
   └─ Ref: phases/05-research-planning.md
      ├─ Input: ALL previous outputs
      └─ Output: research-plan.md (final deliverable)

Mark TodoWrite Phase 5 → completed
```

**Phase Reference Documents** (read on-demand when phase executes):

| Phase | Document | Purpose | Compact |
|-------|----------|---------|---------|
| 1 | [phases/01-literature-search.md](phases/01-literature-search.md) | Search, discover, and organize literature | TodoWrite driven |
| 2 | [phases/02-gap-analysis.md](phases/02-gap-analysis.md) | Identify research gaps and opportunities | TodoWrite driven |
| 3 | [phases/03-research-question.md](phases/03-research-question.md) | Formulate research questions and hypotheses | TodoWrite driven |
| 4 | [phases/04-method-selection.md](phases/04-method-selection.md) | Select and justify research methods | TodoWrite driven + sentinel |
| 5 | [phases/05-research-planning.md](phases/05-research-planning.md) | Create timeline, milestones, and final plan | TodoWrite driven + sentinel |

**Compact Rules**:
1. **TodoWrite `in_progress`** — preserve full content, do not compress
2. **TodoWrite `completed`** — may compress to summary
3. **sentinel fallback** — phases marked with sentinel: if compact leaves only sentinel without full Step protocol, immediately `Read()` to recover

## Core Rules

1. **Literature first**: Always complete literature search before gap analysis — gaps must be grounded in actual literature
2. **Evidence-based gaps**: Every identified gap must reference specific papers or missing coverage areas
3. **SMART questions**: Research questions must satisfy Specific, Measurable, Achievable, Relevant, Time-bound criteria
4. **Method-question alignment**: Selected methods must directly address the formulated research questions
5. **Feasibility check**: Research plan must account for available resources (compute, data, time, personnel)
6. **No hallucinated papers**: Only reference papers actually found via WebSearch — never fabricate citations

## Input Processing

User input (free text or structured) is converted to:

```
TOPIC: [research topic or interest]
SCOPE: [broad | focused | applied]
TIMELINE: [short | medium | long]
CONTEXT: [additional constraints, domain, background]
```

If user provides a simple topic string, derive scope and timeline from the topic description or ask via user prompt.

## Data Flow

```
workflowPreferences
    ├─→ Phase 1: topic, scope, useZotero
    │       └─→ literatureResults {papers[], trends[], keyFindings[], zoteroCollection?}
    │
    ├─→ Phase 2: literatureResults
    │       └─→ gapAnalysis {gaps[], opportunities[], prioritizedGaps[]}
    │
    ├─→ Phase 3: gapAnalysis + literatureResults
    │       └─→ researchQuestions {questions[], hypotheses[], objectives[]}
    │
    ├─→ Phase 4: researchQuestions + gapAnalysis
    │       └─→ selectedMethods {methods[], justification, resources[]}
    │
    └─→ Phase 5: ALL outputs
            └─→ research-plan.md (final structured document)
```

## TodoWrite Pattern

**Phase start — Attach sub-tasks**:
```
Mark Phase N → in_progress
Add sub-tasks:
  - "Step N.1: ..." (in_progress)
  - "Step N.2: ..." (pending)
  - "Step N.3: ..." (pending)
```

**Phase end — Collapse**:
```
Mark all Phase N sub-tasks → completed
Mark Phase N → completed
Mark Phase N+1 → in_progress
```

## Post-Phase Updates

After each phase completes, update an accumulated research notes document:

```markdown
## Research Notes (accumulated)

### After Phase 1 (Literature Search)
- Papers found: [count]
- Key trends: [list]
- Zotero collection: [name, if applicable]

### After Phase 2 (Gap Analysis)
- Gaps identified: [count]
- Top priorities: [list]

### After Phase 3 (Research Questions)
- Primary RQ: [question]
- Sub-questions: [count]

### After Phase 4 (Method Selection)
- Selected approach: [method]
- Required resources: [list]
```

## Error Handling

1. **WebSearch fails**: Retry with modified keywords; if persistent, ask user for alternative search terms
2. **No papers found**: Broaden search scope, try synonyms and related terms, try different databases
3. **Zotero unavailable**: Skip Zotero integration, continue with manual paper tracking in markdown
4. **Gap analysis inconclusive**: Return to Phase 1 for additional targeted literature search
5. **Infeasible plan**: Adjust scope, timeline, or methods; consult user for trade-off decisions

## Coordinator Checklist

**Pre-phase**:
- [ ] Verify previous phase outputs are available
- [ ] Update TodoWrite status
- [ ] Read phase document (`Read("phases/0N-xxx.md")`)

**Post-phase**:
- [ ] Validate phase outputs (non-empty, well-structured)
- [ ] Update accumulated research notes
- [ ] Collapse TodoWrite sub-tasks
- [ ] If not autoYes, confirm with user before proceeding

## Output Files

The workflow produces:
- **`research-plan.md`** — Final structured research proposal with all sections
- **`literature-review.md`** — Structured literature review with categorized papers
- **Zotero collection** — Organized papers with PDFs (if Zotero enabled)

## Related Skills

- **scholar-experiment** — Experiment execution and tracking (follows this skill)
- **scholar-writing** — Paper writing workflow (uses outputs from experiment)
- **scholar-review** — Paper review and revision workflow
