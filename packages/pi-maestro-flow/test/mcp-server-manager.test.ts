import assert from "node:assert/strict";
import test from "node:test";
import { McpLifecycleManager } from "../src/mcp/lifecycle.ts";
import { McpServerManager } from "../src/mcp/server-manager.ts";
import type { ServerDefinition } from "../src/mcp/types.ts";

const definition = { command: "stub" } as ServerDefinition;

/**
 * Test manager that replaces the real transport/client startup with a
 * controllable deferred, so single-flight, abort isolation, and shutdown
 * fencing can be exercised deterministically without spawning processes.
 */
class TestManager extends McpServerManager {
  creates = 0;
  closes = 0;
  honorAbort = true;
  startupSignals: Array<AbortSignal | undefined> = [];
  private pendingStarts: Array<{ resolve: (connection: unknown) => void; connection: unknown }> = [];

  protected override createConnection(
    name: string,
    serverDefinition: ServerDefinition,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.creates += 1;
    this.startupSignals.push(signal);
    const connection = {
      client: { close: async () => { this.closes += 1; } },
      transport: { close: async () => { this.closes += 1; } },
      definition: serverDefinition,
      tools: [],
      resources: [],
      lastUsedAt: Date.now(),
      inFlight: 0,
      status: "connected",
    };
    return new Promise((resolve, reject) => {
      this.pendingStarts.push({ resolve, connection });
      if (!this.honorAbort) return;
      const onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("startup aborted"));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Settle the oldest pending startup successfully. */
  resolveNext(): void {
    const entry = this.pendingStarts.shift();
    if (entry) entry.resolve(entry.connection);
  }
}

test("MCP shared startup is single-flight and survives the creator aborting its wait", async () => {
  const manager = new TestManager();
  const creatorController = new AbortController();
  const followerController = new AbortController();

  const creatorWait = manager.connect("A", definition, creatorController.signal);
  const followerWait = manager.connect("A", definition, followerController.signal);
  assert.equal(manager.creates, 1, "concurrent connects share one startup");

  // The startup signal is manager-owned, not the creator's signal.
  assert.notEqual(manager.startupSignals[0], creatorController.signal);

  creatorController.abort(new Error("creator gave up"));
  await assert.rejects(creatorWait, /creator gave up/);
  assert.equal(manager.startupSignals[0]?.aborted, false, "creator abort must not cancel the shared startup");
  assert.equal(manager.creates, 1);
  assert.equal(manager.getConnection("A"), undefined);

  manager.resolveNext();
  const followerConnection = await followerWait;
  assert.ok(followerConnection);
  assert.equal(manager.getConnection("A"), followerConnection);
  assert.equal(manager.creates, 1);
});

test("MCP follower abort does not cancel the shared startup", async () => {
  const manager = new TestManager();
  const followerController = new AbortController();

  const creatorWait = manager.connect("A", definition);
  const followerWait = manager.connect("A", definition, followerController.signal);
  assert.equal(manager.creates, 1);

  followerController.abort(new Error("follower left"));
  await assert.rejects(followerWait, /follower left/);
  assert.equal(manager.startupSignals[0]?.aborted, false);

  manager.resolveNext();
  const connection = await creatorWait;
  assert.equal(manager.getConnection("A"), connection);
  assert.equal(manager.creates, 1);
});

test("MCP close fences a pending startup and prevents late insertion", async () => {
  const manager = new TestManager(); // honorAbort: startup cancels when fenced
  const wait = manager.connect("A", definition);
  assert.equal(manager.creates, 1);
  const rejected = assert.rejects(wait, /aborted|closed during startup/);

  await manager.close("A");
  await rejected;

  assert.equal(manager.startupSignals[0]?.aborted, true, "close aborts the manager-owned startup");
  assert.equal(manager.getConnection("A"), undefined, "fenced startup must not insert a connection");
});

test("MCP close reclaims a late resource that settles after fencing", async () => {
  const manager = new TestManager();
  manager.honorAbort = false; // startup ignores abort and completes late
  const wait = manager.connect("A", definition);
  assert.equal(manager.creates, 1);
  const rejected = assert.rejects(wait, /closed during startup/);

  const closePromise = manager.close("A"); // fences, then settles the pending startup
  manager.resolveNext(); // startup completes after the fence
  await closePromise;
  await rejected;

  assert.equal(manager.getConnection("A"), undefined, "late startup must not overwrite the registry");
  assert.equal(manager.closes, 2, "late client and transport are reclaimed");
});

test("MCP keep-alive reconnects use bounded backoff, notify once, and reset after success", async () => {
  let now = 0;
  let attempts = 0;
  let connected = false;
  let shouldFail = true;
  const reconnects: string[] = [];
  const failures: Array<{ attempt: number; nextRetryAt: number }> = [];
  const manager = {
    getConnection() { return connected ? { status: "connected" } : undefined; },
    async connect() {
      attempts += 1;
      if (shouldFail) throw new Error("server unavailable");
      connected = true;
      return { status: "connected" };
    },
    isIdle() { return false; },
    async close() {},
    async closeAll() {},
  } as unknown as McpServerManager;
  const lifecycle = new McpLifecycleManager(manager, {
    now: () => now,
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 1_000,
    reconnectFailureNotifyThreshold: 3,
  });
  lifecycle.markKeepAlive("A", definition);
  lifecycle.setReconnectCallback((name) => reconnects.push(name));
  lifecycle.setReconnectFailureCallback((event) => {
    failures.push({ attempt: event.attempt, nextRetryAt: event.nextRetryAt });
  });

  await lifecycle.runHealthCheck(); // failure 1; next at 100
  await lifecycle.runHealthCheck(); // backoff suppresses duplicate
  assert.equal(attempts, 1);

  now = 100;
  await lifecycle.runHealthCheck(); // failure 2; next at 300
  now = 299;
  await lifecycle.runHealthCheck();
  assert.equal(attempts, 2);

  now = 300;
  await lifecycle.runHealthCheck(); // failure 3; notify; next at 700
  assert.equal(attempts, 3);
  assert.deepEqual(failures, [{ attempt: 3, nextRetryAt: 700 }]);

  shouldFail = false;
  now = 700;
  await lifecycle.runHealthCheck();
  assert.deepEqual(reconnects, ["A"]);

  connected = false;
  shouldFail = true;
  now = 800;
  await lifecycle.runHealthCheck();
  assert.equal(attempts, 5, "a successful reconnect resets the failure/backoff sequence");
  assert.equal(failures.length, 1, "a new failure sequence does not inherit the old notification state");
});

test("MCP keep-alive treats needs-auth as a failed reconnect", async () => {
  const failures: string[] = [];
  const reconnects: string[] = [];
  const manager = {
    getConnection() { return { status: "needs-auth" }; },
    async connect() { return { status: "needs-auth" }; },
    isIdle() { return false; },
    async close() {},
    async closeAll() {},
  } as unknown as McpServerManager;
  const lifecycle = new McpLifecycleManager(manager, {
    reconnectFailureNotifyThreshold: 1,
  });
  lifecycle.markKeepAlive("A", definition);
  lifecycle.setReconnectCallback((name) => reconnects.push(name));
  lifecycle.setReconnectFailureCallback((event) => failures.push(event.error.message));

  await lifecycle.runHealthCheck();

  assert.deepEqual(reconnects, []);
  assert.deepEqual(failures, ["server reported needs-auth"]);
});

test("MCP health checks are single-flight while a reconnect is pending", async () => {
  let attempts = 0;
  let resolveConnect!: () => void;
  const pending = new Promise<void>((resolve) => { resolveConnect = resolve; });
  const manager = {
    getConnection() { return undefined; },
    async connect() {
      attempts += 1;
      await pending;
      return { status: "connected" };
    },
    isIdle() { return false; },
    async close() {},
    async closeAll() {},
  } as unknown as McpServerManager;
  const lifecycle = new McpLifecycleManager(manager);
  lifecycle.markKeepAlive("A", definition);

  const first = lifecycle.runHealthCheck();
  const overlapping = lifecycle.runHealthCheck();
  assert.equal(attempts, 1);
  resolveConnect();
  await Promise.all([first, overlapping]);
  assert.equal(attempts, 1);
});

test("MCP graceful shutdown drains and fences an in-flight health check", async () => {
  let resolveConnect!: () => void;
  const pending = new Promise<void>((resolve) => { resolveConnect = resolve; });
  let reconnects = 0;
  let closes = 0;
  let closeAlls = 0;
  const manager = {
    getConnection() { return undefined; },
    async connect() {
      await pending;
      return { status: "connected" };
    },
    isIdle() { return false; },
    async close() { closes += 1; },
    async closeAll() { closeAlls += 1; },
  } as unknown as McpServerManager;
  const lifecycle = new McpLifecycleManager(manager);
  lifecycle.markKeepAlive("A", definition);
  lifecycle.setReconnectCallback(() => { reconnects += 1; });

  const check = lifecycle.runHealthCheck();
  let shutdownSettled = false;
  const shutdown = lifecycle.gracefulShutdown().then(() => { shutdownSettled = true; });
  await Promise.resolve();
  assert.equal(closeAlls, 1);
  assert.equal(shutdownSettled, false, "shutdown waits for the admitted health check");

  resolveConnect();
  await Promise.all([check, shutdown]);
  assert.equal(reconnects, 0, "stale reconnect must not publish after shutdown");
  assert.equal(closes, 1, "a connection returned after the close fence is reclaimed");
});

test("MCP closeAll fences pending startups that are not yet in the registry", async () => {
  const manager = new TestManager();
  const wait = manager.connect("A", definition);
  assert.equal(manager.creates, 1);
  const rejected = assert.rejects(wait, /aborted|closed during startup/);

  await manager.closeAll();
  await rejected;

  assert.equal(manager.getConnection("A"), undefined);
  assert.equal(manager.startupSignals[0]?.aborted, true);
});
