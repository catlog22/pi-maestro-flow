# Roadmap: {{PROJECT_NAME}}

## Overview

{{One paragraph describing the journey from start to finish}}

## Milestones

### Milestone 1: {{MILESTONE_1_NAME}} ({{VERSION}})
**Target**: {{DELIVERABLE_DESCRIPTION}}
**Status**: active | completed | planned

**Minimum-phase principle:** Default 1 phase per milestone. Only add phases for hard dependencies (runtime + not parallelizable + full barrier). Wave DAG inside each phase handles task ordering.

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

#### Phases

- [ ] **Phase 1: {{PHASE_1_TITLE}}** — {{ONE_LINE_DESCRIPTION}}

#### Phase Details

##### Phase 1: {{PHASE_1_TITLE}}
**Goal**: {{WHAT_THIS_PHASE_DELIVERS}}
**Depends on**: Nothing (first phase)
**Requirements**: {{REQ_IDS}}
**Success Criteria** (what must be TRUE):
  1. {{OBSERVABLE_BEHAVIOR_FROM_USER_PERSPECTIVE}}
  2. {{OBSERVABLE_BEHAVIOR_FROM_USER_PERSPECTIVE}}

---

## Scope Decisions

- **In scope**: {{INCLUDED}}
- **Deferred**: {{LATER_MILESTONES}}
- **Out of scope**: {{EXCLUDED}}

## Progress

| Milestone | Phase | Status | Completed |
|-----------|-------|--------|-----------|
| 1. {{MILESTONE_1_NAME}} | 1. {{PHASE_1_TITLE}} | Not started | - |
