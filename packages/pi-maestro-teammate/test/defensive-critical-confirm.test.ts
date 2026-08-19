import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { runSingleTeammate } from "../src/runs/execution.ts";
import {
  createFakeProcess,
  adaptFakeSpawn,
  reclaimFakeProcess,
  type MutableFakeProcess,
} from "./performance-buffers-and-spawn.test.ts";

// CONFIRM tests for the DEF-001/002 false-success fixes.

test("DEF-002: non-JSON stdout with child exit 0 does NOT settle as false success (exitCode 1)", async () => {
  const spawnChildProcess = adaptFakeSpawn((_command, _args) => {
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return reclaimFakeProcess(child); },
    });
    queueMicrotask(() => {
      // Malformed (non-JSON) stdout line — the DEF-002 vulnerability.
      stdout.write("this is not valid JSON and not a real assistant message\n");
      // Child exits 0 with no runtimeFailure event and no agent_settled.
      // Pre-fix: exitCode 0 (false success, malformed text attributed as answer).
      // Post-fix: exitCode 1 (stdoutProtocolViolation forces failure).
      child.emit("close", 0, null);
    });
    return child;
  });

  const result = await runSingleTeammate({
    agent: "general",
    task: "Non-JSON stdout must not be a false success",
    model: "provider/primary",
    context: "fresh",
  }, {
    baseCwd: process.cwd(),
    modelCapabilities: [{ id: "provider/primary" }],
    spawnChildProcess,
  });

  assert.equal(result.exitCode, 1, "non-JSON stdout + child exit 0 must settle as failure, not false success");
  assert.notEqual(result.terminalStatus, "completed", "must not be 'completed'");
});

test("DEF-002 regression: non-JSON stdout with child exit 1 still preserves diagnostics (existing behavior)", async () => {
  const spawnChildProcess = adaptFakeSpawn((_command, _args) => {
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return reclaimFakeProcess(child); },
    });
    queueMicrotask(() => {
      stdout.write("failed to initialize child runtime\n");
      child.emit("close", 1, null);
    });
    return child;
  });

  const result = await runSingleTeammate({
    agent: "general",
    task: "Preserve stdout diagnostics",
    model: "provider/primary",
    context: "fresh",
  }, {
    baseCwd: process.cwd(),
    modelCapabilities: [{ id: "provider/primary" }],
    spawnChildProcess,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.messages.map((m) => m.content).join("\n"), /failed to initialize child runtime/);
});

test("DEF-001: a recurring runtime error across a turn boundary re-sets runtimeFailure (exitCode 1, not false success)", async () => {
  const errorText = "Provider returned error: 503 service unavailable";
  const spawnChildProcess = adaptFakeSpawn((_command, _args) => {
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return reclaimFakeProcess(child); },
    });
    queueMicrotask(() => {
      // First error sets state.runtimeFailure. We do NOT emit agent_settled,
      // so the turn is NOT settled yet and completeTurn's dedup clear has not
      // run. The child then emits turn_start, which triggers onTurnBoundary and
      // clears state.runtimeFailure = undefined. The SAME error text recurs.
      // Pre-fix: dedup suppresses it (reportedRuntimeErrors.has) → exitCode 0
      // (false success, since runtimeFailure is undefined).
      // Post-fix: runtimeFailure is undefined after the boundary clear, so the
      // recurring error re-sets runtimeFailure → exitCode 1.
      stdout.write(`${JSON.stringify({ type: "error", errorMessage: errorText })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
      stdout.write(`${JSON.stringify({ type: "error", errorMessage: errorText })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
    });
    return child;
  });

  const result = await runSingleTeammate({
    agent: "general",
    task: "Recurring provider error across turn boundary",
    model: "provider/primary",
    context: "fork",
  }, {
    baseCwd: process.cwd(),
    modelCapabilities: [{ id: "provider/primary" }],
    spawnChildProcess,
  });

  assert.equal(result.exitCode, 1, "recurring error across a turn boundary must re-set the failure, not settle as false success");
  assert.equal(result.terminalStatus, "failed");
  assert.match(
    result.messages.map((m) => m.content).join("\n"),
    /recurred across turn boundary/,
    "the recurring failure diagnostic must be surfaced",
  );
});
