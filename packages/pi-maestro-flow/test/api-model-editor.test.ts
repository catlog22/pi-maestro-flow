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
    discoverModels?: (values: ApiModelFormValues) => Promise<string[]>;
  } = {},
): ApiModelEditorOverlay {
  return new ApiModelEditorOverlay({
    title: "编辑 API model",
    fields,
    locale: "zh-CN",
    theme,
    requestRender() {},
    done: options.done ?? (() => undefined),
    validate: options.validate,
    discoverModels: options.discoverModels,
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

test("API model form ignores navigation/function keys while editing a text field", () => {
  let result: ApiModelEditorResult | undefined;
  const overlay = createOverlay([
    { id: "baseUrl", label: "Base URL", kind: "text", value: "https://gateway.example.com" },
  ], { done(value) { result = value; } });

  overlay.render(80);
  overlay.handleInput("\r"); // 进入编辑模式
  overlay.handleInput("\x1b[A"); // 上
  overlay.handleInput("\x1b[B"); // 下
  overlay.handleInput("\x1b[C"); // 右
  overlay.handleInput("\x1b[D"); // 左
  overlay.handleInput("\x1b[3~"); // Delete
  overlay.handleInput("\x1b[5~"); // PageUp
  overlay.handleInput("\x1bOP"); // F1
  overlay.handleInput("/v1");
  overlay.handleInput("\r");
  overlay.handleInput("\x13");

  assert.equal(result?.values.baseUrl, "https://gateway.example.com/v1");
  assert.doesNotMatch(overlay.render(80).join("\n"), /\[A/);
});

test("API model form drops unrecognized ESC-prefixed sequences in edit mode", () => {
  let result: ApiModelEditorResult | undefined;
  const overlay = createOverlay([
    { id: "baseUrl", label: "Base URL", kind: "text", value: "" },
  ], { done(value) { result = value; } });

  overlay.render(80);
  overlay.handleInput("\r");
  overlay.handleInput("\x1b[1;5A"); // 未识别的修饰方向键序列
  overlay.handleInput("\x1b[?25l"); // 光标隐藏（SM/RM）
  overlay.handleInput("https://a.example.com");
  overlay.handleInput("\r");
  overlay.handleInput("\x13");

  assert.equal(result?.values.baseUrl, "https://a.example.com");
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

test("API model form discovers gateway models into the Model ID field via Ctrl+D", async () => {
  let result: ApiModelEditorResult | undefined;
  let receivedValues: ApiModelFormValues | undefined;
  const overlay = createOverlay([
    { id: "baseUrl", label: "Base URL", kind: "text", value: "https://relay/v1" },
    { id: "modelId", label: "Model ID", kind: "text", value: "", discoverable: true },
  ], {
    done(value) { result = value; },
    async discoverModels(values) {
      receivedValues = { ...values } as ApiModelFormValues;
      return ["model-a", "model-b"];
    },
  });

  overlay.render(80);
  overlay.handleInput("\x1b[B"); // baseUrl → modelId
  // Footer advertises the shortcut while the discoverable field is focused.
  assert.match(overlay.render(80).join("\n"), /Ctrl\+D 识别模型/);

  overlay.handleInput("\x04"); // Ctrl+D 打开识别
  await flushInput();
  const picking = overlay.render(80).join("\n");
  assert.match(picking, /model-a/);
  assert.match(picking, /model-b/);

  overlay.handleInput(" "); // 勾选 model-a
  overlay.handleInput("\x1b[B"); // 光标到 model-b
  overlay.handleInput(" "); // 勾选 model-b
  overlay.handleInput("\r"); // 确认回填
  overlay.handleInput("\x13"); // Ctrl+S 提交表单

  assert.equal(receivedValues?.baseUrl, "https://relay/v1");
  assert.equal(result?.values.modelId, "model-a,model-b");
});

test("API model form pre-checks ids already present in the Model ID field", async () => {
  let result: ApiModelEditorResult | undefined;
  const overlay = createOverlay([
    { id: "modelId", label: "Model ID", kind: "text", value: "old-model", discoverable: true },
  ], {
    done(value) { result = value; },
    async discoverModels() { return ["old-model", "new-model"]; },
  });

  overlay.render(80);
  overlay.handleInput("\x04");
  await flushInput();
  assert.match(overlay.render(80).join("\n"), /\[x\] old-model/);
  assert.match(overlay.render(80).join("\n"), /\[ \] new-model/);

  overlay.handleInput("\x04"); // 已在识别列表时 Ctrl+D 无效
  await flushInput();
  assert.match(overlay.render(80).join("\n"), /\[x\] old-model/);

  overlay.handleInput("\r"); // 不改动直接确认 → 保留原值
  overlay.handleInput("\x13");
  assert.equal(result?.values.modelId, "old-model");
});

test("API model form keeps the field untouched when confirming an empty discovery selection", async () => {
  let result: ApiModelEditorResult | undefined;
  const overlay = createOverlay([
    { id: "modelId", label: "Model ID", kind: "text", value: "keep-me", discoverable: true },
  ], {
    done(value) { result = value; },
    async discoverModels() { return ["model-a"]; },
  });

  overlay.render(80);
  overlay.handleInput("\x04");
  await flushInput();
  overlay.handleInput(" "); // 勾选后又取消
  overlay.handleInput(" ");
  overlay.handleInput("\r"); // 空选确认 → 不改动字段
  overlay.handleInput("\x13");
  assert.equal(result?.values.modelId, "keep-me");
});

test("API model form surfaces discovery failures and returns to the form", async () => {
  const overlay = createOverlay([
    { id: "modelId", label: "Model ID", kind: "text", value: "", discoverable: true },
  ], {
    async discoverModels() { throw new Error("HTTP 401 Unauthorized"); },
  });

  overlay.render(80);
  overlay.handleInput("\x04");
  await flushInput();
  const rendered = overlay.render(80).join("\n");
  assert.match(rendered, /HTTP 401 Unauthorized/);
  assert.doesNotMatch(rendered, /\[ \] model-a/);

  // 失败后回到表单，Esc 仍走正常取消路径。
  overlay.handleInput("\x1b");
  await flushInput();
  assert.match(overlay.render(80).join("\n"), /再按 Esc 放弃|Model ID/);
});

test("API model form shows an empty notice when discovery returns no new models", async () => {
  const overlay = createOverlay([
    { id: "modelId", label: "Model ID", kind: "text", value: "", discoverable: true },
  ], {
    async discoverModels() { return []; },
  });

  overlay.render(80);
  overlay.handleInput("\x04");
  await flushInput();
  assert.match(overlay.render(80).join("\n"), /未识别到新模型/);
});
