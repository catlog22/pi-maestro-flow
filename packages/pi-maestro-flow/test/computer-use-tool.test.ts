import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { ComputerUseParams, createComputerUseTool } from "../src/tools/computer-use-tool.ts";
import type { ComputerUseManagerLike } from "../src/tools/computer-use/manager.ts";
import type { CapturedFrame } from "../src/tools/computer-use/types.ts";

const frame: CapturedFrame = {
  image: { mimeType: "image/png", width: 2, height: 2, origin: { x: 0, y: 0 }, coordinateSpace: "screen_physical", source: "screen", backend: "fixture" },
  bytes: new Uint8Array([137, 80, 78, 71]),
  capturedAt: 1,
};

function fakeManager(calls: string[]): ComputerUseManagerLike {
  const result = { ok: true, result: { image: frame.image, text: "ok", lines: [] } };
  return {
    capabilities: async () => { calls.push("capabilities"); return { platform: "win32", session: "windows", features: {} }; },
    status: async () => { calls.push("status"); return { queue_depth: 0, latched_windows: [], worker_state: "available", models: "available" }; },
    permissions: async () => { calls.push("permissions"); return { screen_capture: { state: "granted" }, accessibility: { state: "granted" }, input: { state: "granted" }, window_control: { state: "granted" } }; },
    listWindows: async () => { calls.push("list_windows"); return { windows: [] }; },
    activate: async () => { calls.push("activate"); return { window: {} as never, foreground_verified: true }; },
    screenshot: async () => { calls.push("screenshot"); return frame; },
    ocr: async () => { calls.push("ocr"); return result as never; },
    detect: async () => { calls.push("detect"); return result as never; },
    uiTree: async () => { calls.push("ui_tree"); return { snapshotId: "s", controls: [] }; },
    findControl: async () => { calls.push("find_control"); return { snapshotId: "s", matches: [] }; },
    pressControl: async () => { calls.push("press_control"); return { method: "semantic", control: {} as never }; },
    click: async () => { calls.push("click"); return {} as never; },
    doubleClick: async () => { calls.push("double_click"); return {} as never; },
    rightClick: async () => { calls.push("right_click"); return {} as never; },
    move: async () => { calls.push("move"); return {} as never; },
    drag: async () => { calls.push("drag"); return {} as never; },
    press: async () => { calls.push("press"); return { keys: ["a"], foregroundVerified: true }; },
    type: async () => { calls.push("type"); return { characters: 1, foregroundVerified: true }; },
    paste: async () => { calls.push("paste"); return { characters: 1, clipboardRestored: true, foregroundVerified: true }; },
    findBlock: async () => { calls.push("find_block"); return { found: false, confidence: 0 }; },
    shutdown: async () => { calls.push("shutdown"); },
  };
}

async function execute(tool: ReturnType<typeof createComputerUseTool>, params: Record<string, unknown>) {
  return tool.execute("id", params as never, undefined, undefined, { cwd: "D:/fixture" } as never);
}

test("computer_use schema enforces action/source conditionals", () => {
  assert.equal(Check(ComputerUseParams, { action: "guide" }), true);
  assert.equal(Check(ComputerUseParams, { action: "screenshot" }), false);
  assert.equal(Check(ComputerUseParams, { action: "screenshot", source: "screen" }), true);
  assert.equal(Check(ComputerUseParams, { action: "screenshot", source: "image", path: "x.png" }), false);
  assert.equal(Check(ComputerUseParams, { action: "ocr", source: "image" }), false);
  assert.equal(Check(ComputerUseParams, { action: "ocr", source: "image", path: "x.png" }), true);
  assert.equal(Check(ComputerUseParams, { action: "click", window_id: "w", x: 1, y: 2 }), true);
  assert.equal(Check(ComputerUseParams, { action: "click", window_id: "w", x: 1 }), false);
  assert.equal(Check(ComputerUseParams, { action: "drag", window_id: "w", x: 1, y: 2 }), false);
});

test("computer_use guide returns an index, topics, and structured unknown-topic errors", async () => {
  const tool = createComputerUseTool(fakeManager([]));
  const index = await execute(tool, { action: "guide" });
  assert.match(String(index.content[0] && "text" in index.content[0] ? index.content[0].text : ""), /coordinates/);
  const topic = await execute(tool, { action: "guide", topic: "safety" });
  assert.match(String(topic.content[0] && "text" in topic.content[0] ? topic.content[0].text : ""), /near[_-]zero/);
  const unknown = await execute(tool, { action: "guide", topic: "nope" });
  assert.equal(unknown.isError, true);
  assert.match(String(unknown.content[0] && "text" in unknown.content[0] ? unknown.content[0].text : ""), /Unknown SOP topic/);
});

test("computer_use routes every operation family and exposes functional renderers", async () => {
  const calls: string[] = [];
  const tool = createComputerUseTool(fakeManager(calls));
  const inputs: Record<string, unknown>[] = [
    { action: "capabilities" }, { action: "status" }, { action: "permissions" }, { action: "list_windows" },
    { action: "activate", window_id: "w" }, { action: "screenshot", source: "screen" }, { action: "ocr", source: "image", path: "x" },
    { action: "detect", source: "screen" }, { action: "ui_tree", window_id: "w" }, { action: "find_control", window_id: "w", query: "Save" },
    { action: "press_control", window_id: "w", control_ref: "r" }, { action: "click", window_id: "w", x: 1, y: 2 },
    { action: "double_click", window_id: "w", x: 1, y: 2 }, { action: "right_click", window_id: "w", x: 1, y: 2 },
    { action: "move", window_id: "w", x: 1, y: 2 }, { action: "drag", window_id: "w", x: 1, y: 2, to_x: 3, to_y: 4 },
    { action: "press", window_id: "w", keys: ["a"] }, { action: "type", window_id: "w", text: "a" },
    { action: "paste", window_id: "w", text: "a" }, { action: "find_block", source: "screen", template_path: "x" },
  ];
  for (const input of inputs) await execute(tool, input);
  assert.deepEqual(calls, inputs.map((input) => input.action));
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
  const theme = {
    fg: (_name: string, value: string) => value,
    bold: (value: string) => value,
  } as never;
  const callComponent = tool.renderCall?.({ action: "screenshot" }, theme, { isPartial: true } as never);
  const resultComponent = tool.renderResult?.(
    { content: [{ type: "text", text: "rendered" }], details: { action: "screenshot" } } as never,
    { isPartial: false, expanded: true } as never,
    theme,
    { args: { action: "screenshot" } } as never,
  );
  assert.equal(typeof callComponent?.render, "function");
  assert.equal(typeof resultComponent?.render, "function");
  assert.match(callComponent?.render(80).join("\n") ?? "", /computer_use screenshot/);
  assert.match(resultComponent?.render(80).join("\n") ?? "", /computer_use/);
  const screenshot = await execute(tool, { action: "screenshot", source: "screen" });
  assert.equal(screenshot.content.some((item) => item.type === "image"), true);
});

test("computer_use validation errors are actionable and structured", async () => {
  const tool = createComputerUseTool(fakeManager([]));
  const result = await execute(tool, { action: "click", window_id: "w" });
  assert.equal(result.isError, true);
  assert.match(String(result.content[0] && "text" in result.content[0] ? result.content[0].text : ""), /finite x and y/);
});
