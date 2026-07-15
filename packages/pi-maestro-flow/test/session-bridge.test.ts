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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
