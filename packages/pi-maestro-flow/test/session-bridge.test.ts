import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildTodoMirrorSpecs, loadCanonicalSnapshot, WorkflowBridge } from "../src/session/bridge.ts";

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
    assert.match(snapshot.diagnostics.join("\n"), /legacy workflow projection/i);
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
    assert.equal(session.identityRevision, 11);
    assert.equal(session.activityRevision, 17);
    assert.equal(session.revision, 17);
    assert.deepEqual(session.gates.map((gate) => gate.id), ["GATE-S-01"]);
    assert.equal(run.schemaVersion, "command-run/1.0");
    assert.equal(run.command, "execute");
    assert.deepEqual(run.args, ["--scope", "core"]);
    assert.equal(run.primaryArtifactId, "artifact-live");
    assert.equal(run.endedAt, "2026-07-15T02:11:00.000Z");
    assert.deepEqual(run.gates.map((gate) => gate.id), ["GATE-004-01", "GATE-004-02"]);
    assert.equal(artifact.runId, runId);
    assert.equal(artifact.path, "outputs/implementation.json");
    assert.equal(artifact.hash, "live-hash");
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

  const sessionGate = mirrorSnapshot({
    runStatus: "blocked",
    chainStatus: "blocked",
    gatePhase: "entry",
    gateStatus: "failed",
  });
  sessionGate.session!.gates = sessionGate.session!.runs[0]!.gates.splice(0);
  assert.equal(buildTodoMirrorSpecs(sessionGate)[0]?.status, "pending", "session entry gate");
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
