# Phase 0 Baseline Snapshot

## Timestamp
2026-08-02

## Git Status
Dirty worktree with 42 modified files (1880 insertions, 245 deletions).
Diff checksum: bba4ec2b0a44fdaadb6efbf2a6d101ca

## Test Baseline
- Total: 589 tests
- Pass: 544
- Fail: 3 (pre-existing in dirty worktree)
- Cancelled: 40 (cascade from failures)
- Skipped: 2

### Pre-existing Failures (dirty worktree lifecycle work)
1. `warm wake publishes every subsequent turn completion` (lifecycle-boundary-regressions.test.ts:306) — Expected 1 !== 2
2. `mixed nested graph settlement preserves successful sibling wakeability` (lifecycle-boundary-regressions.test.ts:752) — Expected 'failed' vs actual
3. `session shutdown fences delayed root completion from the replacement session` (lifecycle-boundary-regressions.test.ts:1102) — Expected true !== false

These are part of the user's in-progress lifecycle work. Mailbox implementation must not introduce NEW failures beyond these.

## Key Modified Files (teammate package)
- src/extension/index.ts (+359 lines)
- src/extension/teammate-proxy.ts (+305 lines)
- src/runs/execution.ts (+209 lines)
- src/extension/teammate-helpers.ts (+137 lines)
- src/extension/workspace-peers.ts (+43 lines)
- src/extension/teammate-core.ts (+36 lines)
- src/shared/types.ts (+28 lines)
- src/runs/execution-infra.ts (+17 lines)
