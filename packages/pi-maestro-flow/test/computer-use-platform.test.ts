import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopAdapter, createLinuxAdapter, createMacOSAdapter, createWindowsAdapter } from "../src/tools/computer-use/platform/index.ts";
import { ComputerUseError } from "../src/tools/computer-use/types.ts";
import { cropPng, inspectPng } from "../src/tools/computer-use/artifacts.ts";
import { runBridgeProcess } from "../src/tools/computer-use/platform/bridge-process.ts";

function optionalPackage(name: string): unknown {
  if (name === "active-win") return { openWindows: async () => [{ id: 7, title: "Editor", app: "Editor", pid: 12, active: true, minimized: false, bounds: { x: 100, y: 50, width: 800, height: 600 }, clientBounds: { x: 108, y: 82, width: 784, height: 560 } }] };
  return undefined;
}

test("factory routes platforms without importing unavailable native packages", () => {
  const windows = createDesktopAdapter({ platform: "win32", requireOptional: optionalPackage });
  const mac = createMacOSAdapter({ requireOptional: optionalPackage });
  const linux = createLinuxAdapter({ session: "x11", requireOptional: optionalPackage });
  assert.equal(windows.platform, "win32");
  assert.equal(mac.platform, "darwin");
  assert.equal(linux.platform, "linux");
  assert.equal(windows.capabilities.features.window_list?.state, "available");
  assert.equal(windows.capabilities.features.input?.state, "unavailable");
});

test("Windows client points resolve from client bounds, never outer window bounds", async () => {
  let received: { x: number; y: number } | undefined;
  const adapter = createWindowsAdapter({
    requireOptional: () => undefined,
    hooks: {
      listWindows: async () => [{ id: "w", title: "", app: "", pid: null, active: true, minimized: false, bounds: { x: 100, y: 50, width: 800, height: 600 }, clientBounds: { x: 108, y: 82, width: 784, height: 560 } }],
      pointer: async (_request, point) => { received = point; return { resolvedPoint: point, foregroundVerified: true, verification: { changedPixels: 1, totalPixels: 1, changePercent: 100, verdict: "changed", foregroundChanged: true, requiresReprobe: false } }; },
    },
  });
  await adapter.pointer({ windowId: "w", point: { x: 12, y: 8 }, coordinateSpace: "window_client_physical", action: "click" });
  assert.deepEqual(received, { x: 120, y: 90 });
});

test("Wayland global operations fail with a structured restriction", async () => {
  const adapter = createLinuxAdapter({ session: "wayland", env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }, requireOptional: () => undefined });
  assert.equal(adapter.capabilities.features.window_list?.errorCode, "WAYLAND_RESTRICTED");
  await assert.rejects(adapter.listWindows(), (error: unknown) => error instanceof ComputerUseError && error.code === "WAYLAND_RESTRICTED");
  await assert.rejects(adapter.accessibility?.uiTree({ windowId: "1" }), (error: unknown) => error instanceof ComputerUseError && error.code === "WAYLAND_RESTRICTED");
});

test("bridge executes direct argv with bounded output", async () => {
  const result = await runBridgeProcess({ executable: process.execPath, argv: ["-e", "process.stdout.write('bridge-ok')"] }, { timeoutMs: 2_000, maxStdoutBytes: 32 });
  assert.equal(Buffer.from(result.stdout).toString(), "bridge-ok");
});

test("bridge rejects output over its configured bound", async () => {
  await assert.rejects(
    runBridgeProcess({ executable: process.execPath, argv: ["-e", "process.stdout.write('0123456789')"] }, { timeoutMs: 2_000, maxStdoutBytes: 4 }),
    (error: unknown) => error instanceof ComputerUseError && error.code === "ARTIFACT_LIMIT_EXCEEDED",
  );
});


test("shared native providers are wired for macOS and X11 without enabling Wayland", () => {
  const activeWin = { openWindows: async () => [], activeWindowSync: () => undefined };
  const screenshot = Object.assign(async () => new Uint8Array([137, 80, 78, 71]), { listDisplays: async () => [{ id: "primary", width: 1, height: 1, offsetX: 0, offsetY: 0, primary: true }] });
  const nut = {
    mouse: { setPosition: async () => {}, getPosition: async () => ({ x: 0, y: 0 }), leftClick: async () => {} },
    keyboard: { pressKey: async () => {}, releaseKey: async () => {}, type: async () => {} },
    clipboard: { getContent: async () => "", setContent: async () => {} },
    Key: { A: 1 },
    Button: { LEFT: 0 },
  };
  const windowManager = { windowManager: { getWindows: () => [], getActiveWindow: () => undefined, getMonitors: () => [] } };
  const load = (name: string) => name === "active-win" ? activeWin : name === "screenshot-desktop" ? screenshot : name === "@nut-tree-fork/nut-js" ? nut : name === "node-window-manager" ? windowManager : undefined;
  const mac = createMacOSAdapter({ requireOptional: load });
  const linux = createLinuxAdapter({ session: "x11", requireOptional: load });
  assert.equal(mac.capabilities.features.input?.state, "available");
  assert.equal(mac.capabilities.features.window_list?.state, "available");
  assert.equal(linux.capabilities.features.input?.state, "available");
  assert.equal(linux.capabilities.features.window_list?.state, "available");
});

test("bounded PNG crop preserves a physical region frame", () => {
  const oneByOne = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const cropped = cropPng(oneByOne, { x: 0, y: 0, width: 1, height: 1 });
  const metadata = inspectPng(cropped);
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 1, height: 1 });
});
