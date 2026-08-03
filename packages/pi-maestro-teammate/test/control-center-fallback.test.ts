import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCircuitSnapshot } from "../src/models/model-circuit-breaker.ts";
import { TeammateControlCenter } from "../src/tui/model-mapping-overlay.ts";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

const MODELS = [
  { id: "a/gpt", reasoning: true, thinkingLevels: ["low"] as const },
  { id: "b/qwen", reasoning: true, thinkingLevels: ["low"] as const },
];

interface CenterOverrides {
  saveFallbacks?: (taskType: string, models: string[] | null) => void;
  modelHealth?: ModelCircuitSnapshot[];
  fallbackMappings?: Record<string, string[]>;
}

function center(overrides: CenterOverrides = {}) {
  return new TeammateControlCenter({
    cwd: "C:\\tmp\\project",
    availableModels: MODELS,
    agents: [],
    activeAgents: [],
    config: {
      version: 2,
      mappings: {},
      thinkingLevels: {},
      ...(overrides.fallbackMappings ? { fallbackMappings: overrides.fallbackMappings } : {}),
    },
    modelHealth: overrides.modelHealth,
    theme,
    requestRender: () => {},
    close: () => {},
    ...(overrides.saveFallbacks ? { saveFallbacks: overrides.saveFallbacks } : {}),
  });
}

test("Ctrl+F opens the fallback editor and Space + Enter saves the chain", async () => {
  const saved: unknown[] = [];
  const control = center({ saveFallbacks: (...args) => saved.push(args) });
  control.render(80);
  control.handleInput("\x06"); // Ctrl+F
  const editor = control.render(80).join("\n");
  assert.match(editor, /Fallback/);
  assert.match(editor, /a\/gpt/);
  control.handleInput(" "); // include first model
  control.handleInput("\r"); // Enter saves
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved, [["explore", ["a/gpt"]]]);
  assert.match(control.render(80).join("\n"), /Saved fallbacks/);
});

test("Ctrl+Up/Down reorders included fallbacks before save", async () => {
  const saved: unknown[] = [];
  const control = center({
    saveFallbacks: (...args) => saved.push(args),
    fallbackMappings: { explore: ["b/qwen", "a/gpt"] },
  });
  control.render(80);
  control.handleInput("\x06"); // Ctrl+F
  control.handleInput("\x1bOa"); // Ctrl+Up: move first fallback (b/qwen) up — boundary, no-op
  control.handleInput("\x1bOb"); // Ctrl+Down: move b/qwen after a/gpt
  control.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved, [["explore", ["a/gpt", "b/qwen"]]]);
});

test("removing every fallback saves null (none)", async () => {
  const saved: unknown[] = [];
  const control = center({
    saveFallbacks: (...args) => saved.push(args),
    fallbackMappings: { explore: ["a/gpt"] },
  });
  control.render(80);
  control.handleInput("\x06"); // Ctrl+F
  control.handleInput(" "); // remove a/gpt
  control.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved, [["explore", null]]);
});

test("Escape discards the fallback draft without saving", async () => {
  const saved: unknown[] = [];
  const control = center({ saveFallbacks: (...args) => saved.push(args) });
  control.render(80);
  control.handleInput("\x06"); // Ctrl+F
  control.handleInput(" "); // include model
  control.handleInput("\x1b"); // Esc discards and returns to routing
  control.handleInput("\r"); // Enter now opens the model editor, not a save
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved, []);
});

test("fallback editor and routing detail surface circuit health", () => {
  const health: ModelCircuitSnapshot[] = [{
    model: "a/gpt",
    state: "OPEN",
    consecutiveFailures: 3,
    halfOpenTrialInProgress: false,
  }];
  const control = center({
    modelHealth: health,
    fallbackMappings: { explore: ["a/gpt"] },
  });
  const main = control.render(80).join("\n");
  assert.match(main, /Circuit · a\/gpt OPEN/);
  control.handleInput("\x06"); // Ctrl+F
  const editor = control.render(80).join("\n");
  assert.match(editor, /circuit open/);
  assert.match(editor, /3 failures/);
});

test("fallback editor respects the read-only gate like other editors", () => {
  const control = center({});
  (control as unknown as { params: { readOnly: boolean } }).params.readOnly = true;
  const closed: unknown[] = [];
  (control as unknown as { params: { close: (action: unknown) => void } }).params.close = (action) => closed.push(action);
  control.render(80);
  control.handleInput("\x06");
  assert.deepEqual(closed, [{ kind: "reload", tab: "routing" }]);
});
