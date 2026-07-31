import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ApiModelEditorOverlay,
  type ApiModelFormField,
  type ApiModelFormValues,
  type ApiModelEditorResult,
} from "../src/tui/api-model-editor.ts";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

function createOverlay(
  fields: ApiModelFormField[],
  options: {
    validate?: (values: ApiModelFormValues) => string[];
    done?: (result: ApiModelEditorResult | undefined) => void;
  } = {},
): ApiModelEditorOverlay {
  return new ApiModelEditorOverlay({
    title: "编辑 API model",
    fields,
    theme,
    requestRender() {},
    done: options.done ?? (() => undefined),
    validate: options.validate,
  });
}

test("API model form renders existing parameters without exposing the API key", () => {
  const overlay = createOverlay([
    { id: "provider", label: "Provider", kind: "readonly", value: "maestro-openai" },
    { id: "baseUrl", label: "Base URL", kind: "text", value: "https://gateway.example.com/v1" },
    { id: "modelId", label: "Model ID", kind: "text", value: "gpt-existing" },
    { id: "contextWindow", label: "Context window", kind: "number", value: "400000" },
    { id: "reasoning", label: "Reasoning", kind: "toggle", value: true },
    { id: "apiKey", label: "API key", kind: "secret", value: "sk-live-secret-value" },
    { id: "headers", label: "Headers", kind: "secret", value: "{\"Authorization\":\"Bearer header-secret\"}" },
  ]);

  const rendered = overlay.render(100).join("\n");
  assert.match(rendered, /https:\/\/gateway\.example\.com\/v1/);
  assert.match(rendered, /gpt-existing/);
  assert.match(rendered, /400000/);
  assert.match(rendered, /sk-\*+alue/);
  assert.doesNotMatch(rendered, /sk-live-secret-value/);
  assert.doesNotMatch(rendered, /header-secret/);

  for (const width of [1, 12, 20, 40, 80, 120, 160]) {
    for (const line of overlay.render(width)) {
      assert.ok(visibleWidth(line) <= Math.min(width, 140), `width ${width}: ${visibleWidth(line)} ${line}`);
    }
  }
});

test("API model form edits multiple fields and preserves an untouched secret", () => {
  let result: ApiModelEditorResult | undefined;
  const overlay = createOverlay([
    { id: "modelId", label: "Model ID", kind: "text", value: "old-model" },
    { id: "contextWindow", label: "Context window", kind: "number", value: "200000" },
    { id: "reasoning", label: "Reasoning", kind: "toggle", value: true },
    { id: "apiKey", label: "API key", kind: "secret", value: "stored-secret" },
  ], { done(value) { result = value; } });

  overlay.render(80);
  overlay.handleInput("\r");
  overlay.handleInput("\x15");
  overlay.handleInput("new-model");
  overlay.handleInput("\r");
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  overlay.handleInput("\x15");
  overlay.handleInput("333000");
  overlay.handleInput("\r");
  overlay.handleInput("\x1b[B");
  overlay.handleInput(" ");
  overlay.handleInput("\x13");

  assert.deepEqual(result?.values, {
    modelId: "new-model",
    contextWindow: "333000",
    reasoning: false,
    apiKey: "stored-secret",
  });
});

test("API model form replaces secrets without rendering plaintext", () => {
  let result: ApiModelEditorResult | undefined;
  const overlay = createOverlay([
    { id: "apiKey", label: "API key", kind: "secret", value: "old-secret" },
  ], { done(value) { result = value; } });

  overlay.render(80);
  overlay.handleInput("\r");
  overlay.handleInput("replacement-secret");
  assert.doesNotMatch(overlay.render(80).join("\n"), /replacement-secret/);
  overlay.handleInput("\r");
  assert.doesNotMatch(overlay.render(80).join("\n"), /replacement-secret/);
  overlay.handleInput("\x13");
  assert.equal(result?.values.apiKey, "replacement-secret");
});

test("API model form cancels a pending secret clear", async () => {
  let result: ApiModelEditorResult | undefined;
  const overlay = createOverlay([
    { id: "apiKey", label: "API key", kind: "secret", value: "old-secret" },
  ], { done(value) { result = value; } });

  overlay.render(80);
  overlay.handleInput("\r");
  overlay.handleInput("\x15");
  overlay.handleInput("\x1b");
  await flushInput();
  overlay.handleInput("\x13");
  assert.equal(result?.values.apiKey, "old-secret");
});

test("API model form validates inline and uses layered Esc cancellation", async () => {
  const results: Array<ApiModelEditorResult | undefined> = [];
  const overlay = createOverlay([
    { id: "contextWindow", label: "Context window", kind: "number", value: "200000" },
  ], {
    validate(values) { return values.contextWindow === "0" ? ["contextWindow 必须大于 0"] : []; },
    done(value) { results.push(value); },
  });

  overlay.render(80);
  overlay.handleInput("\r");
  overlay.handleInput("\x15");
  overlay.handleInput("0");
  overlay.handleInput("\r");
  overlay.handleInput("\x13");
  assert.deepEqual(results, []);
  assert.match(overlay.render(80).join("\n"), /contextWindow 必须大于 0/);

  overlay.handleInput("\x1b");
  await flushInput();
  assert.deepEqual(results, []);
  assert.match(overlay.render(80).join("\n"), /再按 Esc 放弃/);
  overlay.handleInput("\x1b");
  await flushInput();
  assert.deepEqual(results, [undefined]);
});

function flushInput(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

test("API model form renders section headers, skips them in navigation, and excludes them from values", async () => {
  let result: ApiModelEditorResult | undefined;
  const overlay = createOverlay([
    { id: "conn-section", label: "连接（Provider 级）", kind: "section", value: "" },
    { id: "baseUrl", label: "Base URL", kind: "text", value: "https://a.example.com" },
    { id: "model-section", label: "模型（Model 级）", kind: "section", value: "" },
    { id: "modelId", label: "Model ID", kind: "text", value: "m1" },
  ], { done(value) { result = value; } });

  const rendered = overlay.render(100).join("\n");
  assert.match(rendered, /连接（Provider 级）/);
  assert.match(rendered, /模型（Model 级）/);

  // First editable field (baseUrl) is focused first; down jumps past the section to modelId.
  overlay.handleInput("\x1b[B");
  overlay.handleInput("\r");
  overlay.handleInput("\x15");
  overlay.handleInput("m2");
  overlay.handleInput("\r");
  overlay.handleInput("\x13");

  assert.deepEqual(result?.values, { baseUrl: "https://a.example.com", modelId: "m2" });
});

test("API model form with unchanged sections is not dirty and cancels with a single Esc", async () => {
  const results: Array<ApiModelEditorResult | undefined> = [];
  const overlay = createOverlay([
    { id: "conn-section", label: "连接（Provider 级）", kind: "section", value: "" },
    { id: "baseUrl", label: "Base URL", kind: "text", value: "https://a.example.com" },
  ], { done(value) { results.push(value); } });

  overlay.render(80);
  overlay.handleInput("\x1b");
  await flushInput();
  assert.deepEqual(results, [undefined]);
  assert.doesNotMatch(overlay.render(80).join("\n"), /再按 Esc 放弃/);
});
