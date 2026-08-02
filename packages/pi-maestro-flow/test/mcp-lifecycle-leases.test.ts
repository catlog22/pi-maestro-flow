import assert from "node:assert/strict";
import test from "node:test";
import { McpLifecycleManager } from "../src/mcp/lifecycle.ts";
import { McpServerManager } from "../src/mcp/server-manager.ts";
import type { ServerDefinition } from "../src/mcp/types.ts";

const definition = { command: "stub" } as ServerDefinition;

class LeaseTestManager extends McpServerManager {
  creates = 0;
  closes = 0;
  honorAbort = true;
  closeGate: Promise<void> | undefined;
  private pendingStarts: Array<{ resolve: (connection: unknown) => void; connection: unknown }> = [];

  protected override createConnection(
    _name: string,
    serverDefinition: ServerDefinition,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.creates += 1;
    const connection = {
      client: { close: async () => { this.closes += 1; await this.closeGate; } },
      transport: { close: async () => { this.closes += 1; await this.closeGate; } },
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

  resolveNext(): void {
    const entry = this.pendingStarts.shift();
    if (entry) entry.resolve(entry.connection);
  }
}

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
