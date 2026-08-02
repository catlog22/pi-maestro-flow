import assert from "node:assert/strict";
import test from "node:test";
import { McpSessionLifecycle } from "../src/mcp/index.ts";
import { McpLifecycleManager } from "../src/mcp/lifecycle.ts";
import { logger } from "../src/mcp/logger.ts";
import { McpServerManager } from "../src/mcp/server-manager.ts";
import type { ServerDefinition } from "../src/mcp/types.ts";

const definition = { command: "stub" } as ServerDefinition;

class LeaseTestManager extends McpServerManager {
  creates = 0;
  closes = 0;
  closeCompletions = 0;
  honorAbort = true;
  closeGate: Promise<void> | undefined;
  private startupTracker: ((resource: { close(): Promise<void> }, description: string) => void) | undefined;
  private pendingStarts: Array<{ resolve: (connection: unknown) => void; connection: unknown }> = [];

  protected override createConnection(
    _name: string,
    serverDefinition: ServerDefinition,
    signal?: AbortSignal,
    trackStartupResource?: (
      resource: { close(): Promise<void> },
      description: string,
    ) => void,
  ): Promise<unknown> {
    this.creates += 1;
    this.startupTracker = trackStartupResource;
    const connection = {
      client: {
        close: async () => {
          this.closes += 1;
          await this.closeGate;
          this.closeCompletions += 1;
        },
      },
      transport: {
        close: async () => {
          this.closes += 1;
          await this.closeGate;
          this.closeCompletions += 1;
        },
      },
      definition: serverDefinition,
      tools: [],
      resources: [],
      lastUsedAt: Date.now(),
      inFlight: 0,
      status: "connected",
    };
    trackStartupResource?.(connection.client, "test client");
    trackStartupResource?.(connection.transport, "test transport");
    return new Promise((resolve, reject) => {
      this.pendingStarts.push({ resolve, connection });
      if (!this.honorAbort) return;
      const onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("startup aborted"));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  trackLateResource(resource: { close(): Promise<void> }, description = "late test resource"): void {
    this.startupTracker?.(resource, description);
  }

  resolveNext(): void {
    const entry = this.pendingStarts.shift();
    if (entry) entry.resolve(entry.connection);
  }
}

test("MCP session shutdown aborts and drains late initialization cleanup", async () => {
  let resolveInit!: (state: { id: string }) => void;
  const pendingInit = new Promise<{ id: string }>((resolve) => { resolveInit = resolve; });
  let releaseDispose!: () => void;
  const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
  let initSignal: AbortSignal | undefined;
  const disposed: string[] = [];
  let mirroredState: { id: string } | null = null;
  let mirroredPromise: Promise<{ id: string }> | null = null;
  const lifecycle = new McpSessionLifecycle<{ id: string }>(
    async (state) => {
      disposed.push(state.id);
      await disposeGate;
    },
    (state) => { mirroredState = state; },
    (promise) => { mirroredPromise = promise; },
    () => {},
    (_message, error) => { throw error; },
  );

  await lifecycle.restart("session_restart", async () => {}, async (signal) => {
    initSignal = signal;
    return pendingInit;
  });
  assert.ok(mirroredPromise);

  let shutdownSettled = false;
  const shutdown = lifecycle.shutdown("session_shutdown", async () => {}).then(() => {
    shutdownSettled = true;
  });
  assert.equal(initSignal?.aborted, true);
  await Promise.resolve();
  assert.equal(mirroredPromise, null);

  resolveInit({ id: "late" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(disposed, ["late"]);
  assert.equal(shutdownSettled, false);
  assert.equal(mirroredState, null);

  releaseDispose();
  await shutdown;
  assert.equal(shutdownSettled, true);
});

test("MCP session shutdown deadline detaches non-cooperative initialization and reclaims its late state", { timeout: 1_000 }, async () => {
  let resolveInit!: (state: { id: string }) => void;
  const pendingInit = new Promise<{ id: string }>((resolve) => { resolveInit = resolve; });
  const disposed: string[] = [];
  const diagnostics: string[] = [];
  let mirroredState: { id: string } | null = null;
  const lifecycle = new McpSessionLifecycle<{ id: string }>(
    async (state) => { disposed.push(state.id); },
    (state) => { mirroredState = state; },
    () => {},
    () => {},
    (message, error) => {
      diagnostics.push(`${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
    { initializationDrainTimeoutMs: 20 },
  );

  await lifecycle.restart("session_restart", async () => {}, async () => pendingInit);
  await lifecycle.shutdown("session_shutdown", async () => {});

  assert.equal(mirroredState, null);
  assert.match(diagnostics.join("\n"), /initialization cleanup deadline exceeded/);
  assert.deepEqual(disposed, []);

  resolveInit({ id: "late" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(disposed, ["late"]);
  assert.equal(mirroredState, null, "the fenced late state must never publish");
});

test("MCP replacement proceeds after a non-cooperative initialization deadline", { timeout: 1_000 }, async () => {
  let resolveFirst!: (state: { id: string }) => void;
  const firstInit = new Promise<{ id: string }>((resolve) => { resolveFirst = resolve; });
  const events: string[] = [];
  const lifecycle = new McpSessionLifecycle<{ id: string }>(
    async (state) => { events.push(`dispose:${state.id}`); },
    () => {},
    () => {},
    (state) => { events.push(`ready:${state.id}`); },
    (message) => { events.push(`diagnostic:${message}`); },
    { initializationDrainTimeoutMs: 20 },
  );

  await lifecycle.restart("session_restart", async () => {}, async () => firstInit);
  await lifecycle.restart("session_restart", async () => {
    events.push("prepare:second");
  }, async () => ({ id: "second" }));
  assert.deepEqual(await lifecycle.awaitInitializedState(), { id: "second" });
  assert.deepEqual(events, [
    "diagnostic:MCP initialization cleanup deadline exceeded",
    "prepare:second",
    "ready:second",
  ]);

  resolveFirst({ id: "first" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    "diagnostic:MCP initialization cleanup deadline exceeded",
    "prepare:second",
    "ready:second",
    "dispose:first",
  ]);
  await lifecycle.shutdown("session_shutdown", async () => {});
});

test("MCP session shutdown reports late initialization cleanup failure", async () => {
  let resolveInit!: (state: { id: string }) => void;
  const pendingInit = new Promise<{ id: string }>((resolve) => { resolveInit = resolve; });
  const lifecycle = new McpSessionLifecycle<{ id: string }>(
    async () => { throw new Error("late cleanup failed"); },
    () => {},
    () => {},
    () => {},
    () => {},
  );

  await lifecycle.restart("session_restart", async () => {}, async () => pendingInit);
  const shutdown = lifecycle.shutdown("session_shutdown", async () => {});
  resolveInit({ id: "late" });
  await assert.rejects(shutdown, /late cleanup failed/);
});

test("MCP replacement startup waits for reverse-order late state cleanup", async () => {
  let resolveFirst!: (state: { id: string }) => void;
  const firstInit = new Promise<{ id: string }>((resolve) => { resolveFirst = resolve; });
  let releaseFirstDispose!: () => void;
  const firstDisposeGate = new Promise<void>((resolve) => { releaseFirstDispose = resolve; });
  const events: string[] = [];
  let firstSignal: AbortSignal | undefined;
  let resolveSecond!: (state: { id: string }) => void;
  const secondInit = new Promise<{ id: string }>((resolve) => { resolveSecond = resolve; });
  const lifecycle = new McpSessionLifecycle<{ id: string }>(
    async (state, reason) => {
      events.push(`dispose:${state.id}:${reason}`);
      if (state.id === "first") await firstDisposeGate;
    },
    () => {},
    () => {},
    (state) => { events.push(`ready:${state.id}`); },
    (_message, error) => { throw error; },
  );

  await lifecycle.restart("session_restart", async () => {}, async (signal) => {
    firstSignal = signal;
    events.push("init:first");
    return firstInit;
  });
  const replacement = lifecycle.restart("session_restart", async () => {
    events.push("prepare:second");
  }, async () => {
    events.push("init:second");
    return secondInit;
  });
  assert.equal(firstSignal?.aborted, true);
  assert.deepEqual(events, ["init:first"]);

  resolveFirst({ id: "first" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["init:first", "dispose:first:session_restart"]);

  releaseFirstDispose();
  await replacement;
  assert.deepEqual(events, [
    "init:first",
    "dispose:first:session_restart",
    "prepare:second",
    "init:second",
  ]);

  resolveSecond({ id: "second" });
  assert.deepEqual(await lifecycle.awaitInitializedState(), { id: "second" });
  assert.deepEqual(events, [
    "init:first",
    "dispose:first:session_restart",
    "prepare:second",
    "init:second",
    "ready:second",
  ]);
  await lifecycle.shutdown("session_shutdown", async () => {});
});

test("MCP close awaits late startup resource disposal", async () => {
  const manager = new LeaseTestManager();
  manager.honorAbort = false;
  let releaseClose!: () => void;
  manager.closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const wait = manager.connect("A", definition);
  const rejected = assert.rejects(wait, /closed during startup/);

  let closeSettled = false;
  const close = manager.close("A").then(() => { closeSettled = true; });
  manager.resolveNext();
  await Promise.resolve();
  assert.equal(closeSettled, false);
  assert.equal(manager.closes, 2);

  releaseClose();
  await Promise.all([close, rejected]);
  assert.equal(manager.getConnection("A"), undefined);
});

test("MCP close deadline detaches a non-cooperative startup and reclaims its late resources", { timeout: 1_000 }, async () => {
  const manager = new LeaseTestManager(undefined, { startupDrainTimeoutMs: 20 });
  manager.honorAbort = false;
  const wait = manager.connect("A", definition);
  const rejected = assert.rejects(wait, /closed during startup/);

  await manager.close("A");
  assert.equal(manager.getConnection("A"), undefined);
  assert.equal(manager.closes, 2, "the startup deadline force-closes known client and transport resources");

  manager.resolveNext();
  await rejected;
  assert.equal(manager.closes, 2, "the late continuation reuses the forced-close cleanup");
  assert.equal(manager.getConnection("A"), undefined);
});

test("MCP startup resources registered after the drain deadline close immediately", { timeout: 1_000 }, async () => {
  const manager = new LeaseTestManager(undefined, { startupDrainTimeoutMs: 20 });
  manager.honorAbort = false;
  const wait = manager.connect("A", definition);
  const rejected = assert.rejects(wait, /closed during startup/);

  await manager.close("A");
  let lateCloses = 0;
  manager.trackLateResource({
    async close() { lateCloses += 1; },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lateCloses, 1, "resources registered after forced closing inherit the close fence");

  manager.resolveNext();
  await rejected;
  assert.equal(manager.getConnection("A"), undefined);
});

test("MCP resource close deadline detaches non-cooperative client and transport cleanup", { timeout: 1_000 }, async () => {
  const manager = new LeaseTestManager(undefined, { resourceCloseTimeoutMs: 20 });
  let releaseClose!: () => void;
  manager.closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const connecting = manager.connect("A", definition);
  manager.resolveNext();
  await connecting;

  await manager.close("A");
  assert.equal(manager.getConnection("A"), undefined);
  assert.equal(manager.closes, 2, "both close operations start before the shared wait settles");
  assert.equal(manager.closeCompletions, 0, "non-cooperative closes remain detached at the deadline");

  releaseClose();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(manager.closeCompletions, 2, "detached client and transport cleanup eventually completes");
});

test("MCP connection lease drain deadline force-closes resources without retargeting late release", { timeout: 1_000 }, async () => {
  const manager = new LeaseTestManager(undefined, { connectionLeaseDrainTimeoutMs: 20 });
  const firstConnect = manager.connect("A", definition);
  manager.resolveNext();
  const firstConnection = await firstConnect;
  const lease = manager.acquireConnection("A");
  assert.ok(lease);

  await manager.close("A");
  assert.equal(manager.closes, 2, "held lease deadline force-closes the client and transport");
  assert.equal(manager.getConnection("A"), undefined);

  const secondConnect = manager.connect("A", definition);
  manager.resolveNext();
  const secondConnection = await secondConnect;
  lease.release();
  assert.equal(firstConnection.inFlight, 0);
  assert.equal(manager.getConnection("A"), secondConnection);
  await manager.close("A");
});

test("MCP connection leases drain the exact identity across reconnect", async () => {
  const manager = new LeaseTestManager();
  const firstConnect = manager.connect("A", definition);
  manager.resolveNext();
  const firstConnection = await firstConnect;
  const lease = manager.acquireConnection("A");
  assert.ok(lease);
  assert.equal(lease.connection, firstConnection);

  let closeSettled = false;
  const closeOld = manager.close("A").then(() => { closeSettled = true; });
  await Promise.resolve();
  assert.equal(manager.getConnection("A"), undefined);
  assert.equal(closeSettled, false);
  assert.equal((lease.requestOptions as { signal?: AbortSignal } | undefined)?.signal?.aborted, true);

  const secondConnect = manager.connect("A", definition);
  manager.resolveNext();
  const secondConnection = await secondConnect;
  lease.release();
  lease.release();
  await closeOld;

  assert.equal(manager.getConnection("A"), secondConnection);
  assert.equal(secondConnection.inFlight, 0);
  await manager.close("A");
});

test("MCP graceful shutdown deadline detaches health and close drains then finishes late cleanup", { timeout: 1_000 }, async () => {
  let resolveConnect!: () => void;
  const pendingConnect = new Promise<void>((resolve) => { resolveConnect = resolve; });
  let resolveClose!: () => void;
  const pendingClose = new Promise<void>((resolve) => { resolveClose = resolve; });
  const diagnostics: string[] = [];
  const events: string[] = [];
  let reconnects = 0;
  const manager = {
    getConnection() { return undefined; },
    async connect() {
      await pendingConnect;
      events.push("health:settled");
      return { status: "connected" };
    },
    isIdle() { return false; },
    async close() {
      await pendingClose;
      events.push("late-health:closed");
    },
    async closeAll() {
      await pendingClose;
      events.push("close-all:settled");
    },
  } as unknown as McpServerManager;
  const lifecycle = new McpLifecycleManager(manager, { shutdownDrainTimeoutMs: 20 });
  lifecycle.markKeepAlive("A", definition);
  lifecycle.setReconnectCallback(() => { reconnects += 1; });
  logger.addHandler((entry) => {
    if (entry.level === "error") diagnostics.push(entry.message);
  });

  try {
    const healthCheck = lifecycle.runHealthCheck();
    await lifecycle.gracefulShutdown();

    assert.equal(reconnects, 0);
    assert.deepEqual(events, [], "neither ignored operation settled before shutdown returned");
    assert.ok(
      diagnostics.includes("MCP lifecycle shutdown deadline exceeded; cleanup detached"),
      "deadline emits a terminal lifecycle diagnostic",
    );

    resolveConnect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["health:settled"]);
    assert.equal(reconnects, 0, "the deadline generation fence blocks stale publication");

    resolveClose();
    await healthCheck;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [
      "health:settled",
      "close-all:settled",
      "late-health:closed",
    ]);
  } finally {
    logger.clearHandlers();
    resolveConnect();
    resolveClose();
  }
});

test("MCP graceful shutdown drains and fences an in-flight health check", async () => {
  let resolveConnect!: () => void;
  const pending = new Promise<void>((resolve) => { resolveConnect = resolve; });
  let reconnects = 0;
  let closes = 0;
  const manager = {
    getConnection() { return undefined; },
    async connect() { await pending; return { status: "connected" }; },
    isIdle() { return false; },
    async close() { closes += 1; },
    async closeAll() {},
  } as unknown as McpServerManager;
  const lifecycle = new McpLifecycleManager(manager);
  lifecycle.markKeepAlive("A", definition);
  lifecycle.setReconnectCallback(() => { reconnects += 1; });

  const check = lifecycle.runHealthCheck();
  let shutdownSettled = false;
  const shutdown = lifecycle.gracefulShutdown().then(() => { shutdownSettled = true; });
  await Promise.resolve();
  assert.equal(shutdownSettled, false);

  resolveConnect();
  await Promise.all([check, shutdown]);
  assert.equal(reconnects, 0);
  assert.equal(closes, 1);
});
