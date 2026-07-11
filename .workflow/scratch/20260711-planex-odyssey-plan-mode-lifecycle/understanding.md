# Planex Odyssey: Plan Mode Lifecycle

## 1. Requirement & Criteria

Implement the approved `ANL-001` Plan mode redesign as an extension of the existing Plan subsystem.

Acceptance criteria:

1. Dynamic active-tool transition with exact snapshot restoration.
2. Workspace-keyed global `~/.pi` Markdown storage with draft, manifest, immutable approvals and recovery.
3. Full-screen multiline Markdown editor with line numbers, highlight and human editing.
4. Fail-closed atomic confirmation before Act transition.
5. LLM-callable Plan lifecycle tool contracts and mode gating.
6. Compatibility with `/plan`, `Alt+P`, tag capture, hooks and safety filters.
7. Draft persistence across session shutdown without automatic Plan entry.
8. Focused regression, runtime and width/keyboard verification.

## 2. Plan

1. Implement `PlanStore`: workspace identity, draft, manifest, immutable approvals, atomic writes and recovery.
2. Refactor lifecycle state into a controller and add LLM-callable Plan tools with dynamic active-tool switching.
3. Implement a full-screen multiline Markdown editor with line numbers, highlighting, cursor editing and save/confirm/cancel.
4. Integrate the store/controller/editor into existing hooks, `/plan`, `Alt+P` and compatibility capture.
5. Add focused regression tests, runtime matrices and documentation.

Dependencies: T1 precedes T2/T3; T2 and T3 converge in T4; T5 verifies all criteria.

## 3. Execution

Pending.

## 4. Verification

Pending.

## 5. Fix Log

Pending.

## 6. Generalization

Pending.

## 7. Discoveries

Pending.

## 8. Learnings

Pending.
