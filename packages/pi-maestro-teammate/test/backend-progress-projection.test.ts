import assert from "node:assert/strict";
import test from "node:test";
import { projectBackendProgress } from "../src/runs/execution.ts";

const AGENT = "general";
const STARTED = 1_700_000_000_000;

test("an empty payload still yields a complete progress record", () => {
  const progress = projectBackendProgress({}, AGENT, STARTED);
  assert.equal(progress.agent, AGENT);
  assert.equal(progress.status, "running");
  assert.deepEqual(progress.recentTools, []);
  assert.equal(progress.toolCount, 0);
  assert.equal(progress.tokens, 0);
  assert.equal(progress.startedAt, STARTED);
  assert.equal(typeof progress.durationMs, "number");
  assert.equal(typeof progress.lastActivityAt, "number");
});

test("host-owned identity is never taken from the payload", () => {
  const progress = projectBackendProgress({ agent: "impostor" }, AGENT, STARTED);
  assert.equal(progress.agent, AGENT);
});

test("a reported status is honoured only when it is a real status", () => {
  assert.equal(projectBackendProgress({ status: "completed" }, AGENT, STARTED).status, "completed");
  assert.equal(projectBackendProgress({ status: "exploded" }, AGENT, STARTED).status, "running");
  assert.equal(projectBackendProgress({ status: 7 }, AGENT, STARTED).status, "running");
});

test("counters reject values that are not finite and non-negative", () => {
  const bad = projectBackendProgress(
    { toolCount: -1, tokens: Number.NaN, startedAt: Number.POSITIVE_INFINITY },
    AGENT,
    STARTED,
  );
  assert.equal(bad.toolCount, 0);
  assert.equal(bad.tokens, 0);
  assert.equal(bad.startedAt, STARTED);
  const good = projectBackendProgress({ toolCount: 3, tokens: 512 }, AGENT, STARTED);
  assert.equal(good.toolCount, 3);
  assert.equal(good.tokens, 512);
});

test("recent tools keep only entries carrying both a name and a status", () => {
  const progress = projectBackendProgress({
    recentTools: [
      { name: "bash", status: "ok", argsPreview: "ls -la" },
      { name: "read" },
      { status: "ok" },
      "not-an-object",
      null,
      { name: "edit", status: "running", argsPreview: 42 },
    ],
  }, AGENT, STARTED);
  assert.deepEqual(progress.recentTools, [
    { name: "bash", status: "ok", argsPreview: "ls -la" },
    { name: "edit", status: "running" },
  ]);
});

test("optional string fields pass through only when they are strings", () => {
  const progress = projectBackendProgress(
    { name: "task-1", correlationId: "c-1", phase: "starting", lastMessage: "done", resolvedModel: 9 },
    AGENT,
    STARTED,
  );
  assert.equal(progress.name, "task-1");
  assert.equal(progress.correlationId, "c-1");
  assert.equal(progress.phase, "starting");
  assert.equal(projectBackendProgress({ phase: "invented" }, AGENT, STARTED).phase, undefined);
  assert.equal(progress.lastMessage, "done");
  assert.equal("resolvedModel" in progress, false);
});

test("a backend that reports its own timing is believed", () => {
  const progress = projectBackendProgress(
    { startedAt: 10, durationMs: 250, lastActivityAt: 260 },
    AGENT,
    STARTED,
  );
  assert.equal(progress.startedAt, 10);
  assert.equal(progress.durationMs, 250);
  assert.equal(progress.lastActivityAt, 260);
});
