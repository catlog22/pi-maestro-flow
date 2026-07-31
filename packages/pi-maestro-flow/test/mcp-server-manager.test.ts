import assert from "node:assert/strict";
import test from "node:test";
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
