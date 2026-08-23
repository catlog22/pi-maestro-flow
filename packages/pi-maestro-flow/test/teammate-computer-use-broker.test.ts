import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TeammateComputerUseBroker } from "../src/teammate/computer-use-broker.ts";
import { createComputerUseManager, type ComputerUseManagerLike } from "../src/tools/computer-use/manager.ts";
import type { DesktopAdapter } from "../src/tools/computer-use/platform/types.ts";

const ctx = { cwd: "D:/workspace" } as ExtensionContext;

function request(actorId: string, input: Record<string, unknown>, signal?: AbortSignal) {
  return {
    toolName: "computer_use",
    input,
    actor: { correlationId: actorId, agent: "general" },
    ...(signal ? { signal } : {}),
  };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  return item?.type === "text" ? item.text ?? "" : "";
}

function permissions() {
  return {
    screen_capture: { state: "granted" as const },
    accessibility: { state: "granted" as const },
    input: { state: "granted" as const },
    window_control: { state: "granted" as const },
  };
}

function adapterWithPermissions(
  implementation: (signal?: AbortSignal) => Promise<ReturnType<typeof permissions>>,
): DesktopAdapter {
  return {
    platform: "linux",
    session: "x11",
    capabilities: { platform: "linux", session: "x11", features: {} },
    permissions: implementation,
    listWindows: async () => [],
    displays: async () => [],
    activate: async () => { throw new Error("unused"); },
    capture: async () => { throw new Error("unused"); },
    readImage: async () => { throw new Error("unused"); },
    pointer: async () => { throw new Error("unused"); },
    press: async () => { throw new Error("unused"); },
    type: async () => { throw new Error("unused"); },
    paste: async () => { throw new Error("unused"); },
  } as DesktopAdapter;
}

test("child computer_use routes through the injected root manager", async () => {
  const calls: string[] = [];
  const manager = {
    async capabilities() { calls.push("capabilities"); return { platform: "linux", session: "x11", features: {} }; },
    async status() { return { queue_depth: 0, latched_windows: [], worker_state: "unknown", models: "unavailable" }; },
    async permissions() { calls.push("permissions"); return permissions(); },
    shutdown: async () => undefined,
  } as unknown as ComputerUseManagerLike;
  const broker = new TeammateComputerUseBroker(manager);

  const result = await broker.execute(request("actor-a", { action: "capabilities" }), ctx);

  assert.equal(broker.manager, manager);
  assert.deepEqual(calls, ["capabilities"]);
  assert.equal(result.isError, undefined);
  assert.match(text(result), /features/);
});

test("concurrent child computer_use calls share the manager serialization queue", async () => {
  let active = 0;
  let maximum = 0;
  const order: string[] = [];
  const adapter = adapterWithPermissions(async (signal) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 10);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    active--;
    order.push("done");
    return permissions();
  });
  const broker = new TeammateComputerUseBroker(createComputerUseManager(adapter));

  const results = await Promise.all([
    broker.execute(request("actor-a", { action: "permissions" }), ctx),
    broker.execute(request("actor-b", { action: "permissions" }), ctx),
  ]);

  assert.equal(maximum, 1);
  assert.deepEqual(order, ["done", "done"]);
  assert.equal(results.some((result) => result.isError), false);
});

test("missing and stale child actors fail closed", async () => {
  const manager = {
    async capabilities() { return { platform: "linux", session: "x11", features: {} }; },
    async status() { return { queue_depth: 0, latched_windows: [], worker_state: "unknown", models: "unavailable" }; },
    async permissions() { return permissions(); },
    shutdown: async () => undefined,
  } as unknown as ComputerUseManagerLike;
  const broker = new TeammateComputerUseBroker(manager);

  const missing = await broker.execute(request("unknown", { action: "capabilities" }), ctx);
  assert.equal(missing.isError, true);
  assert.match(text(missing), /trusted correlation id/i);

  await broker.execute(request("actor-a", { action: "capabilities" }), ctx);
  assert.equal(await broker.closeActor("actor-a"), 1);
  const stale = await broker.execute(request("actor-a", { action: "capabilities" }), ctx);
  assert.equal(stale.isError, true);
  assert.match(text(stale), /stale session generation/i);
});

test("actor cleanup aborts in-flight child operations", async () => {
  const adapter = adapterWithPermissions(async (signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(permissions()), 100);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));
  const broker = new TeammateComputerUseBroker(createComputerUseManager(adapter));
  const pending = broker.execute(request("actor-cleanup", { action: "permissions" }), ctx);
  await Promise.resolve();

  assert.equal(await broker.closeActor("actor-cleanup"), 1);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(text(result), /ABORTED/);
});
test("child timeout is returned as a structured computer-use error", async () => {
  const adapter = adapterWithPermissions(async (signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(permissions()), 100);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));
  const broker = new TeammateComputerUseBroker(createComputerUseManager(adapter));

  const result = await broker.execute(request("actor-timeout", { action: "permissions", timeout_ms: 1 }), ctx);

  assert.equal(result.isError, true);
  assert.match(text(result), /TIMEOUT/);
});


test("child cancellation is returned as a structured computer-use error", async () => {
  const adapter = adapterWithPermissions(async (signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(permissions()), 100);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));
  const broker = new TeammateComputerUseBroker(createComputerUseManager(adapter));
  const controller = new AbortController();
  const pending = broker.execute(request("actor-a", { action: "permissions" }, controller.signal), ctx);
  controller.abort(new Error("child cancelled"));

  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(text(result), /ABORTED/);
  assert.doesNotMatch(text(result), /desktop|native provider/i);
});

