import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopAdapter, createLinuxAdapter, createMacOSAdapter, createWindowsAdapter } from "../src/tools/computer-use/platform/index.ts";
import { ComputerUseError } from "../src/tools/computer-use/types.ts";
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
