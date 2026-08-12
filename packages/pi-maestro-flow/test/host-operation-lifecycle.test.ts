/**
 * @deprecated Covers the migration-period distributed operation
 * claim/heartbeat experiment, superseded by the Session/Run minimal-state
 * architecture (docs/session-run-minimal-state-architecture-20260812.md,
 * section 10 LocalTaskRegistry). The module under test does not enter the v3
 * production route and will be rewritten as an in-process local task registry.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HostOperationLifecycle } from "../src/session/host-operation-lifecycle.ts";

interface RecordedClaim {
  operationId: string;
  kind: "turn" | "tool" | "process";
  parentOperationId?: string;
}

function harness() {
  const claims: RecordedClaim[] = [];
  const releases: string[] = [];
  const warnings: string[] = [];
  const coordinator = {
    async claimHostOperation(
      operationId: string,
      kind: RecordedClaim["kind"],
      _hostSessionId: string,
      parentOperationId?: string,
    ) {
      claims.push({ operationId, kind, parentOperationId });
      return {
        operationId,
        kind,
        operationToken: `token-${operationId}`,
        parentOperationId: parentOperationId ?? null,
        registryRevision: claims.length,
      };
    },
    async releaseHostOperation(operationId: string) {
      releases.push(operationId);
    },
  };
  const lifecycle = new HostOperationLifecycle(
    () => ({ coordinator: coordinator as never, hostSessionId: "pi-owner" }),
    (message) => warnings.push(message),
  );
  return { lifecycle, claims, releases, warnings };
}

test("host lifecycle releases the turn only at settlement and preserves tool parentage", async () => {
  const { lifecycle, claims, releases } = harness();
  await lifecycle.beforeAgentStart();
  await lifecycle.beforeAgentStart();
  const turn = claims[0]!;
  assert.equal(turn.kind, "turn");
  const toolOperationId = await lifecycle.toolCall("call-1");
  assert.equal(claims[1]?.parentOperationId, turn.operationId);
  assert.equal(lifecycle.toolOperationId("call-1"), toolOperationId);
  await lifecycle.toolExecutionEnd("call-1");
  assert.deepEqual(releases, [toolOperationId]);
  assert.equal(releases.includes(turn.operationId), false);
  await lifecycle.agentSettled();
  assert.deepEqual(releases, [toolOperationId, turn.operationId]);
});

test("handoff run-control tools stay in the turn lineage while long-lived processes use independent roots", async () => {
  const { lifecycle, claims, releases } = harness();
  await lifecycle.beforeAgentStart();
  const handoffTool = await lifecycle.toolCall("call-handoff");
  await lifecycle.teammateStarted({ correlationId: "agent-1" });
  await lifecycle.teammateStarted({ correlationId: "agent-1" });
  const handoffClaim = claims.find((claim) => claim.operationId === handoffTool)!;
  const processClaim = claims.find((claim) => claim.operationId === "process:teammate:agent-1")!;
  assert.equal(handoffClaim.parentOperationId, claims[0]?.operationId);
  assert.equal(processClaim.parentOperationId, undefined);
  assert.equal(claims.filter((claim) => claim.operationId === processClaim.operationId).length, 1);
  await lifecycle.agentSettled();
  assert.equal(releases.includes(processClaim.operationId), false);
  await lifecycle.teammateComplete({ correlationId: "agent-1" });
  assert.equal(releases.includes(processClaim.operationId), true);
});

test("teammate completion queues behind an in-flight started claim", async () => {
  const { lifecycle, claims, releases } = harness();
  const started = lifecycle.teammateStarted({ correlationId: "agent-fast" });
  const completed = lifecycle.teammateComplete({ correlationId: "agent-fast" });
  await Promise.all([started, completed]);
  assert.equal(claims.some((claim) => claim.operationId === "process:teammate:agent-fast"), true);
  assert.equal(releases.includes("process:teammate:agent-fast"), true);
});

test("bash_bg snapshots release only terminal jobs and shutdown leaves unresolved claims", async () => {
  const { lifecycle, claims, releases } = harness();
  await lifecycle.reconcileBashBg([
    { id: "job-1", status: "running", background: true },
    { id: "foreground", status: "running", background: false },
  ]);
  assert.equal(claims.some((claim) => claim.operationId === "process:bash-bg:job-1"), true);
  assert.equal(claims.some((claim) => claim.operationId.includes("foreground")), false);
  await lifecycle.reconcileBashBg([{ id: "job-1", status: "stopping", background: true }]);
  assert.equal(releases.length, 0);
  await lifecycle.reconcileBashBg([{ id: "job-1", status: "completed", background: true }]);
  assert.deepEqual(releases, ["process:bash-bg:job-1"]);

  await lifecycle.reconcileBashBg([{ id: "job-2", status: "running", background: true }]);
  assert.equal(lifecycle.shutdown(), true);
  await lifecycle.reconcileBashBg([{ id: "job-2", status: "completed", background: true }]);
  assert.equal(releases.includes("process:bash-bg:job-2"), false);
  const claimCount = claims.length;
  await lifecycle.beforeAgentStart();
  assert.equal(claims.length, claimCount);
});
