import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { ModelAskOverlay, type ModelAskResult, type ModelAskTask } from "../src/tui/model-ask-overlay.ts";
import type { TeammateModelCapability } from "../src/models/model-catalog.ts";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

const MODELS: readonly TeammateModelCapability[] = [
  { id: "maestro-openai/gpt-5.6-sol", reasoning: true },
  { id: "maestro-qwen--deepseek-v4-flash/deepseek-v4-flash", reasoning: true },
];

const TASKS: readonly ModelAskTask[] = [
  { agent: "explorer", model: "maestro-openai/gpt-5.6-sol", thinking: "medium", prompt: "Find the auth middleware" },
  { agent: "general", name: "builder", model: undefined, thinking: undefined, prompt: "Implement the fix" },
];

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";

function makeOverlay(tasks: readonly ModelAskTask[] = TASKS, options: Record<string, unknown> = {}) {
  const results: Array<ModelAskResult | null> = [];
  const overlay = new ModelAskOverlay(
    theme,
    {
      tasks,
      availableModels: MODELS,
      sessionModel: "maestro-openai/gpt-5.6-sol",
      ...options,
    } as never,
    () => {},
    (result) => results.push(result),
  );
  return { overlay, results };
}

function feed(overlay: ModelAskOverlay, keys: string[]): void {
  for (const key of keys) {
    // The TUI delivers one key per handleInput; expand printable words into
    // individual characters so the search query accumulates like real input.
    if (key.length > 1 && key.charCodeAt(0) >= 32 && !key.startsWith("\x1b")) {
      for (const char of key) overlay.handleInput(char);
    } else {
      overlay.handleInput(key);
    }
  }
}

test("confirm without changes keeps every task untouched", () => {
  const { overlay, results } = makeOverlay();
  feed(overlay, [ENTER]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.confirmed, true);
  assert.deepEqual(results[0]!.overrides, [undefined, undefined]);
});

test("escape cancels the dispatch", () => {
  const { overlay, results } = makeOverlay();
  feed(overlay, [ESC]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.confirmed, false);
});

test("escape inside a picker returns to the task list without cancelling", () => {
  const { overlay, results } = makeOverlay();
  feed(overlay, ["m", ESC, ENTER]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.confirmed, true);
});

test("model picker applies a provider/model override to the selected task", () => {
  const { overlay, results } = makeOverlay();
  feed(overlay, ["m", DOWN, DOWN, ENTER, ENTER]);
  const override = results[0]!.overrides[0]!;
  assert.equal(override.model, "maestro-qwen--deepseek-v4-flash/deepseek-v4-flash");
  assert.equal(override.thinking, undefined);
});

test("model picker supports inherit and clears a previous override", () => {
  const { overlay, results } = makeOverlay([{ agent: "explorer", model: "maestro-openai/gpt-5.6-sol", prompt: "p" }]);
  feed(overlay, ["m", DOWN, ENTER, "m", ENTER, ENTER]);
  const override = results[0]!.overrides[0]!;
  assert.equal(override.model, null);
});

test("model picker filters by provider name", () => {
  const { overlay, results } = makeOverlay();
  feed(overlay, ["m", "deepseek", DOWN, ENTER, ENTER]);
  const override = results[0]!.overrides[0]!;
  assert.equal(override.model, "maestro-qwen--deepseek-v4-flash/deepseek-v4-flash");
});

test("thinking picker applies a level to the selected task", () => {
  const { overlay, results } = makeOverlay([{ agent: "explorer", prompt: "p" }]);
  feed(overlay, ["t", DOWN, DOWN, ENTER, ENTER]);
  const override = results[0]!.overrides[0]!;
  assert.equal(override.thinking, "minimal");
});

test("thinking picker inherit entry clears a resolved level to inherit", () => {
  const { overlay, results } = makeOverlay([{ agent: "explorer", model: "m/x", thinking: "high", prompt: "p" }]);
  feed(overlay, ["t", DOWN, DOWN, DOWN, ENTER, ENTER]);
  const override = results[0]!.overrides[0]!;
  assert.equal(override.thinking, null);
});

test("task navigation moves the cursor and pickers target the selected task", () => {
  const { overlay, results } = makeOverlay();
  feed(overlay, [DOWN, "m", DOWN, ENTER, ENTER]);
  const override = results[0]!.overrides[1]!;
  assert.equal(override.model, "maestro-openai/gpt-5.6-sol");
  assert.equal(results[0]!.overrides[0], undefined);
});

test("rendered lines stay control-free and show provider/model info", () => {
  const { overlay } = makeOverlay();
  const lines = overlay.render(80);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.doesNotMatch(line, /[\x00-\x08\x0b-\x1f\x7f]/);
  }
  overlay.handleInput("m");
  const pickerLines = overlay.render(80);
  assert.ok(pickerLines.some((line) => line.includes("gpt-5.6-sol")));
  assert.ok(pickerLines.some((line) => line.includes("[maestro-openai]")));
  void matchesKey;
});

// ---------------------------------------------------------------------------
// Location picker
// ---------------------------------------------------------------------------

const REMOTE_LOCATIONS = [
  { id: "linux-a/pi", driver: "pi-rpc", host: "linux-a", cwd: "/srv/project" },
];

const WORKSPACE = mkdtempSync(join(tmpdir(), "pi-ask-location-"));

function locationOverlay(options: Record<string, unknown> = {}) {
  return makeOverlay(
    [{ agent: "explorer", prompt: "find things" }],
    { defaultCwd: WORKSPACE, remoteLocations: REMOTE_LOCATIONS, ...options },
  );
}

test("l opens the location picker and the current workspace is the default", () => {
  const { overlay, results } = locationOverlay();
  const lines = overlay.render(80);
  assert.ok(lines.some((line) => line.includes("l location")), "footer advertises the location key");
  feed(overlay, ["l", ENTER, ENTER]);
  assert.equal(results[0]!.confirmed, true);
  assert.deepEqual(results[0]!.overrides[0], { cwd: null });
});

test("location picker applies a remote target override when Monitor is active", () => {
  const { overlay, results } = locationOverlay({ monitorActive: true });
  feed(overlay, ["l", DOWN, DOWN, ENTER, ENTER]);
  const override = results[0]!.overrides[0]!;
  assert.equal(override.cwd, "remote:linux-a/pi");
});

test("remote locations are disabled without Monitor mode", () => {
  const { overlay, results } = locationOverlay({ monitorActive: false });
  feed(overlay, ["l", DOWN, DOWN, ENTER, ESC, ENTER]);
  assert.equal(results[0]!.overrides[0], undefined);
});

test("custom location accepts an existing in-workspace directory", () => {
  const { overlay, results } = locationOverlay();
  feed(overlay, ["l", DOWN, ENTER, ".", ENTER, ENTER]);
  const override = results[0]!.overrides[0]!;
  assert.equal(override.cwd, WORKSPACE);
});

test("custom location rejects a missing directory and stays in the picker", () => {
  const { overlay, results } = locationOverlay();
  feed(overlay, ["l", DOWN, ENTER, "no-such-dir", ENTER]);
  const lines = overlay.render(80);
  assert.ok(lines.some((line) => line.includes("Directory not found")), "status shows the error");
  feed(overlay, [ESC, ESC, ESC]);
  assert.equal(results[0]!.confirmed, false);
});

test("outside-workspace path requires explicit confirmation", () => {
  const { overlay, results } = locationOverlay();
  const outside = join(WORKSPACE, "..");
  feed(overlay, ["l", DOWN, ENTER, outside, ENTER, "y", ENTER]);
  const override = results[0]!.overrides[0]!;
  assert.equal(override.cwd, outside);
});

test("outside-workspace path confirmation can be declined", () => {
  const { overlay, results } = locationOverlay();
  const outside = join(WORKSPACE, "..");
  feed(overlay, ["l", DOWN, ENTER, outside, ENTER, "n", ESC, ESC, ESC]);
  assert.equal(results[0]!.confirmed, false);
  assert.deepEqual(results[0]!.overrides, []);
});

test("a applies the selected location to every task", () => {
  const { overlay, results } = makeOverlay(
    [
      { agent: "explorer", prompt: "one" },
      { agent: "general", prompt: "two" },
    ],
    { defaultCwd: WORKSPACE, remoteLocations: REMOTE_LOCATIONS, monitorActive: true },
  );
  feed(overlay, ["l", DOWN, DOWN, "a", ENTER]);
  assert.equal(results[0]!.overrides[0]!.cwd, "remote:linux-a/pi");
  assert.equal(results[0]!.overrides[1]!.cwd, "remote:linux-a/pi");
});

test("escape inside the location picker returns to the task list", () => {
  const { overlay, results } = locationOverlay();
  feed(overlay, ["l", ESC, ENTER]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.confirmed, true);
  assert.equal(results[0]!.overrides[0], undefined);
});

test("task rows show the resolved location badge", () => {
  const { overlay } = locationOverlay({ monitorActive: true });
  const lines = overlay.render(80);
  assert.ok(lines.some((line) => line.includes("@current")), "default location badge rendered");
  feed(overlay, ["l", DOWN, DOWN, ENTER]);
  const after = overlay.render(80);
  assert.ok(after.some((line) => line.includes("remote:")), "remote badge rendered after override");
});
