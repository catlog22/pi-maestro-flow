import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MonitorToolExposureController } from "../src/extension/monitor-tool-exposure.ts";

function definition(name: string, variant: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `${variant}:${name}`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
  };
}

function harness(initialActive: string[]) {
  const tools = new Map<string, ToolDefinition>();
  const exposureEvents: Array<{ channel: string; data: unknown }> = [];
  let active = [...initialActive];
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    events: {
      emit(channel: string, data: unknown) {
        exposureEvents.push({ channel, data });
      },
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names: string[]) {
      active = [...names];
    },
  } as unknown as ExtensionAPI;
  const local = ["teammate-send", "teammate-list", "observe"].map((name) => definition(name, "local"));
  const monitor = ["teammate-send", "teammate-list", "observe"].map((name) => definition(name, "monitor"));
  const controller = new MonitorToolExposureController(pi, {
    local,
    monitor,
    exclusiveNames: ["monitor", "workspace-window", "remote-worker"],
  });
  return {
    controller,
    tools,
    exposureEvents: () => [...exposureEvents],
    active: () => [...active],
  };
}

test("root Monitor authority is set before exposure notification", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("const enterMonitorInteractionMode = (): void => {");
  const end = source.indexOf("const exitMonitorInteractionMode", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.ok(block.indexOf("monitorInteractionModeActive = true") < block.indexOf("monitorToolExposure?.enter()"));
  assert.match(block, /catch \(error\)[\s\S]*?monitorInteractionModeActive = wasActive/);
});

test("Monitor tool exposure switches variants and restores shared active-tool preferences", () => {
  const state = harness(["teammate-list", "observe", "workspace-window", "other-tool"]);
  assert.equal(state.tools.get("teammate-send")?.description, "local:teammate-send");

  state.controller.syncInactive();
  assert.deepEqual(state.active(), ["teammate-list", "observe", "other-tool"]);

  const admitted = state.controller.enter();
  assert.equal(state.controller.isCurrent(admitted), true);
  assert.equal(state.tools.get("teammate-send")?.description, "monitor:teammate-send");
  assert.deepEqual(state.active(), [
    "teammate-list",
    "observe",
    "other-tool",
    "teammate-send",
    "monitor",
    "workspace-window",
    "remote-worker",
  ]);

  state.controller.exit();
  assert.equal(state.controller.isCurrent(admitted), false);
  assert.equal(state.tools.get("teammate-send")?.description, "local:teammate-send");
  assert.deepEqual(state.active(), ["other-tool", "teammate-list", "observe"]);
  assert.deepEqual(state.exposureEvents(), [
    { channel: "teammate:monitor-tool-exposure", data: { active: true, generation: 1 } },
    { channel: "teammate:monitor-tool-exposure", data: { active: false, generation: 2 } },
  ]);
});

test("Monitor tool exposure is idempotent and a later generation fences stale captures", () => {
  const state = harness(["teammate-send", "teammate-list", "observe", "other-tool"]);
  const first = state.controller.enter();
  const repeated = state.controller.enter();
  assert.deepEqual(repeated, first);

  state.controller.exit();
  const second = state.controller.enter();
  assert.notEqual(second.generation, first.generation);
  assert.equal(state.controller.isCurrent(first), false);
  assert.equal(state.controller.isCurrent(second), true);

  state.controller.exit();
  assert.deepEqual(state.active(), ["other-tool", "teammate-send", "teammate-list", "observe"]);
});

test("Monitor tool exposure rejects mismatched or overlapping definitions", () => {
  const pi = {
    registerTool() {},
    getActiveTools: () => [],
    setActiveTools() {},
  } as unknown as ExtensionAPI;

  assert.throws(() => new MonitorToolExposureController(pi, {
    local: [definition("teammate-list", "local")],
    monitor: [definition("teammate-send", "monitor")],
    exclusiveNames: [],
  }), /same unique tool names/);

  assert.throws(() => new MonitorToolExposureController(pi, {
    local: [definition("teammate-list", "local")],
    monitor: [definition("teammate-list", "monitor")],
    exclusiveNames: ["teammate-list"],
  }), /must not overlap/);
});
