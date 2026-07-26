import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Alt+T delegates Todo disclosure to Cockpit when Cockpit owns the panel", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /pi\.events\.on\(COCKPIT_UI_OWNERSHIP_EVENT[\s\S]*?cockpitOwnsTodo = ownership\.todo === true/);
  assert.match(source, /if \(cockpitOwnsTodo\) \{[\s\S]*?setWidget\("todo-panel", undefined\)/);
  assert.match(
    source,
    /registerShortcut\(TODO_TOGGLE_KEY[\s\S]*?pi\.events\.emit\(COCKPIT_TODO_TOGGLE_EVENT, \{ expanded: panelMode === "expanded" \}\)/,
  );
});
