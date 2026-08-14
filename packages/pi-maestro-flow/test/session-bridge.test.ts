import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildTodoMirrorSpecs, loadCanonicalSnapshot, WorkflowBridge } from "../src/session/bridge.ts";
import type { WorkflowSnapshot } from "../src/session/types.ts";

test("bridge ignores an older refresh that completes after a newer snapshot", async () => {
  const older = deferred<WorkflowSnapshot>();
  const newer = deferred<WorkflowSnapshot>();
  const snapshots = [older.promise, newer.promise];
  class InterleavedWorkflowBridge extends WorkflowBridge {
    protected override loadSnapshot(): Promise<WorkflowSnapshot> {
      const snapshot = snapshots.shift();
      assert.ok(snapshot, "each refresh must consume one controlled snapshot");
      return snapshot;
    }
  }
  const bridge = new InterleavedWorkflowBridge("D:/workspace");
  const olderRefresh = bridge.refresh();
  const newerRefresh = bridge.refresh();
  const newerSnapshot = bridgeSnapshot("newer");
  const olderSnapshot = bridgeSnapshot("older");

  newer.resolve(newerSnapshot);
  assert.equal(await newerRefresh, newerSnapshot);
  assert.equal(bridge.getSnapshot(), newerSnapshot);

  older.resolve(olderSnapshot);
  assert.equal(await olderRefresh, newerSnapshot);
  assert.equal(bridge.getSnapshot(), newerSnapshot, "the stale completion must not replace the latest snapshot");
});

test("a superseded bridge refresh waits for the winning generation when it completes first", async () => {
  const older = deferred<WorkflowSnapshot>();
  const newer = deferred<WorkflowSnapshot>();
  const snapshots = [older.promise, newer.promise];
  class InterleavedWorkflowBridge extends WorkflowBridge {
    protected override loadSnapshot(): Promise<WorkflowSnapshot> {
      const snapshot = snapshots.shift();
      assert.ok(snapshot, "each refresh must consume one controlled snapshot");
      return snapshot;
    }
  }
  const bridge = new InterleavedWorkflowBridge("D:/workspace");
  let olderSettled = false;
  const olderRefresh = bridge.refresh().finally(() => {
    olderSettled = true;
  });
  const newerRefresh = bridge.refresh();
  const newerSnapshot = bridgeSnapshot("newer");

  older.resolve(bridgeSnapshot("older"));
  await settleAsyncWork();
  assert.equal(olderSettled, false, "the superseded caller must wait while the winner is pending");
  assert.equal(bridge.getSnapshot(), undefined, "the superseded result must never be published");

  newer.resolve(newerSnapshot);
  assert.equal(await newerRefresh, newerSnapshot);
  assert.equal(await olderRefresh, newerSnapshot);
  assert.equal(bridge.getSnapshot(), newerSnapshot);
});

test("bridge reads canonical Session/Run/Artifact state and changes revision by content", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-bridge-"));
  const sessionId = "20260715-integration";
  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  const runId = "20260715-001-analyze";
  try {
    await mkdir(join(sessionDir, "runs", runId), { recursive: true });
    await writeJson(join(root, ".workflow", "state.json"), {
      version: "2.0",
      active_session_id: sessionId,
      sessions: [],
    });
    await writeJson(join(sessionDir, "session.json"), {
      schema_version: "session/1.1",
      session_id: sessionId,
      intent: "Integrate Session and Todo",
      status: "running",
      revision: 7,
      active_run_id: runId,
      boundary_contract: { definition_of_done: "All gates pass" },
      gates: [{ id: "GATE-S-01", blocking: true, status: "passed" }],
      orchestration: {
        chain: [
          { step: "analyze", command: "analyze", status: "running", run_id: runId, skill: "maestro" },
          { step: "plan", command: "plan", status: "pending", run_id: null },
        ],
      },
    });
    await writeJson(join(sessionDir, "runs", runId, "run.json"), {
      schema_version: "run/1.1",
      run_id: runId,
      parent_run_id: null,
      command: "analyze",
      status: "running",
      goal: "Produce analysis",
      input: { args: ["--deep"], consumes: [] },
      gates: [{ id: "GATE-001-01", phase: "entry", blocking: true, status: "passed" }],
      primary: null,
      handoff: null,
      started_at: "2026-07-15T00:00:00.000Z",
      ended_at: null,
    });
    await writeJson(join(sessionDir, "artifacts.json"), {
      schema_version: "artifacts/1.1",
      artifacts: {
        "artifact-1": {
          kind: "analysis",
          role: "primary",
          run_id: runId,
          path: "outputs/analysis.json",
          hash: "abc",
          status: "sealed",
          replaces: null,
        },
      },
      aliases: { "current-analysis": "artifact-1" },
    });

    const first = await loadCanonicalSnapshot(root, { now: () => new Date("2026-07-15T01:00:00Z") });
    assert.equal(first.source, "canonical");
    assert.equal(first.session?.revision, 7);
    assert.equal(first.execution?.executionId, `legacy:${sessionId}`);
    assert.equal(first.execution?.generation, 1);
    assert.equal(first.session?.runs[0]?.runId, runId);
    assert.equal(first.session?.artifacts[0]?.artifactId, "artifact-1");
    assert.equal(first.session?.aliases["current-analysis"], "artifact-1");
    const specs = buildTodoMirrorSpecs(first);
    assert.equal(specs[0]?.status, "in_progress");
    assert.deepEqual(specs[0]?.skills, [{ name: "maestro", role: "primary" }]);
    assert.equal(specs[1]?.status, "blocked");
    assert.equal(specs[1]?.blockedByOriginKeys.length, 1);

    const bridge = new WorkflowBridge(root);
    const cached = await bridge.refresh();
    assert.equal(await bridge.refresh(), cached);
    await writeJson(join(sessionDir, "session.json"), {
      schema_version: "session/1.1",
      session_id: sessionId,
      intent: "Integrate Session and Todo",
      status: "paused",
      revision: 8,
      active_run_id: runId,
      boundary_contract: { definition_of_done: "All gates pass" },
      gates: [],
      orchestration: { chain: [] },
    });
    const changed = await bridge.refresh();
    assert.notEqual(changed.revision.fingerprint, cached.revision.fingerprint);
    assert.equal(changed.revision.sessionRevision, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge projects the current Execution with locators, revisions, and redacted lease metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-execution-"));
  const sessionId = "20260718-execution";
  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  const executionId = "execution-0002";
  const runId = "20260718-002-execute";
  const leaseId = "private-lease-token-must-not-escape";
  try {
    await mkdir(join(sessionDir, "executions", "execution-0001"), { recursive: true });
    await mkdir(join(sessionDir, "executions", executionId), { recursive: true });
    await mkdir(join(sessionDir, "executions", `2-${executionId}`), { recursive: true });
    await writeJson(join(root, ".workflow", "state.json"), {
      version: "2.0",
      active_session_id: sessionId,
      sessions: [],
    });
    await writeJson(join(sessionDir, "session.json"), {
      schema_version: "session/1.3",
      session_id: sessionId,
      intent: "Project the current Execution",
      status: "running",
      revision: 12,
      identity_revision: 4,
      activity_revision: 12,
      active_run_id: null,
      orchestration: { chain: [] },
    });
    await writeJson(join(sessionDir, "executions", "execution-0001", "execution.json"), {
      schema_version: "execution/1.0",
      execution_id: "execution-0001",
      session_id: sessionId,
      generation: 1,
      status: "sealed",
      revision: 8,
      active_run_id: null,
      chain: [],
      decision_points: [],
      gates_ref: "gates.json",
      artifacts_ref: "artifacts.json",
      evidence_ref: "evidence.json",
      lease: null,
      started_at: "2026-07-18T00:00:00.000Z",
      sealed_at: "2026-07-18T00:10:00.000Z",
      seal_summary: "First generation complete",
      final_outcome: "done",
    });
    const executionPath = join(sessionDir, "executions", executionId, "execution.json");
    await writeJson(executionPath, {
      schema_version: "execution/1.0",
      execution_id: executionId,
      session_id: sessionId,
      generation: 2,
      status: "active",
      revision: 3,
      active_run_id: runId,
      chain: [{ step_id: "execute", command: "execute", status: "running", run_id: runId }],
      decision_points: [{
        point_id: "decision-1",
        after_step_id: null,
        status: "pending",
        retry_count: 0,
        max_retries: 2,
        evidence_ref: null,
      }],
      gates_ref: "gates.json",
      artifacts_ref: "artifacts.json",
      evidence_ref: "evidence.json",
      lease: {
        schema_version: "execution-lease/1.0",
        session_id: sessionId,
        execution_id: executionId,
        owner_id: "pi-session-owner",
        owner_kind: "pi",
        epoch: 7,
        lease_id: leaseId,
        acquired_at: "2026-07-18T00:20:00.000Z",
        heartbeat_at: "2026-07-18T00:21:00.000Z",
        handoff_to: null,
      },
      started_at: "2026-07-18T00:20:00.000Z",
      sealed_at: null,
      seal_summary: null,
      final_outcome: null,
    });
    await writeJson(join(sessionDir, "executions", `2-${executionId}`, "execution.json"), {
      schema_version: "execution/1.0",
      execution_id: executionId,
      session_id: sessionId,
      generation: 2,
      status: "paused",
      revision: 999,
      active_run_id: null,
      chain: [],
      decision_points: [],
      gates_ref: "gates.json",
      artifacts_ref: "artifacts.json",
      evidence_ref: "evidence.json",
      lease: null,
      started_at: "2026-07-18T00:20:00.000Z",
      sealed_at: null,
      seal_summary: null,
      final_outcome: null,
    });

    const first = await loadCanonicalSnapshot(root);
    assert.equal(first.session?.status, "running", "Execution projection must not replace Session.status");
    assert.equal(first.sessionGeneration, `canonical:valid:${sessionId}:12`);
    assert.deepEqual(first.locator, { sessionId, executionId, generation: 2, runId });
    assert.equal(first.revision.sessionRevision, 12);
    assert.equal(first.revision.executionRevision, 3);
    assert.equal(first.execution?.executionId, executionId);
    assert.equal(first.execution?.generation, 2);
    assert.equal(first.execution?.chain[0]?.step, "execute");
    assert.equal(first.execution?.decisionPoints[0]?.pointId, "decision-1");
    assert.deepEqual(first.execution?.lease, {
      schemaVersion: "execution-lease/1.0",
      sessionId,
      executionId,
      ownerId: "pi-session-owner",
      ownerKind: "pi",
      epoch: 7,
      acquiredAt: "2026-07-18T00:20:00.000Z",
      heartbeatAt: "2026-07-18T00:21:00.000Z",
      handoffTo: null,
    });
    assert.ok(!JSON.stringify(first).includes(leaseId), "the raw lease token must be redacted deeply");
    assert.ok(!JSON.stringify(first).includes("lease_id"), "the private lease field must not be projected");

    await writeJson(executionPath, {
      schema_version: "execution/1.0",
      execution_id: executionId,
      session_id: sessionId,
      generation: 2,
      status: "paused",
      revision: 4,
      active_run_id: null,
      chain: [],
      decision_points: [],
      gates_ref: "gates.json",
      artifacts_ref: "artifacts.json",
      evidence_ref: "evidence.json",
      lease: null,
      started_at: "2026-07-18T00:20:00.000Z",
      sealed_at: null,
      seal_summary: null,
      final_outcome: null,
    });
    const changed = await loadCanonicalSnapshot(root);
    assert.equal(changed.revision.executionRevision, 4);
    assert.notEqual(changed.revision.fingerprint, first.revision.fingerprint);
    assert.equal(changed.sessionGeneration, first.sessionGeneration, "Execution activity must not redefine Session identity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session/2.0 with a null current_execution_id does not select the highest Execution generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-v2-missing-execution-pointer-"));
  const sessionId = "20260718-v2-missing-pointer";
  try {
    await writeExecutionSelectionFixture(root, sessionId);

    const snapshot = await loadCanonicalSnapshot(root);
    assert.equal(snapshot.execution, undefined);
    assert.deepEqual(snapshot.locator, { sessionId });
    assert.equal(snapshot.revision.executionRevision, undefined);
    assert.equal(snapshot.session?.lifecycleAuthority, "execution-derived");
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot.session, "status"), false);
    assert.equal(snapshot.session?.currentExecutionId, null);
    assert.equal(snapshot.session?.latestExecutionId, "execution-0002");
    assert.equal(snapshot.session?.latestCompletedRunId, "20260718-001-analyze");

    const idleGeneration = snapshot.sessionGeneration;
    await writeExecutionSelectionFixture(root, sessionId, {
      activity_revision: 10,
      current_execution_id: "execution-0002",
    });
    const active = await loadCanonicalSnapshot(root);
    assert.equal(active.sessionGeneration, `canonical:valid:${sessionId}:10`,
      "the projected session revision tracks activity now that identity_revision is retired");
    assert.deepEqual(active.locator, {
      sessionId,
      executionId: "execution-0002",
      generation: 2,
    });
    assert.equal(active.revision.executionRevision, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session/2.0 retains latest pointers while selecting only current_execution_id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-v2-latest-pointer-"));
  const sessionId = "20260718-v2-latest-pointer";
  try {
    await writeExecutionSelectionFixture(root, sessionId, {
      current_execution_id: "execution-0001",
      latest_execution_id: "execution-0002",
      archived_at: "2026-07-18T03:00:00.000Z",
      archived_by: "pi-owner",
    });

    const snapshot = await loadCanonicalSnapshot(root);
    assert.equal(snapshot.execution?.executionId, "execution-0001");
    assert.equal(snapshot.execution?.generation, 1);
    assert.deepEqual(snapshot.locator, {
      sessionId,
      executionId: "execution-0001",
      generation: 1,
    });
    assert.equal(snapshot.session?.latestExecutionId, "execution-0002");
    assert.equal(snapshot.session?.latestCompletedRunId, "20260718-001-analyze");
    assert.equal(snapshot.session?.archivedAt, "2026-07-18T03:00:00.000Z");
    assert.equal(snapshot.session?.archivedBy, "pi-owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session/2.0 rejects invalid Execution pointers and pointed Execution records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-v2-invalid-execution-pointer-"));
  const sessionId = "20260718-v2-invalid-pointer";
  const executionId = "execution-0002";
  const executionPath = join(
    root,
    ".workflow",
    "sessions",
    sessionId,
    "executions",
    executionId,
    "execution.json",
  );
  try {
    for (const currentExecutionId of ["../execution-0002", "execution-missing"]) {
      await writeExecutionSelectionFixture(root, sessionId, { current_execution_id: currentExecutionId });

      const snapshot = await loadCanonicalSnapshot(root);
      assert.equal(snapshot.execution, undefined, currentExecutionId);
      assert.deepEqual(snapshot.locator, { sessionId }, currentExecutionId);
      assert.equal(snapshot.revision.executionRevision, undefined, currentExecutionId);
      assert.match(snapshot.diagnostics.join("\n"), /current_execution_id|Current Execution .* missing or invalid/);
    }

    await writeExecutionSelectionFixture(root, sessionId, { current_execution_id: executionId });
    const valid = JSON.parse(await readFile(executionPath, "utf8")) as Record<string, unknown>;
    const fixtures: Array<{ name: string; override: Record<string, unknown> }> = [
      { name: "schema", override: { schema_version: "execution/2.0" } },
      { name: "status", override: { status: "running" } },
      { name: "revision", override: { revision: -1 } },
      { name: "execution identity", override: { execution_id: "execution-other" } },
      { name: "session identity", override: { session_id: "session-other" } },
      { name: "generation identity", override: { generation: 0 } },
    ];

    for (const fixture of fixtures) {
      await writeJson(executionPath, { ...valid, ...fixture.override });
      const snapshot = await loadCanonicalSnapshot(root);
      assert.equal(snapshot.execution, undefined, fixture.name);
      assert.deepEqual(snapshot.locator, { sessionId }, fixture.name);
      assert.equal(snapshot.revision.executionRevision, undefined, fixture.name);
      assert.match(snapshot.diagnostics.join("\n"), /invalid Execution projection|missing or invalid/, fixture.name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge falls back to the unique running Session projection when active_session_id is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-fallback-unique-"));
  const sessionId = "20260717-fallback";
  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeJson(join(root, ".workflow", "state.json"), {
      version: "2.0",
      active_session_id: null,
      sessions: [{ session_id: sessionId, intent: "Fallback target", status: "running" }],
    });
    await writeJson(join(sessionDir, "session.json"), {
      schema_version: "session/1.1",
      session_id: sessionId,
      intent: "Fallback target",
      status: "running",
      revision: 3,
      active_run_id: null,
      orchestration: {
        chain: [{ step: "execute", command: "execute", status: "pending", run_id: null }],
      },
    });
    const snapshot = await loadCanonicalSnapshot(root);
    assert.equal(snapshot.source, "canonical");
    assert.equal(snapshot.canonicalClaim?.status, "valid");
    assert.equal(snapshot.canonicalClaim?.activeSessionId, sessionId);
    assert.equal(snapshot.session?.sessionId, sessionId);
    assert.match(snapshot.diagnostics.join("\n"), /resolved canonical Session/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge does not fall back to a running projection with only an active Run and no pending step", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-fallback-active-run-"));
  const sessionId = "20260717-fallback-run";
  const runId = "20260717-001-execute";
  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  try {
    await mkdir(join(sessionDir, "runs", runId), { recursive: true });
    await writeJson(join(root, ".workflow", "state.json"), {
      version: "2.0",
      active_session_id: null,
      sessions: [{ session_id: sessionId, intent: "Active Run target", status: "running" }],
    });
    await writeJson(join(sessionDir, "session.json"), {
      schema_version: "session/1.1",
      session_id: sessionId,
      intent: "Active Run target",
      status: "running",
      revision: 2,
      active_run_id: runId,
      orchestration: { chain: [] },
    });
    await writeJson(join(sessionDir, "runs", runId, "run.json"), {
      schema_version: "run/1.1",
      run_id: runId,
      parent_run_id: null,
      command: "execute",
      status: "running",
      goal: "Execute",
      input: { args: [], consumes: [] },
      gates: [],
      primary: null,
      handoff: null,
      started_at: "2026-07-17T00:00:00.000Z",
      ended_at: null,
    });
    const snapshot = await loadCanonicalSnapshot(root);
    // The CLI resolveSession only picks the unique running Session with a
    // pending chain step; an active Run alone is not a canonical binding
    // target, so the bridge must not invent one either.
    assert.equal(snapshot.source, "none");
    assert.equal(snapshot.session, undefined);
    assert.match(snapshot.diagnostics.join("\n"), /no pending chain step/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge refuses fallback when multiple running Session projections are ambiguous", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-fallback-ambiguous-"));
  try {
    for (const sessionId of ["20260717-a", "20260717-b"]) {
      await mkdir(join(root, ".workflow", "sessions", sessionId), { recursive: true });
      await writeJson(join(root, ".workflow", "sessions", sessionId, "session.json"), {
        schema_version: "session/1.1",
        session_id: sessionId,
        intent: `Session ${sessionId}`,
        status: "running",
        revision: 1,
        active_run_id: null,
        orchestration: { chain: [{ step: "execute", command: "execute", status: "pending", run_id: null }] },
      });
    }
    await writeJson(join(root, ".workflow", "state.json"), {
      version: "2.0",
      active_session_id: null,
      sessions: [
        { session_id: "20260717-a", intent: "A", status: "running" },
        { session_id: "20260717-b", intent: "B", status: "running" },
      ],
    });
    const snapshot = await loadCanonicalSnapshot(root);
    assert.equal(snapshot.source, "none");
    assert.equal(snapshot.session, undefined);
    assert.match(snapshot.diagnostics.join("\n"), /ambiguous/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge refuses fallback when the running projection is idle or not running on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-fallback-idle-"));
  const sessionId = "20260717-idle";
  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeJson(join(root, ".workflow", "state.json"), {
      version: "2.0",
      active_session_id: null,
      sessions: [{ session_id: sessionId, intent: "Idle", status: "running" }],
    });
    await writeJson(join(sessionDir, "session.json"), {
      schema_version: "session/1.1",
      session_id: sessionId,
      intent: "Idle",
      status: "running",
      revision: 1,
      active_run_id: null,
      orchestration: { chain: [] },
    });
    const idle = await loadCanonicalSnapshot(root);
    assert.equal(idle.source, "none");
    assert.match(idle.diagnostics.join("\n"), /no pending chain step/);

    await writeJson(join(sessionDir, "session.json"), {
      schema_version: "session/1.1",
      session_id: sessionId,
      intent: "Idle",
      status: "sealed",
      revision: 2,
      active_run_id: null,
      orchestration: { chain: [] },
    });
    const sealed = await loadCanonicalSnapshot(root);
    assert.equal(sealed.source, "none");
    assert.match(sealed.diagnostics.join("\n"), /not running on disk/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge falls back to legacy status without writing canonical files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-legacy-"));
  try {
    const legacyDir = join(root, ".workflow", ".maestro", "ralph");
    await mkdir(legacyDir, { recursive: true });
    await writeJson(join(legacyDir, "status.json"), {
      intent: "Legacy workflow",
      status: "running",
      revision: 3,
      steps: [{ id: "S1", command: "analyze", status: "pending" }],
    });
    const snapshot = await loadCanonicalSnapshot(root);
    assert.equal(snapshot.source, "legacy");
    assert.equal(snapshot.session?.sessionId, "legacy-ralph");
    assert.equal(snapshot.session?.chain[0]?.command, "analyze");
    assert.equal(snapshot.execution, undefined, "the pre-Session legacy fallback keeps its historical shape");
    assert.match(snapshot.diagnostics.join("\n"), /legacy workflow projection/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a present malformed canonical state is authoritative invalid and never falls back to legacy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-invalid-state-"));
  try {
    const workflowDir = join(root, ".workflow");
    const legacyDir = join(workflowDir, ".maestro", "legacy");
    await mkdir(legacyDir, { recursive: true });
    await writeJson(join(legacyDir, "status.json"), {
      intent: "Legacy state must not shadow malformed canonical state",
      status: "running",
    });

    for (const invalidState of ["{ broken json", "[]"]) {
      await writeFile(join(workflowDir, "state.json"), invalidState, "utf8");
      const snapshot = await loadCanonicalSnapshot(root);
      assert.equal(snapshot.source, "canonical");
      assert.equal(snapshot.session, undefined);
      assert.equal(snapshot.canonicalClaim?.status, "invalid");
      assert.match(snapshot.canonicalClaim?.error ?? "", /JSON|must contain a JSON object/i);
      assert.ok(!/Using legacy workflow projection/i.test(snapshot.diagnostics.join("\n")), "canonical malformed state must not fall back to legacy");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an active canonical claim is authoritative when its Session is missing, malformed, or mismatched", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-invalid-claim-"));
  const sessionId = "20260716-authoritative";
  const sessionPath = join(root, ".workflow", "sessions", sessionId, "session.json");
  try {
    await mkdir(join(root, ".workflow", "sessions", sessionId), { recursive: true });
    await mkdir(join(root, ".workflow", ".maestro", "legacy"), { recursive: true });
    await writeJson(join(root, ".workflow", "state.json"), { active_session_id: sessionId });
    await writeJson(join(root, ".workflow", ".maestro", "legacy", "status.json"), {
      intent: "Must not shadow the canonical claim",
      status: "running",
    });

    const missing = await loadCanonicalSnapshot(root);
    assert.equal(missing.source, "canonical");
    assert.equal(missing.session, undefined);
    assert.equal(missing.canonicalClaim?.status, "invalid");
    assert.equal(missing.canonicalClaim?.activeSessionId, sessionId);
    assert.match(missing.sessionGeneration ?? "", /^canonical:invalid:/);

    await writeFile(sessionPath, "{ broken json", "utf8");
    const malformed = await loadCanonicalSnapshot(root);
    assert.equal(malformed.source, "canonical");
    assert.equal(malformed.canonicalClaim?.status, "invalid");
    assert.match(malformed.canonicalClaim?.error ?? "", /JSON/i);

    await writeJson(sessionPath, {
      session_id: "different-session",
      status: "running",
      intent: "Mismatched identity",
    });
    const mismatched = await loadCanonicalSnapshot(root);
    assert.equal(mismatched.source, "canonical");
    assert.equal(mismatched.canonicalClaim?.status, "invalid");
    assert.match(mismatched.canonicalClaim?.error ?? "", /identity mismatch/i);

    await writeJson(sessionPath, {
      session_id: sessionId,
      status: "running",
      intent: "Valid identity",
      identity_revision: 3,
    });
    const valid = await loadCanonicalSnapshot(root);
    assert.equal(valid.canonicalClaim?.status, "valid");
    assert.equal(valid.session?.sessionId, sessionId);
    assert.equal(valid.sessionGeneration, `canonical:valid:${sessionId}:0`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge normalizes live Maestro 0.5.50 session/1.0 records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-live-v1-"));
  const sessionId = "20260715-live-v1";
  const runId = "20260715-004-execute";
  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  try {
    await mkdir(join(sessionDir, "runs", runId), { recursive: true });
    await writeJson(join(root, ".workflow", "state.json"), {
      version: "2.0",
      active_session_id: sessionId,
      sessions: [],
    });
    await writeJson(join(sessionDir, "session.json"), {
      schema_version: "session/1.0",
      session_id: sessionId,
      execution_id: "legacy-execution-4",
      generation: 4,
      intent: "Exercise the live schema",
      status: "running",
      revision: 2,
      identity_revision: 11,
      activity_revision: 17,
      active_run_id: runId,
      gate_ids: ["GATE-S-01"],
      boundary_contract: { definition_of_done: "Live schema is normalized" },
      orchestration: {
        chain: [{ step: "execute", command: "execute", status: "completed", run_id: runId }],
      },
    });
    await writeJson(join(sessionDir, "gates.json"), {
      schema_version: "gate-registry/1.0",
      revision: 9,
      records: {
        "GATE-S-01": {
          id: "GATE-S-01",
          run_id: null,
          phase: "session",
          blocking: true,
          status: "passed",
        },
        "GATE-004-01": {
          id: "GATE-004-01",
          run_id: runId,
          phase: "entry",
          blocking: true,
          status: "passed",
        },
        "GATE-004-02": {
          id: "GATE-004-02",
          run_id: runId,
          phase: "exit",
          blocking: true,
          status: "passed",
        },
      },
    });
    await writeJson(join(sessionDir, "runs", runId, "run.json"), {
      schema_version: "command-run/1.0",
      run_id: runId,
      parent_run_id: "20260715-003-execute",
      command: { name: "execute", args: ["--scope", "core"] },
      status: "sealed",
      goal: "Implement the live schema",
      input: { consumes: ["artifact-old"] },
      gate_ids: ["GATE-004-01", "GATE-004-02"],
      output: { primary_artifact_id: "artifact-live" },
      handoff: { summary: "Live execution complete" },
      started_at: "2026-07-15T02:00:00.000Z",
      completed_at: "2026-07-15T02:10:00.000Z",
      sealed_at: "2026-07-15T02:11:00.000Z",
    });
    await writeJson(join(sessionDir, "artifacts.json"), {
      schema_version: "artifact-registry/1.0",
      records: {
        "artifact-live": {
          kind: "implementation",
          role: "primary",
          producer_run_id: runId,
          relative_path: "outputs/implementation.json",
          content_hash: "live-hash",
          status: "sealed",
          replaces: "artifact-old",
        },
      },
      aliases: { "current-implementation": "artifact-live" },
    });

    const snapshot = await loadCanonicalSnapshot(root);
    const session = snapshot.session!;
    const run = session.runs[0]!;
    const artifact = session.artifacts[0]!;
    assert.equal(snapshot.source, "canonical");
    assert.equal(session.schemaVersion, "session/1.0");
    assert.equal(session.activityRevision, 17);
    assert.equal(session.revision, 17);
    assert.equal(snapshot.execution?.legacyProjection, true);
    assert.equal(snapshot.execution?.executionId, "legacy-execution-4");
    assert.equal(snapshot.execution?.generation, 4);
    assert.equal(snapshot.execution?.revision, 17);
    assert.equal(snapshot.execution?.status, "active");
    assert.deepEqual(snapshot.locator, {
      sessionId,
      executionId: "legacy-execution-4",
      generation: 4,
      runId,
    });
    assert.equal(snapshot.revision.executionRevision, 17);
    assert.equal(run.schemaVersion, "command-run/1.0");
    assert.equal(run.command, "execute");
    assert.deepEqual(run.args, ["--scope", "core"]);
    assert.equal(run.primaryArtifactId, "artifact-live");
    assert.equal(run.endedAt, "2026-07-15T02:11:00.000Z");
    assert.deepEqual(run.gates, [], "registry-linked gate_ids no longer resolve after gates.json retirement");
    assert.equal(artifact.runId, runId);
    assert.equal(artifact.path, "outputs/implementation.json");
    assert.equal(artifact.hash, "live-hash");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge projects a session/3.0 layout with chain/activeRun and no Execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-v3-projection-"));
  const sessionId = "20260812-v3-session";
  const runAnalyze = "20260812-001-analyze";
  const runImplement = "20260812-002-implement";
  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  try {
    await writeV30Fixture(root, sessionId);

    const snapshot = await loadCanonicalSnapshot(root);
    assert.equal(snapshot.source, "canonical");
    assert.equal(snapshot.canonicalClaim?.status, "valid");
    const session = snapshot.session!;
    assert.equal(session.schemaVersion, "session/3.0");
    assert.equal(session.sessionId, sessionId);
    assert.equal(session.intent, "Migrate to session/3.0");
    assert.equal(session.status, "running", "session/3.0 open maps to running");
    assert.equal(session.definitionOfDone, "All gates pass");
    assert.equal(session.activityRevision, 9);
    assert.equal(session.revision, 9, "revision is the max of orchestration/activity revisions");
    assert.equal(session.activeRunId, runImplement, "the first active_run_ids entry wins");
    assert.equal(session.runs.length, 2);
    assert.equal(session.chain.length, 2);
    assert.deepEqual(session.chain[0], {
      step: "analyze",
      command: "analyze",
      status: "completed",
      runId: runAnalyze,
    });
    assert.deepEqual(session.chain[1], {
      step: "implement",
      command: "implement",
      status: "running",
      runId: runImplement,
    });
    const implementRun = session.runs.find((run) => run.runId === runImplement)!;
    assert.equal(implementRun.schemaVersion, "run/3.0");
    assert.equal(implementRun.command, "implement");
    assert.deepEqual(implementRun.args, ["--scope", "core"]);
    assert.equal(implementRun.status, "running");
    assert.equal(implementRun.goal, "Implement the migration");
    assert.equal(implementRun.primaryArtifactId, "artifact-v3");
    assert.equal(implementRun.parentRunId, runAnalyze);
    assert.deepEqual(implementRun.gates, [], "run/3.0 carries no gate registry after gates.json retirement");
    assert.equal(session.artifacts[0]?.artifactId, "artifact-v3");
    assert.equal(session.artifacts[0]?.path, "outputs/implementation.json");
    assert.equal(session.aliases["current-implementation"], "artifact-v3");
    assert.equal(snapshot.execution, undefined, "session/3.0 must not produce an Execution projection");
    assert.deepEqual(snapshot.locator, { sessionId, runId: runImplement });
    assert.equal(snapshot.revision.executionRevision, undefined);
    assert.equal(snapshot.sessionGeneration, `canonical:valid:${sessionId}:9`);
    const specs = buildTodoMirrorSpecs(snapshot);
    assert.equal(specs[0]?.status, "completed");
    assert.equal(specs[1]?.status, "in_progress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge v3 fingerprint and status mapping track session state changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-v3-fingerprint-"));
  const sessionId = "20260812-v3-fingerprint";
  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  try {
    await writeV30Fixture(root, sessionId, { status: "open" });
    const open = await loadCanonicalSnapshot(root);
    assert.equal(open.session?.status, "running", "session/3.0 open maps to running");

    await writeV30Fixture(root, sessionId, { status: "completed" });
    const completed = await loadCanonicalSnapshot(root);
    assert.equal(completed.session?.status, "sealed", "session/3.0 completed maps to sealed");
    assert.notEqual(completed.revision.fingerprint, open.revision.fingerprint);
    assert.equal(completed.revision.sessionRevision, 9);

    await writeV30Fixture(root, sessionId, { status: "archived" });
    const archived = await loadCanonicalSnapshot(root);
    assert.equal(archived.session?.status, "archived");

    await writeV30Fixture(root, sessionId, { status: "failed" });
    const failed = await loadCanonicalSnapshot(root);
    assert.equal(failed.session?.status, "failed");

    // Run state changes must also move the fingerprint (run.json feeds it).
    await writeV30Fixture(root, sessionId, { status: "open" }, {
      [runKey(sessionId, "20260812-001-analyze")]: { status: "cancelled" },
    });
    const cancelled = await loadCanonicalSnapshot(root);
    assert.equal(cancelled.session?.runs[0]?.status, "sealed", "run/3.0 cancelled maps to sealed");
    assert.notEqual(cancelled.revision.fingerprint, failed.revision.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge discriminates session/3.0 from the v2 layout by schema_version", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-v3-discrimination-"));
  const sessionId = "20260812-v3-discrimination";
  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  try {
    await mkdir(join(sessionDir, "runs", "20260812-001-v2run"), { recursive: true });
    await writeJson(join(root, ".workflow", "state.json"), {
      version: "2.0",
      active_session_id: sessionId,
      sessions: [],
    });
    const base = {
      session_id: sessionId,
      intent: "Discriminate layouts",
      identity_revision: 1,
      activity_revision: 1,
    };

    // session/2.0 (statusless, execution-derived) stays on the v2 read path.
    await writeJson(join(sessionDir, "session.json"), {
      schema_version: "session/2.0",
      ...base,
      current_execution_id: null,
      latest_execution_id: null,
      latest_completed_run_id: null,
      archived_at: null,
      archived_by: null,
    });
    const v2 = await loadCanonicalSnapshot(root);
    assert.equal(v2.session?.schemaVersion, "session/2.0");
    assert.equal(Object.prototype.hasOwnProperty.call(v2.session, "status"), false);
    assert.equal(v2.session?.lifecycleAuthority, "execution-derived");

    // session/3.0 in the same directory diverts to the v3 projection.
    await writeJson(join(sessionDir, "session.json"), {
      schema_version: "session/3.0",
      session_id: sessionId,
      objective: "Discriminate layouts",
      definition_of_done: "",
      status: "open",
      identity_revision: 1,
      orchestration_revision: 1,
      activity_revision: 1,
      chain: [],
      decisions: [],
      active_run_ids: [],
      artifacts_ref: "artifacts.json",
      evidence_ref: "evidence.json",
      created_at: "2026-08-12T00:00:00.000Z",
      updated_at: "2026-08-12T00:00:00.000Z",
      completed_at: null,
      archived_at: null,
    });
    const v3 = await loadCanonicalSnapshot(root);
    assert.equal(v3.session?.schemaVersion, "session/3.0");
    assert.equal(v3.session?.status, "running");
    assert.equal(v3.execution, undefined);
    assert.deepEqual(v3.locator, { sessionId });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge reports an invalid session/3.0 record without an Execution fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-v3-invalid-"));
  const sessionId = "20260812-v3-invalid";
  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeJson(join(root, ".workflow", "state.json"), {
      version: "3.0",
      active_session_id: sessionId,
      sessions: [],
    });
    await writeJson(join(sessionDir, "session.json"), {
      schema_version: "session/3.0",
      session_id: sessionId,
      objective: "Invalid v3",
      status: "open",
      identity_revision: 1,
      orchestration_revision: 1,
      activity_revision: -1,
      chain: [],
      active_run_ids: [],
      artifacts_ref: "artifacts.json",
      evidence_ref: "evidence.json",
    });
    const snapshot = await loadCanonicalSnapshot(root);
    assert.equal(snapshot.source, "canonical");
    assert.equal(snapshot.canonicalClaim?.status, "invalid");
    assert.equal(snapshot.session, undefined);
    assert.equal(snapshot.execution, undefined);
    assert.match(snapshot.diagnostics.join("\n"), /invalid session\/3\.0 record/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("entry gate failures keep the canonical Todo mirror pending", async () => {
  for (const gateStatus of ["failed", "blocked"] as const) {
    const snapshot = mirrorSnapshot({
      runStatus: "blocked",
      chainStatus: "blocked",
      gatePhase: "entry",
      gateStatus,
    });

    assert.equal(buildTodoMirrorSpecs(snapshot)[0]?.status, "pending", gateStatus);
  }

  const unphasedLegacyGate = mirrorSnapshot({
    runStatus: "blocked",
    chainStatus: "blocked",
    gatePhase: "entry",
    gateStatus: "failed",
  });
  delete unphasedLegacyGate.session!.runs[0]!.gates[0]!.phase;
  assert.equal(buildTodoMirrorSpecs(unphasedLegacyGate)[0]?.status, "blocked", "unknown gate phase fails closed");
});

test("exit gate failures keep completed work uncompleted in the Todo mirror", async () => {
  const snapshot = mirrorSnapshot({
    runStatus: "completed",
    chainStatus: "completed",
    gatePhase: "exit",
    gateStatus: "failed",
  });

  assert.equal(snapshot.session?.runs[0]?.status, "completed");
  assert.notEqual(snapshot.session?.runs[0]?.status, "sealed");
  assert.equal(buildTodoMirrorSpecs(snapshot)[0]?.status, "blocked");
});

test("an active canonical Run without an orchestration chain still gets a recoverable Todo mirror", () => {
  const snapshot = mirrorSnapshot({
    runStatus: "blocked",
    chainStatus: "blocked",
    gatePhase: "entry",
    gateStatus: "blocked",
  });
  snapshot.session!.chain = [];
  snapshot.session!.runs[0]!.status = "running";
  snapshot.session!.runs[0]!.gates = [];

  const [mirror] = buildTodoMirrorSpecs(snapshot);
  assert.equal(mirror?.origin.runId, "run-gate");
  assert.equal(mirror?.status, "in_progress");

  snapshot.session!.chain = [{
    step: "execute",
    command: "execute",
    status: "running",
    runId: "run-gate",
    skill: "maestro",
  }];
  const [chainMirror] = buildTodoMirrorSpecs(snapshot);
  assert.deepEqual(chainMirror?.origin, mirror?.origin, "the same Run keeps one mirror identity when the chain catches up");
});

test("exit gate failure on the active Run leaves historical completed Todo mirrors completed", () => {
  const snapshot = mirrorSnapshot({
    runStatus: "completed",
    chainStatus: "completed",
    gatePhase: "exit",
    gateStatus: "failed",
  });
  const session = snapshot.session!;
  const active = session.runs[0]!;
  session.runs.unshift({ ...active, runId: "run-history", status: "sealed", gates: [] });
  session.chain.unshift({ step: "analyze", command: "analyze", status: "completed", runId: "run-history" });

  assert.deepEqual(buildTodoMirrorSpecs(snapshot).map((spec) => spec.status), ["completed", "blocked"]);
});

function mirrorSnapshot(options: {
  runStatus: "blocked" | "completed";
  chainStatus: string;
  gatePhase: "entry" | "exit";
  gateStatus: "failed" | "blocked";
}) {
  return {
    source: "canonical" as const,
    projectRoot: "D:/workspace",
    loadedAt: "2026-07-15T00:00:00.000Z",
    revision: { sessionRevision: 1, fingerprint: "mirror-gate" },
    diagnostics: [],
    session: {
      sessionId: "session-gate",
      intent: "Verify gate projection",
      status: "running" as const,
      revision: 1,
      activeRunId: "run-gate",
      definitionOfDone: "All gates pass",
      gates: [],
      chain: [{
        step: "execute",
        command: "execute",
        status: options.chainStatus,
        runId: "run-gate",
      }],
      runs: [{
        runId: "run-gate",
        parentRunId: null,
        command: "execute",
        status: options.runStatus,
        goal: "Execute",
        args: [],
        gates: [{
          id: "gate-run",
          phase: options.gatePhase,
          blocking: true,
          status: options.gateStatus,
        }],
        primaryArtifactId: null,
        handoff: null,
        startedAt: "2026-07-15T00:00:00.000Z",
        endedAt: options.runStatus === "completed" ? "2026-07-15T00:01:00.000Z" : null,
      }],
      artifacts: [],
      aliases: {},
    },
  };
}

function bridgeSnapshot(fingerprint: string): WorkflowSnapshot {
  return {
    source: "none",
    projectRoot: "D:/workspace",
    loadedAt: `2026-07-16T00:00:0${fingerprint === "older" ? "1" : "2"}.000Z`,
    revision: { fingerprint },
    diagnostics: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function settleAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function writeExecutionSelectionFixture(
  root: string,
  sessionId: string,
  sessionOverrides: Record<string, unknown> = {},
): Promise<void> {  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  await mkdir(join(sessionDir, "executions", "execution-0001"), { recursive: true });
  await mkdir(join(sessionDir, "executions", "execution-0002"), { recursive: true });
  await writeJson(join(root, ".workflow", "state.json"), {
    version: "2.0",
    active_session_id: sessionId,
    sessions: [],
  });
  await writeJson(join(sessionDir, "session.json"), {
    schema_version: "session/2.0",
    session_id: sessionId,
    intent: "Require an explicit current Execution pointer",
    identity_revision: 4,
    activity_revision: 9,
    current_execution_id: null,
    latest_execution_id: "execution-0002",
    latest_completed_run_id: "20260718-001-analyze",
    archived_at: null,
    archived_by: null,
    ...sessionOverrides,
  });
  for (const generation of [1, 2]) {
    const executionId = `execution-000${generation}`;
    await writeJson(join(sessionDir, "executions", executionId, "execution.json"), {
      schema_version: "execution/1.0",
      execution_id: executionId,
      session_id: sessionId,
      generation,
      status: generation === 1 ? "sealed" : "active",
      revision: generation,
      active_run_id: null,
      chain: [],
      decision_points: [],
      lease: null,
    });
  }
}

function runKey(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

/**
 * Writes a session/3.0 layout fixture: state.json + session.json
 * (session/3.0) + runs/<run_id>/run.json (run/3.0) + artifacts.json
 * (artifacts/1.0) + evidence.json (evidence/1.0). sessionOverrides replace
 * session.json fields; runOverrides are keyed by `${sessionId}:${runId}` and
 * replace run.json fields.
 */
async function writeV30Fixture(
  root: string,
  sessionId: string,
  sessionOverrides: Record<string, unknown> = {},
  runOverrides: Record<string, Record<string, unknown>> = {},
): Promise<void> {
  const sessionDir = join(root, ".workflow", "sessions", sessionId);
  const runAnalyze = "20260812-001-analyze";
  const runImplement = "20260812-002-implement";
  await mkdir(join(sessionDir, "runs", runAnalyze), { recursive: true });
  await mkdir(join(sessionDir, "runs", runImplement), { recursive: true });
  await writeJson(join(root, ".workflow", "state.json"), {
    version: "3.0",
    active_session_id: sessionId,
    sessions: [],
  });
  await writeJson(join(sessionDir, "session.json"), {
    schema_version: "session/3.0",
    session_id: sessionId,
    objective: "Migrate to session/3.0",
    definition_of_done: "All gates pass",
    status: "open",
    orchestration_revision: 5,
    activity_revision: 9,
    chain: [
      {
        step_id: "analyze",
        command: "analyze",
        args: [],
        status: "completed",
        run_ids: [runAnalyze],
        goal_ref: null,
        decision_refs: [],
      },
      {
        step_id: "implement",
        command: "implement",
        args: ["--scope", "core"],
        status: "running",
        run_ids: [runImplement],
        goal_ref: null,
        decision_refs: ["decision-1"],
      },
    ],
    decisions: [{
      decision_id: "decision-1",
      after_step_id: "analyze",
      status: "open",
      evidence_refs: [],
    }],
    active_run_ids: [runImplement, "20260812-003-extra"],
    artifacts_ref: "artifacts.json",
    evidence_ref: "evidence.json",
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T01:00:00.000Z",
    completed_at: null,
    archived_at: null,
    ...sessionOverrides,
  });
  await writeJson(join(sessionDir, "runs", runAnalyze, "run.json"), {
    schema_version: "run/3.0",
    run_id: runAnalyze,
    session_id: sessionId,
    step_id: "analyze",
    parent_run_id: null,
    retry_of_run_id: null,
    attempt: 1,
    command: "analyze",
    args: [],
    goal: "Analyze the migration",
    status: "completed",
    revision: 2,
    actor_id: "pi-actor",
    input_refs: [],
    output_refs: [],
    primary_artifact_id: null,
    verdict: "done",
    summary: "Analysis complete",
    created_at: "2026-08-12T00:05:00.000Z",
    started_at: "2026-08-12T00:06:00.000Z",
    ended_at: "2026-08-12T00:20:00.000Z",
    sealed_at: "2026-08-12T00:21:00.000Z",
    ...(runOverrides[runKey(sessionId, runAnalyze)] ?? {}),
  });
  await writeJson(join(sessionDir, "runs", runImplement, "run.json"), {
    schema_version: "run/3.0",
    run_id: runImplement,
    session_id: sessionId,
    step_id: "implement",
    parent_run_id: runAnalyze,
    retry_of_run_id: null,
    attempt: 1,
    command: "implement",
    args: ["--scope", "core"],
    goal: "Implement the migration",
    status: "running",
    revision: 4,
    actor_id: "pi-actor",
    input_refs: [],
    output_refs: [],
    primary_artifact_id: "artifact-v3",
    verdict: null,
    summary: null,
    created_at: "2026-08-12T00:30:00.000Z",
    started_at: "2026-08-12T00:31:00.000Z",
    ended_at: null,
    sealed_at: null,
    ...(runOverrides[runKey(sessionId, runImplement)] ?? {}),
  });
  await writeJson(join(sessionDir, "artifacts.json"), {
    schema_version: "artifacts/1.0",
    revision: 1,
    artifacts: {
      "artifact-v3": {
        kind: "implementation",
        role: "primary",
        producer_run_id: runImplement,
        relative_path: "outputs/implementation.json",
        media_type: "application/json",
        schema_version: "artifact/1.0",
        content_hash: "v3-hash",
        size: 128,
        status: "draft",
        derived_from: [],
        replaces: null,
      },
    },
    aliases: { "current-implementation": "artifact-v3" },
  });
  await writeJson(join(sessionDir, "evidence.json"), {
    schema_version: "evidence/1.0",
    revision: 1,
    records: {
      "evidence-1": {
        run_id: runAnalyze,
        command: "analyze",
        kind: "analysis",
        point: "analyze",
        claim: "Migration analyzed",
        outcome: "passed",
        rationale: "Fixture evidence",
        status: "accepted",
        artifact_refs: [],
        gate_refs: ["GATE-001-01"],
        source_refs: [],
      },
    },
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
