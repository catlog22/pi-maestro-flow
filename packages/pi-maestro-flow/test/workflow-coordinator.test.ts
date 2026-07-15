import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunCliAdapter, type RunCliResult } from "../src/session/cli-adapter.ts";
import {
  WorkflowCoordinator,
  WorkflowLeaseBusyError,
  WorkflowLeaseStore,
  type WorkflowRunAdapter,
  type WorkflowSnapshotProvider,
} from "../src/session/coordinator.ts";
import type { WorkflowSnapshot } from "../src/session/types.ts";

test("coordinator attaches brief-first and fences old continuation markers on retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-coordinator-"));
  const snapshot = workflowSnapshot("running");
  const bridge = fakeBridge(snapshot);
  const calls: string[][] = [];
  const adapter = fakeAdapter(calls, { retryViaParentRun: true, cancel: false });
  const coordinator = new WorkflowCoordinator(bridge, adapter, new WorkflowLeaseStore(root));
  try {
    const attached = await coordinator.attach("host-1");
    assert.equal(attached.brief?.stdout, "brief run-1");
    assert.deepEqual(calls[0], ["brief", "run-1", "session-1"]);

    const marker = coordinator.continuationMarker(3);
    assert.equal(coordinator.acceptsContinuation(marker), true);
    await coordinator.fenceContinuation();
    assert.equal(coordinator.acceptsContinuation(marker), false);
    const retryMarker = coordinator.continuationMarker(4);

    snapshot.session!.runs[0]!.status = "failed";
    const retried = await coordinator.retry("run-1");
    assert.equal(retried.command.stdout, "created execute");
    assert.equal(coordinator.acceptsContinuation(retryMarker), false);
    assert.deepEqual(calls.at(-1), ["create", "execute", "session-1", "run-1", "--scope", "core"]);

    const cancel = coordinator.cancel("run-1");
    await assert.rejects(cancel, /does not expose canonical run cancel/);
  } finally {
    await coordinator.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("lease allows one live owner and permits stale takeover with a higher epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-lease-"));
  let now = new Date("2026-07-15T00:00:00.000Z");
  const clock = () => now;
  const first = new WorkflowLeaseStore(root, 1_000, clock);
  const second = new WorkflowLeaseStore(root, 1_000, clock);
  try {
    const original = await first.acquire("session-1", "host-1");
    await assert.rejects(second.acquire("session-1", "host-2"), WorkflowLeaseBusyError);
    now = new Date("2026-07-15T00:00:02.000Z");
    const replacement = await second.acquire("session-1", "host-2");
    assert.ok(replacement.epoch > original.epoch);
    await first.release();
    assert.equal((await second.heartbeat()).token, replacement.token);
  } finally {
    await second.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI adapter detects parent-run retry and rejects unsupported cancel", async () => {
  const calls: string[][] = [];
  const adapter = new RunCliAdapter("D:/workspace", async (args) => {
    calls.push([...args]);
    if (args.join(" ") === "run --help") {
      return result(args, "Commands:\n  prepare <step>\n  create <command>\n  complete <run-id>\n  brief <run-id>\n");
    }
    if (args.join(" ") === "run create --help") return result(args, "Options:\n  --parent-run <id>\n");
    return result(args, "created");
  });

  const capabilities = await adapter.capabilities();
  assert.equal(capabilities.retryViaParentRun, true);
  assert.equal(capabilities.cancel, false);
  await adapter.create("execute", ["--scope", "core"], { sessionId: "session-1", parentRunId: "run-1" });
  assert.deepEqual(calls.at(-1), [
    "run", "create", "execute", "--session", "session-1", "--parent-run", "run-1",
    "--arg", "--scope", "--arg", "core", "--workflow-root", "D:/workspace",
  ]);
  await assert.rejects(adapter.cancel("run-1"), /does not support run capability: cancel/);
});

function fakeBridge(snapshot: WorkflowSnapshot): WorkflowSnapshotProvider {
  return {
    async refresh() { return snapshot; },
    getSnapshot() { return snapshot; },
  };
}

function fakeAdapter(
  calls: string[][],
  capabilities: { retryViaParentRun: boolean; cancel: boolean },
): WorkflowRunAdapter {
  return {
    async capabilities() {
      return {
        commands: new Set(["prepare", "create", "brief", "complete"]),
        retryViaParentRun: capabilities.retryViaParentRun,
        cancel: capabilities.cancel,
      };
    },
    async prepare(step) { calls.push(["prepare", step]); return result([], `prepare ${step}`); },
    async brief(runId, sessionId) { calls.push(["brief", runId, sessionId ?? ""]); return result([], `brief ${runId}`); },
    async create(command, args = [], options = {}) {
      calls.push(["create", command, options.sessionId ?? "", options.parentRunId ?? "", ...args]);
      return result([], `created ${command}`);
    },
    async complete(runId, sessionId) { calls.push(["complete", runId, sessionId ?? ""]); return result([], `complete ${runId}`); },
    async cancel(runId, sessionId) { calls.push(["cancel", runId, sessionId ?? ""]); return result([], `cancel ${runId}`); },
  };
}

function workflowSnapshot(status: "running" | "failed"): WorkflowSnapshot {
  return {
    source: "canonical",
    projectRoot: "D:/workspace",
    loadedAt: "2026-07-15T00:00:00.000Z",
    revision: { sessionRevision: 1, fingerprint: "fingerprint" },
    diagnostics: [],
    session: {
      sessionId: "session-1",
      intent: "Complete integration",
      status: "running",
      revision: 1,
      activeRunId: "run-1",
      definitionOfDone: "done",
      gates: [],
      chain: [{ step: "execute", command: "execute", status, runId: "run-1" }],
      runs: [{
        runId: "run-1",
        parentRunId: null,
        command: "execute",
        status,
        goal: "execute",
        args: ["--scope", "core"],
        gates: [],
        primaryArtifactId: null,
        handoff: null,
        startedAt: "2026-07-15T00:00:00.000Z",
        endedAt: null,
      }],
      artifacts: [],
      aliases: {},
    },
  };
}

function result(args: readonly string[], stdout: string): RunCliResult {
  return { argv: [...args], stdout, stderr: "", exitCode: 0 };
}
