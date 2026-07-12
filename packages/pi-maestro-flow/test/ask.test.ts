import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { executeAsk } from "../src/tools/ask.ts";

function createHarness() {
  let component: { render(width: number): string[] } | undefined;
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let placement: string | undefined;
  let cleared = false;
  let unsubscribed = false;
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
  const hostTui = { requestRender() {} };
  const ui = {
    setWidget(_key: string, content: unknown, options?: { placement?: string }) {
      if (content === undefined) {
        cleared = true;
        component = undefined;
        return;
      }
      placement = options?.placement;
      component = (content as (tui: typeof hostTui, theme: typeof theme) => typeof component)(hostTui, theme);
    },
    onTerminalInput(handler: typeof inputHandler) {
      inputHandler = handler;
      return () => { unsubscribed = true; };
    },
  };
  const ctx = { hasUI: true, ui } as unknown as ExtensionContext;
  return {
    ctx,
    get component() { return component; },
    get handler() { return inputHandler; },
    get placement() { return placement; },
    get cleared() { return cleared; },
    get unsubscribed() { return unsubscribed; },
  };
}

test("single select uses color-block selection, numeric shortcuts, default none, and skips submit", async () => {
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

  assert.equal(harness.placement, "aboveEditor");
  assert.ok(harness.component);
  assert.ok(harness.handler);

  for (const width of [12, 19, 20, 40, 80]) {
    const lines = harness.component.render(width);
    assert.ok(lines.length <= 10);
    assert.doesNotMatch(lines.join("\n"), /\[[ x]\]|✓/);
    if (width >= 40) assert.match(lines.join("\n"), /None of the above/);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }

  assert.equal(harness.handler("1")?.consume, true); // Select Preset directly.
  assert.match(harness.component.render(80).join("\n"), /Preset  selected/);
  assert.match(harness.component.render(80).join("\n"), /Add details \(press d to add\)/);
  harness.handler("d");
  harness.handler("Prefer the nearest region");
  harness.handler("\r"); // Save details without replacing the option.
  harness.handler("\r"); // Finish without a separate Next row.

  const result = await pending;
  assert.deepEqual(result.details.answers[0].selected, ["Preset"]);
  assert.equal(result.details.answers[0].text, "Prefer the nearest region");
  assert.equal(harness.cleared, true);
  assert.equal(harness.unsubscribed, true);
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
  assert.match(rendered, /None of the above/);
  harness.handler?.("3");
  harness.handler?.("1");
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
  const result = await pending;
  assert.deepEqual(result.details.answers[0].selected, ["None of the above"]);
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
  const preview = harness.component?.render(100).join("\n") ?? "";
  assert.match(preview, /First full question\?.*A/);
  assert.match(preview, /Second full question\?.*D/);
  harness.handler?.("\x1bOM");

  const result = await pending;
  assert.deepEqual(result.details.answers.map((answer) => answer.selected), [["A"], ["D"]]);
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /First full question\?/);
});
