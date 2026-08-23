import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUseManager } from "../src/tools/computer-use/manager.ts";
import { ComputerUseError, type CapturedFrame, type ControlNode, type WindowInfo } from "../src/tools/computer-use/types.ts";
import type { DesktopAdapter } from "../src/tools/computer-use/platform/types.ts";

const windowInfo = (active = true): WindowInfo => ({ id: "w1", title: "Fixture", app: "fixture", pid: 1, active, minimized: false, bounds: { x: 100, y: 100, width: 300, height: 200 }, clientBounds: { x: 110, y: 120, width: 280, height: 160 } });
const frame = (bytes = new Uint8Array([1])): CapturedFrame => ({ image: { mimeType: "image/png", width: 32, height: 32, origin: { x: 100, y: 100 }, coordinateSpace: "screen_physical", source: "region", backend: "fixture", windowId: "w1" }, bytes, capturedAt: Date.now() });

function makeAdapter(overrides: Partial<DesktopAdapter> = {}): DesktopAdapter & { calls: string[]; pointerRequests: unknown[]; captureCount: number } {
  const calls: string[] = [];
  const pointerRequests: unknown[] = [];
  const adapter = {
    platform: "win32" as const,
    session: "windows" as const,
    capabilities: { platform: "win32" as const, session: "windows" as const, features: {} },
    calls,
    pointerRequests,
    captureCount: 0,
    listWindows: async () => { calls.push("list"); return [windowInfo()]; },
    activate: async () => { calls.push("activate"); return { window: windowInfo(), foregroundVerified: true }; },
    displays: async () => [],
    capture: async () => { calls.push("capture"); adapter.captureCount++; return frame(); },
    readImage: async () => ({ image: frame().image, bytes: frame().bytes }),
    permissions: async () => ({ screen_capture: { state: "granted" }, accessibility: { state: "granted" }, input: { state: "granted" }, window_control: { state: "granted" } }),
    pointer: async (request: unknown) => { calls.push("pointer"); pointerRequests.push(request); return { resolvedPoint: { x: 0, y: 0 }, foregroundVerified: true, verification: { changedPixels: 1, totalPixels: 1, changePercent: 100, verdict: "changed" as const, foregroundChanged: true, requiresReprobe: false } }; },
    press: async request => ({ keys: request.keys, foregroundVerified: true }),
    type: async request => ({ characters: request.text.length, foregroundVerified: true }),
    paste: async request => ({ characters: request.text.length, clipboardRestored: true, foregroundVerified: true }),
    shutdown: async () => { calls.push("shutdown"); },
    ...overrides,
  } as DesktopAdapter & { calls: string[]; pointerRequests: unknown[]; captureCount: number };
  return adapter;
}

test("serializes operations across manager instances", async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = makeAdapter({ listWindows: async () => { events.push("first:start"); await gate; events.push("first:end"); return [windowInfo()]; } });
  const second = makeAdapter({ listWindows: async () => { events.push("second"); return [windowInfo()]; } });
  const a = new ComputerUseManager(first);
  const b = new ComputerUseManager(second);
  const one = a.listWindows();
  const two = b.listWindows();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(events, ["first:start"]);
  release();
  await Promise.all([one, two]);
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("queued abort rejects without invoking the adapter", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter = makeAdapter({ listWindows: async () => { await gate; return [windowInfo()]; } });
  const manager = new ComputerUseManager(adapter);
  const first = manager.listWindows();
  const controller = new AbortController();
  const second = manager.listWindows({}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, (error: unknown) => error instanceof ComputerUseError && error.code === "ABORTED");
  release();
  await first;
  assert.equal(adapter.calls.filter(call => call === "list").length, 0);
});

test("aborting an active key chord invokes deterministic release cleanup", async () => {
  let releaseCount = 0;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const adapter = makeAdapter({
    press: async (_request, signal) => { started(); return await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new ComputerUseError({ code: "ABORTED", message: "fixture abort", retryable: false })), { once: true })); },
    releaseKeys: async () => { releaseCount++; },
  } as Partial<DesktopAdapter>);
  const manager = new ComputerUseManager(adapter);
  const controller = new AbortController();
  const pending = manager.press({ window_id: "w1", keys: ["ctrl", "a"], signal: controller.signal });
  await entered;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ComputerUseError && error.code === "ABORTED");
  assert.equal(releaseCount, 1);
});

test("pre-aborted operations do not leak queue depth", async () => {
  const manager = new ComputerUseManager(makeAdapter());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(manager.listWindows({}, { signal: controller.signal }), (error: unknown) => error instanceof ComputerUseError && error.code === "ABORTED");
  assert.equal((await manager.status()).queue_depth, 0);
});

test("activates, revalidates foreground, and converts client coordinates", async () => {
  const adapter = makeAdapter();
  const manager = new ComputerUseManager(adapter);
  await manager.click({ window_id: "w1", x: 5, y: 6, coordinate_space: "window_client_physical" });
  const request = adapter.pointerRequests[0] as { point: { x: number; y: number }; coordinateSpace: string };
  assert.deepEqual(request.point, { x: 115, y: 126 });
  assert.equal(request.coordinateSpace, "screen_physical");
  assert.deepEqual(adapter.calls.slice(0, 2), ["activate", "list"]);
});

test("rejects network-game and destructive software input", async () => {
  const manager = new ComputerUseManager(makeAdapter());
  await assert.rejects(manager.press({ window_id: "w1", keys: ["ctrl+w"] }), (error: unknown) => error instanceof ComputerUseError);
  await assert.rejects(manager.press({ window_id: "w1", keys: ["a"], target_context: "network_game" }), (error: unknown) => error instanceof ComputerUseError && error.code === "UNSUPPORTED_HARDWARE_INPUT");
});

test("stale control references are rejected", async () => {
  let controls: ControlNode[] = [{ ref: "r1", windowId: "w1", role: "button", name: "Save", title: null, identifier: null, value: null, enabled: true, focused: false, offscreen: false, bounds: null, actions: ["press"] }];
  const accessibility = {
    name: "fixture",
    uiTree: async () => ({ snapshotId: "s1", controls }),
    findControl: async () => ({ snapshotId: "s1", matches: controls }),
    pressControl: async () => ({ method: "semantic" as const, control: controls[0]! }),
  };
  const adapter = makeAdapter({ accessibility });
  const manager = new ComputerUseManager(adapter);
  await manager.uiTree({ windowId: "w1" });
  controls = [];
  await assert.rejects(manager.pressControl({ window_id: "w1", control_ref: "r1" }), (error: unknown) => error instanceof ComputerUseError && error.code === "STALE_CONTROL_REF");
});

test("near-zero pointer verification latches until a reprobe", async () => {
  const adapter = makeAdapter();
  const manager = new ComputerUseManager(adapter);
  await manager.click({ window_id: "w1", x: 120, y: 140 });
  await assert.rejects(manager.click({ window_id: "w1", x: 120, y: 140 }), (error: unknown) => error instanceof ComputerUseError && error.details?.requiresReprobe === true);
  await manager.screenshot({ source: "screen" });
  await manager.click({ window_id: "w1", x: 120, y: 140 });
});

test("vision failures remain structured envelopes", async () => {
  const adapter = makeAdapter();
  const manager = new ComputerUseManager(adapter, { vision: { ocr: async () => ({ ok: false, code: "MODEL_UNAVAILABLE", diagnostic: "fixture missing", engine: "rapidocr" }), detect: async () => ({ ok: false, code: "MODEL_UNAVAILABLE", diagnostic: "fixture missing", engine: "omniparser" }) } });
  const result = await manager.ocr({ source: "screen" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "MODEL_UNAVAILABLE");
});
