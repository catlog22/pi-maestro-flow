import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { executeAsk } from "../src/tools/ask.ts";
import { BracketedPasteDecoder } from "../src/tui/input-text.ts";

function createHarness() {
  let component: { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void } | undefined;
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let overlay = false;
  let overlayOptions: unknown;
  let cleared = false;
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
  const hostTui = { requestRender() {} };
  const ui = {
    setWidget() {
      throw new Error("ask wizard no longer uses setWidget");
    },
    custom<T>(
      factory: (
        tui: typeof hostTui,
        theme: typeof theme,
        _keybindings: unknown,
        done: (result: T | undefined) => void,
      ) => unknown,
      options?: { overlay?: boolean; overlayOptions?: unknown },
    ) {
      overlay = options?.overlay === true;
      overlayOptions = options?.overlayOptions;
      return new Promise<T | undefined>((resolve) => {
        let resolved = false;
        const done = (result: T | undefined) => {
          if (resolved) return;
          resolved = true;
          cleared = true;
          component?.dispose?.();
          resolve(result);
        };
        component = factory(hostTui, theme, {}, done) as typeof component;
        // The TUI routes keys to the focused overlay component; the harness
        // simulates that dispatch on the captured component.
        inputHandler = (data: string) => {
          if (component?.handleInput) {
            component.handleInput(data);
            return { consume: true };
          }
          return undefined;
        };
      });
    },
    onTerminalInput() {
      throw new Error("ask wizard no longer subscribes terminal input");
    },
  };
  const ctx = { hasUI: true, ui } as unknown as ExtensionContext;
  return {
    ctx,
    get component() { return component; },
    get handler() { return inputHandler; },
    get overlay() { return overlay; },
    get overlayOptions() { return overlayOptions; },
    get cleared() { return cleared; },
  };
}

test("single select previews the answer before explicit submission", async () => {
  const harness = createHarness();
  const pending = executeAsk({
    questions: [{
      question: "Choose a deployment style",
      options: [
        { label: "Preset", description: "Fast path" },
        { label: "Custom", description: "Full control" },
      ],
    }],
  }, harness.ctx);

  assert.equal(harness.overlay, true);
  assert.ok(harness.component);
  assert.ok(harness.handler);

  for (const width of [12, 19, 20, 40, 80]) {
    const lines = harness.component.render(width);
    assert.ok(lines.length <= 12);
    assert.doesNotMatch(lines.join("\n"), /\[[ x]\]|✓/);
    if (width >= 40) assert.match(lines.join("\n"), /以上都不是/);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }

  assert.equal(harness.handler("1")?.consume, true); // Select Preset directly.
  assert.match(harness.component.render(80).join("\n"), /Preset  已选/);
  assert.match(harness.component.render(80).join("\n"), /附加说明（按 d 添加）/);
  assert.match(harness.component.render(80).join("\n"), /Enter 选择\/确认/);
  harness.handler("d");
  harness.handler("Prefer the nearest region");
  harness.handler("\r"); // Save details without replacing the option.
  harness.handler("\r"); // Open the preview after confirming the answer.
  const preview = harness.component.render(80).join("\n");
  assert.match(preview, /核对答案/);
  assert.match(preview, /提交/);
  assert.match(preview, /取消/);
  assert.equal(harness.cleared, false);
  harness.handler("\r"); // Submit the preview.

  const result = await pending;
  assert.deepEqual(result.details.answers[0].selected, ["Preset"]);
  assert.deepEqual(result.details.answers[0].details, { Preset: "Prefer the nearest region" });
  assert.equal(result.details.answers[0].text, undefined);
  assert.equal(harness.cleared, true);
  assert.equal(harness.overlay, true);
});

test("single select Enter allows details before advancing and after back navigation", async () => {
  const harness = createHarness();
  const pending = executeAsk({
    questions: [
      { question: "First question?", options: [{ label: "A" }, { label: "B" }] },
      { question: "Second question?", options: [{ label: "C" }, { label: "D" }] },
    ],
  }, harness.ctx);

  harness.handler?.("\r"); // Select A without advancing.
  let rendered = harness.component?.render(80).join("\n") ?? "";
  assert.match(rendered, /First question\?/);
  assert.match(rendered, /A  已选/);

  harness.handler?.("d");
  harness.handler?.("initial");
  harness.handler?.("\r");
  harness.handler?.("\r"); // Confirm A and advance.
  assert.match(harness.component?.render(80).join("\n") ?? "", /Second question\?/);

  harness.handler?.("\x1b[D"); // Return to the first question.
  rendered = harness.component?.render(80).join("\n") ?? "";
  assert.match(rendered, /First question\?/);
  assert.match(rendered, /附加说明：initial/);

  harness.handler?.("d");
  harness.handler?.(" updated");
  harness.handler?.("\r");
  harness.handler?.("\r");
  harness.handler?.("1");
  harness.handler?.("\r");
  harness.handler?.("\r");

  const result = await pending;
  assert.deepEqual(result.details.answers[0].selected, ["A"]);
  assert.deepEqual(result.details.answers[0].details, { A: "initial updated" });
  assert.deepEqual(result.details.answers[1].selected, ["C"]);
});

test("single select keypad Enter uses two-stage confirmation", async () => {
  const harness = createHarness();
  const pending = executeAsk({
    questions: [{ question: "Choose one", options: [{ label: "A" }] }],
  }, harness.ctx);

  harness.handler?.("\x1bOM");
  assert.match(harness.component?.render(80).join("\n") ?? "", /A  已选/);
  harness.handler?.("\x1bOM");
  assert.match(harness.component?.render(80).join("\n") ?? "", /核对答案/);
  harness.handler?.("\x1bOM");

  const result = await pending;
  assert.deepEqual(result.details.answers[0].selected, ["A"]);
});

test("review uses up and down to choose submit or cancel", async () => {
  const harness = createHarness();
  const pending = executeAsk({
    questions: [{ question: "Choose one", options: [{ label: "A" }] }],
  }, harness.ctx);

  harness.handler?.("1");
  harness.handler?.("\r");
  const review = harness.component?.render(80).join("\n") ?? "";
  assert.match(review, /提交\s*\n\s*取消/);
  assert.match(review, /↑↓\/Tab 选择操作/);
  harness.handler?.("\x1b[B");
  harness.handler?.("\r");

  const result = await pending;
  assert.equal(result.details.cancelled, true);
});

test("single select right arrow and Tab keep direct progression", async () => {
  const harness = createHarness();
  const pending = executeAsk({
    questions: [
      { question: "First question?", options: [{ label: "A" }] },
      { question: "Second question?", options: [{ label: "B" }] },
    ],
  }, harness.ctx);

  harness.handler?.("\x1b[C");
  assert.match(harness.component?.render(80).join("\n") ?? "", /Second question\?/);
  harness.handler?.("\t");
  assert.match(harness.component?.render(80).join("\n") ?? "", /核对答案/);
  harness.handler?.("\r");

  const result = await pending;
  assert.deepEqual(result.details.answers.map((answer) => answer.selected), [["A"], ["B"]]);
});

test("single select none-of-the-above captures a custom answer", async () => {
  const harness = createHarness();
  const pending = executeAsk({
    questions: [{
      question: "Pick a region",
      options: [{ label: "East" }, { label: "West" }],
    }],
  }, harness.ctx);

  // Options: East(0), West(1), None of the above(2).
  harness.handler?.("3"); // select None of the above
  harness.handler?.("\r"); // Enter on none auto-opens the custom input once
  harness.handler?.("I want the nearest region");
  harness.handler?.("\r"); // save custom text, return to choices
  harness.handler?.("\r"); // open preview
  harness.handler?.("\r"); // submit

  const result = await pending;
  assert.deepEqual(result.details.answers[0].selected, ["以上都不是"]);
  assert.equal(result.details.answers[0].text, "I want the nearest region");
});

test("single select none-of-the-above can be confirmed without an explanation", async () => {
  const harness = createHarness();
  const pending = executeAsk({
    questions: [{
      question: "Pick a region",
      options: [{ label: "East" }, { label: "West" }],
    }],
  }, harness.ctx);

  harness.handler?.("3"); // select None of the above
  harness.handler?.("\r"); // auto-opens custom input
  harness.handler?.("\r"); // empty input saves nothing, back to choices
  harness.handler?.("\r"); // open preview without looping back into the input
  harness.handler?.("\r"); // submit

  const result = await pending;
  assert.deepEqual(result.details.answers[0].selected, ["以上都不是"]);
  assert.equal(result.details.answers[0].text, undefined);
});

test("multi-select captures independent details per option", async () => {
  const harness = createHarness();
  const pending = executeAsk({
    questions: [{
      question: "Choose checks",
      multiSelect: true,
      options: [{ label: "Tests" }, { label: "Lint" }],
    }],
  }, harness.ctx);

  harness.handler?.("1"); // toggle Tests
  harness.handler?.("d"); // detail for Tests
  harness.handler?.("unit only");
  harness.handler?.("\r"); // save detail
  harness.handler?.("2"); // toggle Lint
  harness.handler?.("d"); // detail for Lint
  harness.handler?.("strict");
  harness.handler?.("\r"); // save detail
  harness.handler?.("\r"); // open preview
  harness.handler?.("\r"); // submit

  const result = await pending;
  assert.deepEqual(result.details.answers[0].selected, ["Tests", "Lint"]);
  assert.deepEqual(result.details.answers[0].details, { Tests: "unit only", Lint: "strict" });
});

test("multi-select keeps checkbox affordances", async () => {
  const harness = createHarness();
  const pending = executeAsk({
    questions: [{
      question: "Choose checks",
      multiSelect: true,
      options: [{ label: "Tests" }, { label: "Lint" }],
    }],
  }, harness.ctx);

  const rendered = harness.component?.render(80).join("\n") ?? "";
  assert.match(rendered, /\[ \]/);
  assert.match(rendered, /以上都不是/);
  harness.handler?.("3");
  harness.handler?.("1");
  harness.handler?.("\r");
  harness.handler?.("\r");
  const result = await pending;
  assert.deepEqual(result.details.answers[0].selected, ["Tests"]);
});

test("multi-select none option remains exclusive", async () => {
  const harness = createHarness();
  const pending = executeAsk({
    questions: [{
      question: "Choose checks",
      multiSelect: true,
      options: [{ label: "Tests" }, { label: "Lint" }],
    }],
  }, harness.ctx);

  harness.handler?.("1");
  harness.handler?.("3");
  harness.handler?.("\r");
  harness.handler?.("\r");
  const result = await pending;
  assert.deepEqual(result.details.answers[0].selected, ["以上都不是"]);
});

test("multi-question review includes each full question and final option", async () => {
  const harness = createHarness();
  const pending = executeAsk({
    questions: [
      { question: "First full question?", header: "First", options: [{ label: "A" }, { label: "B" }] },
      { question: "Second full question?", header: "Second", options: [{ label: "C" }, { label: "D" }] },
    ],
  }, harness.ctx);

  harness.handler?.("1");
  harness.handler?.("\r"); // Next.
  harness.handler?.("2");
  harness.handler?.("\r"); // Next.
  let preview = harness.component?.render(100).join("\n") ?? "";
  assert.match(preview, /› 1\. First full question\?.*A/);
  assert.match(preview, /Second full question\?.*D/);
  assert.match(preview, /←→ 切换问题/);

  harness.handler?.("\x1b[C");
  preview = harness.component?.render(100).join("\n") ?? "";
  assert.match(preview, /› 2\. Second full question\?.*D/);
  harness.handler?.("\x1b[D");
  preview = harness.component?.render(100).join("\n") ?? "";
  assert.match(preview, /› 1\. First full question\?.*A/);
  harness.handler?.("\x1bOM");

  const result = await pending;
  assert.deepEqual(result.details.answers.map((answer) => answer.selected), [["A"], ["D"]]);
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /First full question\?/);
});

test("free response decodes bracketed paste and deletes a whole grapheme", async () => {
  const harness = createHarness();
  const pending = executeAsk({ questions: [{ question: "Describe it" }] }, harness.ctx);
  harness.handler?.("\x1b[20");
  harness.handler?.("0~A👨‍👩‍👧‍👦\x1b[20");
  harness.handler?.("1~");
  harness.handler?.("\x7f");
  harness.handler?.("\r");
  assert.match(harness.component?.render(80).join("\n") ?? "", /核对答案/);
  harness.handler?.("\r");
  const result = await pending;
  assert.equal(result.details.answers[0].text, "A");
});

test("bracketed paste markers survive every byte split", () => {
  const encoded = "\x1b[200~X\x1b[201~";
  for (let split = 1; split < encoded.length; split++) {
    const decoder = new BracketedPasteDecoder();
    const tokens = [...decoder.feed(encoded.slice(0, split)), ...decoder.feed(encoded.slice(split))];
    assert.deepEqual(tokens, [{ kind: "paste", text: "X" }], `split ${split}`);
  }
});

test("unterminated bracketed paste is bounded", () => {
  const decoder = new BracketedPasteDecoder();
  assert.deepEqual(decoder.feed(`\x1b[200~${"x".repeat(1_048_600)}`), []);
  const [token] = decoder.feed("\x1b[201~");
  assert.equal(token.kind, "paste");
  assert.equal(token.text.length, 1_048_576);
});

test("host-driven widget disposal settles the questionnaire", async () => {
  const harness = createHarness();
  const pending = executeAsk({ questions: [{ question: "Choose", options: [{ label: "A" }] }] }, harness.ctx);
  harness.component?.dispose?.();
  const result = await pending;
  assert.equal(result.details.cancelled, true);
  assert.equal(harness.cleared, true);
});

test("questionnaire blocks invisible input and submit below 20 columns", async () => {
  const harness = createHarness();
  const pending = executeAsk({ questions: [{ question: "Choose", options: [{ label: "A" }] }] }, harness.ctx);
  harness.component?.render(12);
  harness.handler?.("1");
  harness.handler?.("\r");
  assert.equal(harness.cleared, false);
  harness.handler?.("\x1b");
  const result = await pending;
  assert.equal(result.details.cancelled, true);
});

test("RPC mode uses official dialog methods instead of terminal widgets", async () => {
  const calls: string[] = [];
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      async select(_title: string, options: string[]) {
        calls.push("select");
        return options[0];
      },
      async input() {
        calls.push("input");
        return "Nearest region";
      },
      setWidget() { throw new Error("RPC must not install a terminal widget"); },
      onTerminalInput() { throw new Error("RPC must not capture terminal input"); },
    },
  } as unknown as ExtensionContext;
  const result = await executeAsk({
    questions: [
      { question: "Strategy?", options: [{ label: "Preset" }, { label: "Custom" }] },
      { question: "Constraints?" },
    ],
  }, ctx);
  assert.deepEqual(calls, ["select", "input"]);
  assert.deepEqual(result.details.answers, [
    { question: "Strategy?", selected: ["Preset"] },
    { question: "Constraints?", selected: [], text: "Nearest region" },
  ]);
});
