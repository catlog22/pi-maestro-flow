import assert from "node:assert/strict";
import test from "node:test";
import {
  SelfEvolveOverlay,
  type SelfEvolveOverlayAction,
} from "../src/tui/self-evolve-overlay.ts";
import { DEFAULT_SELF_EVOLVE_CONFIG, type SelfEvolveConfig } from "../src/self-evolve/runtime.ts";

const theme = {
  fg(_role: string, text: string) { return text; },
  bold(text: string) { return text; },
} as never;

function makeView(config: SelfEvolveConfig = { ...DEFAULT_SELF_EVOLVE_CONFIG }) {
  return {
    source: "test",
    config,
    counters: {
      candidates: 0,
      staged: 0,
      promoted: 0,
      pruned: 0,
      conflicts: 0,
      superseded: 0,
      lastSignalAt: 0,
    } as never,
    recentSignals: [] as never,
    resolvedModel: "maestro-openai/gpt-5.6-sol",
    suggestionsDir: "/tmp/suggestions",
  };
}

test("self-evolve overlay opens a change confirmation on Ctrl+S and commits on Enter", async () => {
  const actions: SelfEvolveOverlayAction[] = [];
  const overlay = new SelfEvolveOverlay({
    view: makeView(),
    requestRender() {},
    close() {},
    onAction(action) { actions.push(action); },
    theme,
  } as never);

  // Toggle the master switch on (draft diverges from the snapshot).
  overlay.handleInput(" ");
  overlay.handleInput("\x13");
  const confirmed = overlay.render(80).join("\n");
  assert.match(confirmed, /Confirm save/);
  assert.match(confirmed, /enabled: off → on/);
  assert.match(confirmed, /Enter confirm save · Esc back/);
  // Enter commits the save.
  overlay.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "save");
  assert.equal((actions[0] as { config: SelfEvolveConfig }).config.enabled, true);
});

test("self-evolve overlay cancels the confirmation with Esc and does not persist", () => {
  const actions: SelfEvolveOverlayAction[] = [];
  const overlay = new SelfEvolveOverlay({
    view: makeView(),
    requestRender() {},
    close() {},
    onAction(action) { actions.push(action); },
    theme,
  } as never);

  overlay.handleInput(" ");
  overlay.handleInput("\x13");
  assert.match(overlay.render(80).join("\n"), /Confirm save/);
  overlay.handleInput("\x1b");
  assert.doesNotMatch(overlay.render(80).join("\n"), /Confirm save/);
  assert.equal(actions.length, 0);
});
