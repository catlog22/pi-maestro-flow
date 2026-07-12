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

test("single select uses an above-editor panel without checkboxes and keeps additional details", async () => {
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
    assert.doesNotMatch(lines.join("\n"), /\[[ x]\]/);
    if (width >= 20) assert.match(lines.join("\n"), /Add details/);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }

  assert.equal(harness.handler("\r")?.consume, true); // Select Preset.
  harness.handler("\x1b[B");
  harness.handler("\x1b[B");
  harness.handler("\x1b[B");
  harness.handler("\r"); // Open Add details.
  harness.handler("Prefer the nearest region");
  harness.handler("\r"); // Save details without replacing the option.
  harness.handler("\x1b[A");
  harness.handler("\r"); // Next.
  harness.handler("\r"); // Submit.

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

  assert.match(harness.component?.render(60).join("\n") ?? "", /\[ \]/);
  harness.handler?.("\x1b");
  const result = await pending;
  assert.equal(result.details.cancelled, true);
});
