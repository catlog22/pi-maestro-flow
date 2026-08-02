import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startGuiServer } from "../src/gui/gui-server.ts";
import { registerStateRoutes, cloneSerializable } from "../src/gui/gui-state.ts";

async function getJson(port: number, token: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("cloneSerializable drops functions and survives circular refs", () => {
  assert.deepEqual(cloneSerializable({ a: 1, fn: () => 2, sym: Symbol("x") }), { a: 1 });
  assert.equal(cloneSerializable(undefined), null);
  assert.equal(cloneSerializable(null), null);
  const circular: any = { name: "x" };
  circular.self = circular;
  assert.equal(cloneSerializable(circular), null);
  assert.deepEqual(cloneSerializable([1, { b: "c" }]), [1, { b: "c" }]);
});

test("GET /state aggregates providers, clones, and reports mode/session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-state-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    const todosSource = [{ id: "t1", subject: "task", status: "pending" }];
    registerStateRoutes(server, {
      workflow: () => ({ status: "active", run: { runId: "r1" } }),
      todos: () => todosSource,
      goal: () => ({ objective: "ship it", phase: "run" }),
      plan: () => ({ mode: "act", isPlanMode: false, hasPlan: true, text: "# Plan", handoffStatus: "ready" }),
      teammates: async () => [{ name: "explorer", status: "running" }],
      swarm: () => null,
      approvalMode: () => "default",
      sessionId: () => "sess-xyz",
    });

    const resp = await getJson(server.port, server.token, "/state");
    assert.equal(resp.status, 200);
    const state = resp.body.result;
    assert.deepEqual(state.workflow, { status: "active", run: { runId: "r1" } });
    assert.deepEqual(state.todos, todosSource);
    assert.deepEqual(state.goal, { objective: "ship it", phase: "run" });
    assert.equal(state.plan.hasPlan, true);
    assert.deepEqual(state.teammates, [{ name: "explorer", status: "running" }]);
    assert.equal(state.swarm, null);
    assert.equal(state.approvalMode, "default");
    assert.equal(state.sessionId, "sess-xyz");

    // No live references: mutating the response must not touch the source array.
    state.todos.push({ id: "t2", subject: "injected", status: "pending" });
    assert.equal(todosSource.length, 1);
  } finally {
    server.close("done");
  }
});

test("GET /state/:sub returns one subsystem and 404s unknown", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-state-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    registerStateRoutes(server, { goal: () => ({ objective: "x" }) });

    const goal = await getJson(server.port, server.token, "/state/goal");
    assert.equal(goal.status, 200);
    assert.deepEqual(goal.body.result, { goal: { objective: "x" } });

    const missingProvider = await getJson(server.port, server.token, "/state/swarm");
    assert.equal(missingProvider.status, 200);
    assert.deepEqual(missingProvider.body.result, { swarm: null });

    const unknown = await getJson(server.port, server.token, "/state/bogus");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "unknown_subsystem");
  } finally {
    server.close("done");
  }
});

test("GET /state denies missing and replaced active contexts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-state-context-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  const firstCtx = {} as ExtensionContext;
  const secondCtx = {} as ExtensionContext;
  let currentCtx: ExtensionContext | undefined;
  let providerReads = 0;
  let providerStarted!: () => void;
  let releaseProvider!: () => void;
  const started = new Promise<void>((resolve) => { providerStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
  try {
    registerStateRoutes(
      server,
      {
        goal: async () => {
          providerReads += 1;
          providerStarted();
          await release;
          return { departed: true };
        },
      },
      { getCtx: () => currentCtx },
    );

    const missing = await getJson(server.port, server.token, "/state/goal");
    assert.equal(missing.status, 503);
    assert.equal(missing.body.code, "no_context");
    assert.equal(providerReads, 0);

    currentCtx = firstCtx;
    const pending = getJson(server.port, server.token, "/state/goal");
    await started;
    currentCtx = secondCtx;
    releaseProvider();

    const stale = await pending;
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "stale_context");
    assert.equal(stale.body.result, undefined, "departed provider state must not be exposed");
    assert.equal(providerReads, 1);
  } finally {
    releaseProvider();
    server.close("done");
  }
});

test("GET /state tolerates a throwing provider as null", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-state-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  try {
    registerStateRoutes(server, {
      workflow: () => {
        throw new Error("snapshot failed");
      },
      goal: () => ({ objective: "ok" }),
    });
    const resp = await getJson(server.port, server.token, "/state");
    assert.equal(resp.status, 200);
    assert.equal(resp.body.result.workflow, null);
    assert.deepEqual(resp.body.result.goal, { objective: "ok" });
  } finally {
    server.close("done");
  }
});
