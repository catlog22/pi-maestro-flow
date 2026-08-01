import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showModelMappingOverlay, TeammateControlCenter } from "../src/tui/model-mapping-overlay.ts";
import { loadModelRoutingState } from "../src/models/model-routing.ts";

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
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved, []);
  assert.match(control.render(80).join("\n"), /Explore/);
});

test("compact editors keep persistence status visible from 20 through 39 columns", async () => {
  const saving = new TeammateControlCenter({
    cwd: "C:\\tmp\\project",
    availableModels: [{ id: "openai/gpt-5", reasoning: true, thinkingLevels: ["low"] }],
    agents: [],
    activeAgents: [],
    config: { version: 2, mappings: {}, thinkingLevels: {} },
    theme,
    requestRender: () => {},
    close: () => {},
    saveMapping: () => { throw new Error("read-only compact status"); },
  });
  saving.render(80);
  saving.handleInput("\r");
  saving.handleInput("\r");
  for (const width of [20, 24, 32, 39]) assert.match(saving.render(width).join("\n"), /Saving/);
  await new Promise((resolve) => setTimeout(resolve, 25));
  for (const width of [20, 24, 32, 39]) assert.match(saving.render(width).join("\n"), /Save failed/);
});

test("nested editor Escape returns one level even below 20 columns", () => {
  for (let width = 1; width < 20; width++) {
    const closed: unknown[] = [];
    const control = new TeammateControlCenter({
      cwd: "C:\\tmp\\project",
      availableModels: [{ id: "openai/gpt-5", reasoning: true, thinkingLevels: ["low"] }],
      agents: [],
      activeAgents: [],
      config: { version: 2, mappings: {}, thinkingLevels: {} },
      theme,
      requestRender: () => {},
      close: (value) => closed.push(value),
    });
    control.render(80);
    control.handleInput("\r");
    control.render(width);
    control.handleInput("\x1b");
    assert.deepEqual(closed, []);
    assert.doesNotMatch(control.render(80).join("\n"), /Esc back/);
  }
});

test("disposing an inline editor cancels a pending persistence callback", async () => {
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
  control.render(80);
  control.handleInput("\r");
  control.handleInput("\r");
  assert.match(control.render(80).join("\n"), /Saving/);
  control.dispose();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved, []);
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

test("control center resets selection after a narrowing paste filter", () => {
  const control = center();
  control.handleInput("\x1b[B");
  control.handleInput("\x1b[200~testing\x1b[201~");
  assert.match(control.render(80).join("\n"), /Testing/);
  control.handleInput("\r");
  assert.match(control.render(80).join("\n"), /Testing › Model/);
});

test("profile management creates and activates a global Profile without touching the real home config", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-profile-overlay-"));
  const cwd = path.join(root, "project");
  const globalFilePath = path.join(root, "home", "teammate-models.json");
  let overlays = 0;
  const notifications: string[] = [];
  const frames: string[] = [];
  const ctx = {
    cwd,
    ui: {
      custom(factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void; dispose?(): void }) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          const overlay = overlays++;
          if (overlay === 1) {
            assert.equal(fs.existsSync(globalFilePath), false, "persistence started before the Saving overlay rendered");
            setTimeout(() => frames.push(component.render(80).join("\n")), 0);
            return;
          }
          const frame = component.render(80).join("\n");
          frames.push(frame);
          if (overlay === 0) {
            component.handleInput("\x1b[9;2u");
            component.handleInput("\r");
          } else {
            component.dispose?.();
          }
        });
      },
      async select(_title: string, options: string[]) {
        return options.find((option) => option === "Create empty Profile");
      },
      async input() { return "Fast"; },
      async confirm() { return true; },
      notify(message: string) { notifications.push(message); },
    },
  } as never;
  try {
    await showModelMappingOverlay(ctx, [], { globalFilePath });
    const state = loadModelRoutingState(cwd, globalFilePath);
    assert.equal(state.config.profileId, "fast");
    assert.equal(state.global.profiles.fast.name, "Fast");
    assert.match(frames.join("\n"), /Saving · Creating Profile/);
    assert.match(frames.join("\n"), /Saved · Created and activated Fast/);
    assert.match(notifications.join("\n"), /Created and activated Fast/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile management keeps the workflow recoverable after a persistence failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-profile-overlay-"));
  const cwd = path.join(root, "project");
  const globalFilePath = path.join(root, "home", "teammate-models.json");
  fs.mkdirSync(path.dirname(globalFilePath), { recursive: true });
  fs.writeFileSync(globalFilePath, `${JSON.stringify({
    version: 3,
    defaultProfile: "beta",
    profiles: {
      alpha: { name: "Team Alpha", mappings: {}, thinkingLevels: {} },
      beta: { name: "Beta", mappings: {}, thinkingLevels: {} },
      charlie: { name: "Team Charlie", mappings: {}, thinkingLevels: {} },
      delta: { name: "Team Delta", mappings: {}, thinkingLevels: {} },
    },
  })}\n`);
  let overlays = 0;
  let selectCalls = 0;
  const notifications: string[] = [];
  const frames: string[] = [];
  const ctx = {
    cwd,
    ui: {
      custom(factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void; dispose?(): void }) {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          const overlay = overlays++;
          if (overlay === 1) {
            setTimeout(() => frames.push(component.render(80).join("\n")), 0);
            return;
          }
          const frame = component.render(80).join("\n");
          frames.push(frame);
          if (overlay === 0) {
            component.handleInput("\x1b[9;2u");
            component.handleInput("team");
            component.handleInput("\x1b[B");
            fs.rmSync(globalFilePath);
            fs.mkdirSync(globalFilePath);
            component.handleInput("\r");
          } else if (overlay === 2) {
            component.handleInput("\r");
          } else {
            component.dispose?.();
          }
        });
      },
      async select(_title: string, options: string[]) {
        selectCalls++;
        return options.find((option) => option === "Create empty Profile");
      },
      async input() { return "Will Fail"; },
      async confirm() { return true; },
      notify(message: string) { notifications.push(message); },
    },
  } as never;
  try {
    await showModelMappingOverlay(ctx, [], { globalFilePath });
    assert.equal(overlays, 4);
    assert.equal(selectCalls, 1, "stale read-only state reopened profile management");
    assert.match(frames.join("\n"), /Saving · Creating Profile/);
    assert.match(frames[2] ?? "", /Save failed/);
    assert.match(frames[2] ?? "", /team/);
    assert.match(frames[2] ?? "", /ID · charlie/);
    assert.match(frames[2] ?? "", /Enter retry load/);
    assert.match(notifications.join("\n"), /Save failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
