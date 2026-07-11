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

Iteration 3 external Codex review:

| Criterion | Result | Evidence |
|---|---|---|
| AC1 | Passed | exact dynamic tool snapshot lifecycle remains correct |
| AC2 | Failed | structurally damaged manifest can still authorize orphan deletion; mtime-only stale takeover lacks lock ownership |
| AC3 | Passed | full-screen editor contract remains correct |
| AC4 | Failed | a transaction longer than the stale threshold can lose its lock and in-flight archive |
| AC5 | Passed | six plain-Markdown tools and gating remain correct |
| AC6 | Passed | adversarial shell/delegate and compatibility checks passed |
| AC7 | Passed | shutdown and restart semantics remain correct |
| AC8 | Failed | damaged-manifest and stale-owner regression tests are still missing because the implementation is incomplete |

The default maximum of 3 verification iterations was reached. The session is therefore `ESCALATED`; no criterion was weakened or manually overridden.

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

Skipped by the Planex state machine because the maximum verification iteration ended with failed criteria. No implementation pattern is marked complete.

## 7. Discoveries

Residual findings were triaged as actionable bugs:

1. High — `validateManifest()` accepts structurally inconsistent values, allowing a damaged manifest to produce an empty committed set and delete valid approval history.
2. High — the fixed-path lock uses only directory `mtime`; a long transaction can be declared stale, lose ownership and later delete a newer owner's lock.
3. Medium — deterministic tests are missing for damaged manifest invariants, owner-checked stale takeover, old-owner release and clock rollback/latest-revision selection.

Because the Planex maximum iteration was reached, these are routed to a follow-up `$odyssey-debug` rather than silently fixed outside the confirmed loop.

## 8. Learnings

Persisted project debug spec `S-20260711-5vq1`: Plan persistence recovery must validate the full manifest invariant before deleting archives, and cross-process transaction locks require owner token, heartbeat and owner-checked release.

Final status: `ESCALATED` — 5/8 acceptance criteria passed after 3 verification cycles. The implementation is materially improved and committed, but AC2, AC4 and AC8 remain open.

### Goal continuation repair

The active thread goal explicitly continued the full AC1–AC8 objective after the original iteration cap. The session was reopened without weakening any criterion.

- Manifest validation now checks workspace identity, non-negative integer revision, status, checksums, timestamps, canonical archive paths, strictly increasing approval revisions and approved-field consistency.
- A valid-looking manifest that omits recoverable archives now triggers archive-based reconstruction instead of deletion.
- Approval uses `approval.pending.json`; interrupted archives are quarantined and cannot be mistaken for committed approvals.
- Recovery chooses the highest approval revision, remaining correct when the wall clock moves backwards.
- Workspace locks now carry random owner token, PID and heartbeat. Stale takeover uses a token-specific claim and atomic quarantine.
- Every mutation rechecks lock ownership; an old owner cannot commit, remove a replacement lock or delete the replacement pending transaction.
- New deterministic tests cover damaged manifest invariants, clock rollback, interrupted pending approval, heartbeat protection, dead-owner recovery and old-owner handoff.

Focused Plan verification after this repair: 25/25 passed; runtime imports passed.

A local transaction-boundary self-review found and closed two additional cases before final verification:

- Once `manifest.json` is durably committed, failure to clean `approval.pending.json` no longer rolls back or deletes the committed archive.
- Structurally invalid pending markers and their uncommitted archives are quarantined instead of being promoted during reconstruction.
- Atomic write helpers now remove temporary files when rename fails, and persisted timestamps require canonical ISO format.

PlanStore coverage increased to 17/17; total Plan coverage is now 27 tests.

The final AGY independent review passed AC1–AC8 and reported two medium cleanup findings. Both were fixed:

- A failed session-start store is cleared so a later `plan-enter` creates a fresh store and can recover.
- `initPlan` and session-start reset leaked module state and restore any exact active-tool snapshot before reinitialization.

Two lifecycle regressions cover retry after initial storage failure and reinitialization after a leaked Plan state. Final focused Plan coverage: 29/29.

Iteration 4 final verification:

| Criterion | Result | Evidence |
|---|---|---|
| AC1 | Passed | exact Act snapshot restored across exit, approval, shutdown and reinit |
| AC2 | Passed | strict manifest/archive validation, pending recovery, quarantine and revision-based reconstruction |
| AC3 | Passed | full-screen editor tests plus width 1–120 live matrix |
| AC4 | Passed | exact buffer commits before Act; failure/lost ownership remains in Plan; post-commit cleanup cannot roll back |
| AC5 | Passed | all six plain-Markdown tools and mode gates |
| AC6 | Passed | slash, shortcut, proposed-plan, hook order and adversarial shell/delegate checks |
| AC7 | Passed | shutdown/restart/retry/reinitialization semantics |
| AC8 | Passed | Plan 29/29, Todo 10/10, Hooks 7/7, Ask 2/2, runtime imports, width matrix and diff check |

Independent AGY review: all AC1–AC8 passed. Codex and Claude review infrastructure failures were recorded separately and did not replace the successful independent review.
