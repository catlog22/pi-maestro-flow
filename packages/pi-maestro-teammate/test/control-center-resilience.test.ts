import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showModelMappingOverlay, TeammateControlCenter } from "../src/tui/model-mapping-overlay.ts";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

function center() {
  return new TeammateControlCenter({
    cwd: "C:\\tmp\\project",
    availableModels: [{ id: "openai/gpt-5", reasoning: true, thinkingLevels: ["low", "high"] }],
    agents: [],
    activeAgents: [],
    config: { version: 2, mappings: {}, thinkingLevels: {} },
    theme,
    requestRender: () => {},
    close: () => {},
  });
}

test("control center keeps recovery and the active option visible in compact modes", () => {
  const control = center();
  const main = control.render(18);
  assert.match(main.join("\n"), /Esc/);
  assert.ok(main.every((line) => visibleWidth(line) <= 18));
  control.handleInput("\r");
  assert.doesNotMatch(control.render(32).join("\n"), /Esc back/);
  control.handleInput("\r");
  const editor = control.render(32);
  assert.match(editor.join("\n"), /Esc back/);
  assert.match(editor.join("\n"), /auto|openai/);
});

test("control center blocks hidden filtering and saving below 20 columns", async () => {
  const saved: unknown[] = [];
  const control = new TeammateControlCenter({
    cwd: "C:\\tmp\\project",
    availableModels: [{ id: "openai/gpt-5", reasoning: true, thinkingLevels: ["low"] }],
    agents: [],
    activeAgents: [],
    config: { version: 2, mappings: {}, thinkingLevels: {} },
    theme,
    requestRender: () => {},
    close: () => {},
    saveMapping: (...args) => saved.push(args),
  });
  for (let width = 1; width < 20; width++) {
    control.render(width);
    control.handleInput("hidden");
    control.handleInput("\r");
    control.handleInput("\r");
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, []);
  assert.match(control.render(80).join("\n"), /Explore/);
});

test("control center decodes split paste markers and backspaces by grapheme", () => {
  const control = center();
  control.handleInput("\x1b[20");
  control.handleInput("0~👨‍👩‍👧‍👦\x1b[20");
  control.handleInput("1~");
  assert.match(control.render(80).join("\n"), /No matches/);
  control.handleInput("\x7f");
  assert.match(control.render(80).join("\n"), /Explore/);
});

test("host-driven control center disposal settles the custom overlay", async () => {
  let disposed = false;
  const ctx = {
    cwd: "C:\\tmp\\project",
    ui: {
      custom(factory: (...args: unknown[]) => { render(width: number): string[]; dispose?(): void }) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          component.render(80);
          component.dispose?.();
          disposed = true;
        });
      },
    },
  } as never;
  await showModelMappingOverlay(ctx, [{ id: "openai/gpt-5", reasoning: true, thinkingLevels: ["low"] }]);
  assert.equal(disposed, true);
});
