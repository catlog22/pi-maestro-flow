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

- Added `PlanStore` with workspace hashing, `current.md`, manifest, immutable approvals, revision checks, atomic writes and recovery.
- Added a full-screen multiline Plan editor with logical line numbers, current-line marker/highlight, cursor editing, scrolling, save, cancel and fail-closed confirmation.
- Rebuilt the Plan lifecycle around dynamic `getActiveTools()` / `setActiveTools()` snapshot and restoration.
- Added `plan-enter`, `plan-update`, `plan-review`, `plan-confirm`, `plan-exit` and `plan-status`.
- Preserved `/plan`, `Alt+P`, compatibility tag capture, Plan-before-Goal hooks and safe Bash filtering.
- Added Plan documentation and focused tests.

Local execution evidence: Plan 13/13, Todo 10/10, Hooks 7/7, Ask 2/2; runtime imports passed; editor width matrix 1–120 passed; diff check passed.

## 4. Verification

Iteration 1 external Codex review:

| Criterion | Result | Evidence |
|---|---|---|
| AC1 | Failed | shutdown discarded active-tool snapshot |
| AC2 | Failed | archive write/orphan recovery incomplete |
| AC3 | Passed | editor behavior and width tests |
| AC4 | Failed | Esc/busy race and partial approval transaction |
| AC5 | Passed | six tools and mode gating covered |
| AC6 | Failed | shell chain and missing delegate mode bypasses |
| AC7 | Failed | same-instance shutdown restoration missing |
| AC8 | Failed | requires full rerun after fixes |

Routing: S_FIX iteration 1. Acceptance criteria remain unchanged.

Iteration 2 external Codex review:

| Criterion | Result | Evidence |
|---|---|---|
| AC1 | Passed | exact tool snapshot restored on exit, approval and shutdown |
| AC2 | Failed | manifest-loss recovery deleted valid history; recovery could race an in-flight approval |
| AC3 | Passed | editor tests and width 1–120 live check |
| AC4 | Failed | concurrent recovery could delete an archive before manifest commit |
| AC5 | Passed | six tools and gating verified |
| AC6 | Failed | missing shell command and safe-prefix arguments such as `find -delete` and `git diff --output` failed open |
| AC7 | Passed | shutdown/restart behavior verified |
| AC8 | Failed | adversarial storage and shell cases were not covered |

Routing: S_FIX iteration 2. Acceptance criteria remain unchanged.

## 5. Fix Log

Iteration 1 targeted repairs:

- Rejected shell chaining, pipelines, command substitution and multiline commands before applying the read-only allowlist.
- Required `maestro delegate` to specify `mode: "analysis"`; omitted and write modes now fail closed.
- Restored the exact Act tool snapshot during session shutdown before clearing Plan runtime state.
- Ignored editor input, including `Esc`, while save or approval is in flight.
- Made approval archives atomic, tracked committed approval history in the manifest and removed orphan archives during recovery.
- Isolated compatibility `<proposed_plan>` capture failures so later hooks, including Goal processing, still run.

Regression coverage was added for every repair. After the fixes: Plan 16/16, Todo 10/10, Hooks 7/7 and Ask 2/2 passed; runtime imports, editor width 1–120 and `git diff --check` also passed.

Iteration 2 targeted repairs:

- Replaced prefix-only shell approval with fail-closed input handling and command-specific argument validation.
- Added negative coverage for missing commands, `find -delete/-exec`, `git --output/--ext-diff`, `fd --exec` and `npm audit --fix`.
- Serialized load, save and approval through a workspace transaction lock so recovery cannot observe or delete an in-flight archive.
- Rebuilt valid immutable approval history from archive filenames when `manifest.json` is missing or damaged instead of deleting it.
- Added manifest-loss and concurrent approval/recovery regression tests.
- Separated lock acquisition errors from transaction errors, advanced revisions for diverged recovered drafts, and blocked additional executable pager/preprocessor and Git mutation forms.

After the second repair round: Plan 19/19, Todo 10/10, Hooks 7/7 and Ask 2/2 passed; runtime imports and `git diff --check` passed. Width 1–120 remained covered by the unchanged editor implementation and prior live matrix.

## 6. Generalization

Pending.

## 7. Discoveries

Pending.

## 8. Learnings

Pending.
